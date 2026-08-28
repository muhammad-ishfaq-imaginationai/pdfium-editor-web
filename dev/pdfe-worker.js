// worker.js — the ONE dedicated worker that owns editor.wasm (docs/WEB_VIEWER.md §2).
// The main thread never calls into wasm; this worker owns the module, the heap,
// every pdfe_* call, and (after a one-time transferControlToOffscreen) draws
// pages directly onto the transferred OffscreenCanvases.
//
// Step 7 scope (docs/WEB_VIEWER.md §5, §9): tiled page painting — an instant
// low-res base layer plus async 768px sharp tiles (2.5px seam overlap) filled
// through the single-flight latch — and the latch itself (newest-wins edit
// slot + tile queue). The engine edit pass is STUBBED until the edit-session
// ABI lands (core Steps 3–4); the keystroke pipe and its coalescing are real.

// SDK packaging (docs/EDITOR_SDK.md): the engine's location is NOT hardcoded any
// more — a host may put editor.js/editor.wasm anywhere (an app bundle, a CDN, the
// repo's wasm/dist during development). PdfeEditor passes it as `?engine=<url>`
// on the worker URL, which is readable synchronously here, before importScripts.
// Default = next to this worker (the flat dist-sdk layout).
const ENGINE_URL = new URL(
  new URLSearchParams(self.location.search).get("engine") || "./editor.js",
  self.location.href
).href;
importScripts(ENGINE_URL); // classic worker: defines createPdfe

const PDFE_RENDER_RGBA = 0x1;

const TILE = 768;      // §5: square tiles, 768 device px
const TILE_OVERLAP = 3; // §5: ~2.5px seam overlap, rounded up to whole pixels
const BASE_MAX = 384;  // base layer: longest page side in device px (cheap + instant)

let mod = null;
const F = {};
let doc = 0;
const pages = [];              // [{w, h}] PDF points
const pageHandles = new Map(); // pageIndex -> PDFE_PAGE (LRU: insertion order == age)
const textPages = new Map();   // pageIndex -> PDFE_TEXTPAGE (grouping + edit begin)
const canvases = new Map();    // pageIndex -> OffscreenCanvas
const paintGen = new Map();    // pageIndex -> generation (stale tile jobs drop)
const pageScale = new Map();   // pageIndex -> device px per PDF point (last paint)

// Page/text-page LRU (the PdfSession.openPages MAX_OPEN=8 analog — 7000-page
// documents made the "no LRU yet" skeleton a real leak: every page ever
// scrolled past kept its parsed object graph in the wasm heap forever). The
// edit page and DIRTY pages are never evicted: closing a page with un-flushed
// preview edits (pdfe_generate_content not run yet) would drop those edits.
const MAX_OPEN_PAGES = 16;

// ---- the live edit session (pdfe_edit_*; core Step 4) -------------------------
// One live session per document. The worker owns it outright — this queue IS
// the serializer (docs/CORE_API.md §6). The session adopts the page's text
// page; we re-sync our handle after every mutating call.
let editor = 0;
let editPage = -1;
let editParaBounds = null;     // [l,b,r,t] page pts of the open paragraph (tap routing)
// SELECT-THEN-ACT (user decision 2026-07-29). A tap in edit mode no longer drops
// straight into typing: it SELECTS the paragraph and the shell offers Edit /
// Delete. Only the Edit action (or a second tap on the same box) opens the
// editor. The selection lives HERE, next to the rest of the tap routing, so the
// shell stays a renderer of state it is told about — and so Android and web can
// behave identically without duplicating the decision logic.
let selectedPara = null;       // {page, index, bounds, xPt, yPt} | null
// Pages with in-memory edits not yet flushed into their content stream —
// pdfe_save does NOT flush; we run pdfe_generate_content on these first
// (the PdfSession.dirtyPages analog). Commit flushes its page in the core.
const dirtyPages = new Set();

// ---- the per-page grouping cache (the PdfSession.fetchGroups analog) ----------
// pdfe.h is explicit: the core caches ONE page's grouping at a time and "the
// host's per-page cache stays the real cache". Android has one; the worker did
// not — so every tap/deselect/delete re-ran a full pdfe_group_page (~150-230 ms
// on dense pages), which is exactly the click delay large documents showed.
// Bounds in this cache stay valid until THAT page's objects mutate, so
// hit-tests (select / deselect) are pure JS lookups. The fresh-open gate
// (groupGen == mutGen && same page, see core/src/internal.h) is tracked with
// coreGroupedPage/coreGroupFresh: pdfe_edit_begin_ex only needs a re-group when
// the core's single-slot cache holds another page or a mutation intervened.
// Entries are BLOCKS (the boxes the user sees and taps), each carrying its member
// PARAGRAPHS (the edit units, with the core paragraph index the editor takes):
//   pageIndex -> [{ index, bounds:[l,b,r,t], paras:[{index, bounds}] }]
const groupCache = new Map();
// THE PAGE'S PICTURES, cached the same way and for the same reason (a tap must
// not cost a core call). A SEPARATE map, mirroring the core's separate list —
// see docs/IMAGE_EDIT.md §3. Same lifetime as groupCache: filled by groupPage,
// dropped by noteMutation, evicted with it.
//   pageIndex -> [{ index, bounds:[l,b,r,t], quad:[x1,y1..x4,y4], turns, flags }]
const imageCache = new Map();
const MAX_GROUP_CACHE = 300;      // bounds are tiny; this only caps pathology
let coreGroupedPage = -1;         // page the CORE's one-slot grouping holds
let coreGroupFresh = false;       // no object mutation since that grouping
// Pooled render buffer per docs/WEB_VIEWER.md §10 (FPDFBitmap_CreateEx external
// buffers are caller-owned; pooling also avoids per-render heap growth).
let pool = { ptr: 0, size: 0 };

// locateFile: the Emscripten glue resolves editor.wasm relative to the WORKER's
// URL, not the glue's — point it back at whatever directory the glue came from
// (ENGINE_URL above), so editor.wasm is always fetched next to editor.js.
// Any ?v= cache-buster on the glue URL is carried over to the wasm URL too.
const ready = createPdfe({
  locateFile: (f) => {
    const u = new URL(f, ENGINE_URL);
    u.search = new URL(ENGINE_URL).search;
    return u.href;
  },
}).then((m) => {
  mod = m;
  F.init         = m.cwrap("pdfe_init", "number", ["number"]);
  F.openMem      = m.cwrap("pdfe_open_mem", "number", ["number", "number", "number"]);
  F.openMemOwned = m.cwrap("pdfe_open_mem_owned", "number", ["number", "number", "number"]);
  F.openCustom   = m.cwrap("pdfe_wasm_open_custom", "number", ["number", "number"]);
  F.lastOpenError = m.cwrap("pdfe_last_open_error", "number", []);
  F.closeDoc     = m.cwrap("pdfe_close_doc", null, ["number"]);
  F.pageCount    = m.cwrap("pdfe_page_count", "number", ["number"]);
  F.loadPage     = m.cwrap("pdfe_load_page", "number", ["number", "number"]);
  F.closePage    = m.cwrap("pdfe_close_page", null, ["number"]);
  F.pageSize     = m.cwrap("pdfe_page_size", "number", ["number", "number", "number"]);
  F.pageSizeAt   = m.cwrap("pdfe_page_size_at", "number",
    ["number", "number", "number", "number"]);
  F.render       = m.cwrap("pdfe_render", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.renderRegion = m.cwrap("pdfe_render_region", "number",
    ["number", "number", "number", "number", "number", "number", "number", "number", "number"]);
  F.loadTextPage  = m.cwrap("pdfe_load_text_page", "number", ["number"]);
  F.closeTextPage = m.cwrap("pdfe_close_text_page", null, ["number"]);
  F.group         = m.cwrap("pdfe_group_page", "number", ["number", "number", "number"]);
  F.paraInfo      = m.cwrap("pdfe_para_info", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.blockCount    = m.cwrap("pdfe_block_count", "number", ["number"]);
  F.blockInfo     = m.cwrap("pdfe_block_info", "number",
    ["number", "number", "number", "number", "number"]);
  F.moveBlock     = m.cwrap("pdfe_move_block", "number",
    ["number", "number", "number", "number", "number", "number"]);
  // IMAGE EDIT (docs/IMAGE_EDIT.md)
  F.imageCount    = m.cwrap("pdfe_image_count", "number", ["number"]);
  F.imageInfo     = m.cwrap("pdfe_image_info", "number",
    ["number", "number", "number", "number", "number", "number", "number"]);
  F.moveImage     = m.cwrap("pdfe_move_image", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.imageMoveLimits = m.cwrap("pdfe_image_move_limits", "number",
    ["number", "number", "number", "number"]);
  F.rotateImage   = m.cwrap("pdfe_rotate_image", "number",
    ["number", "number", "number", "number", "number"]);
  F.deleteImage   = m.cwrap("pdfe_delete_image", "number",
    ["number", "number", "number", "number"]);
  F.blockMoveLimits = m.cwrap("pdfe_block_move_limits", "number",
    ["number", "number", "number", "number"]);
  // Undo/redo. The journal lives in the CORE (docs/UNDO_REDO.md) — this shell
  // only asks which page a step belongs to, calls it, and repaints.
  F.undoPage      = m.cwrap("pdfe_undo_page", "number", ["number"]);
  F.redoPage      = m.cwrap("pdfe_redo_page", "number", ["number"]);
  F.undo          = m.cwrap("pdfe_undo", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.redo          = m.cwrap("pdfe_redo", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.historyClear  = m.cwrap("pdfe_history_clear", null, ["number"]);
  // Phase 5: seal the newest entry so later keystrokes start a fresh one. The
  // core is clockless; the ~300 ms idle rule lives in the SDK's debounce.
  F.historySeal   = m.cwrap("pdfe_history_seal", null, ["number"]);
  F.historySetEnabled = m.cwrap("pdfe_history_set_enabled", null, ["number", "number"]);
  // Asked, never assumed: the SDK clears its unsaved-changes flag from an empty
  // undo stack, and that inference is only valid while recording is ON.
  F.historyEnabled = m.cwrap("pdfe_history_enabled", "number", ["number"]);
  F.historyDescribe = m.cwrap("pdfe_history_describe", "number",
    ["number", "number", "number"]);
  F.editCaretIndex = m.cwrap("pdfe_edit_caret_index", "number", ["number"]);
  F.editLastRejected = m.cwrap("pdfe_edit_last_rejected", "number",
    ["number", "number", "number"]);
  F.deleteBlock   = m.cwrap("pdfe_delete_block", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.editBegin     = m.cwrap("pdfe_edit_begin", "number",
    ["number", "number", "number", "number"]);
  F.editBeginEx   = m.cwrap("pdfe_edit_begin_ex", "number",
    ["number", "number", "number", "number", "number"]);
  F.editBeginNew  = m.cwrap("pdfe_edit_begin_new", "number",
                            ["number", "number", "number", "number"]);
  F.editBeginBlock = m.cwrap("pdfe_edit_begin_block", "number",
    ["number", "number", "number", "number", "number"]);
  F.editLineMode  = m.cwrap("pdfe_edit_line_mode", "number", ["number"]);
  F.editTextPage  = m.cwrap("pdfe_edit_text_page", "number", ["number"]);
  F.editIsPara    = m.cwrap("pdfe_edit_is_paragraph", "number", ["number"]);
  F.editText      = m.cwrap("pdfe_edit_text", "number", ["number", "number", "number"]);
  F.editSetText   = m.cwrap("pdfe_edit_set_text", "number",
    ["number", "number", "number", "number", "number"]);
  F.editCaret     = m.cwrap("pdfe_edit_caret", "number", ["number", "number", "number"]);
  F.editBoundary  = m.cwrap("pdfe_edit_boundary_at", "number", ["number", "number", "number"]);
  F.editSelRects  = m.cwrap("pdfe_edit_selection_rects", "number",
    ["number", "number", "number", "number", "number"]);
  // character-level styling: colour, the font FAMILY + bold/italic (2026-08-13), and
  // the font SIZE (2026-08-18). Size needed no new reader — pdfe_edit_style_at has
  // reported out[4] since colour shipped, which is why readRangeStyle already carried
  // `sizePt` before anything could set it (docs/FONT_SIZING.md).
  F.editApplyColor = m.cwrap("pdfe_edit_apply_color", "number",
    ["number", "number", "number", "number", "number"]);
  F.editApplySize = m.cwrap("pdfe_edit_apply_size", "number",
    ["number", "number", "number", "number", "number"]);
  F.editSetTypingSize = m.cwrap("pdfe_edit_set_typing_size", "number",
    ["number", "number", "number"]);
  F.editSetTypingColor = m.cwrap("pdfe_edit_set_typing_color", "number",
    ["number", "number", "number"]);
  F.editStyleAt   = m.cwrap("pdfe_edit_style_at", "number",
    ["number", "number", "number", "number", "number"]);
  F.editFontNameAt = m.cwrap("pdfe_edit_font_name_at", "number",
    ["number", "number", "number", "number", "number", "number"]);
  F.editApplyFont = m.cwrap("pdfe_edit_apply_font", "number",
    ["number", "number", "number", "number", "number"]);
  F.editSetTypingFont = m.cwrap("pdfe_edit_set_typing_font", "number",
    ["number", "number"]);
  F.editApplyFace = m.cwrap("pdfe_edit_apply_face", "number",
    ["number", "number", "number", "number", "number", "number"]);
  // The DELIVERY half: a host hands us bytes (or a standard-14 name) and we intern
  // the face on the DOCUMENT, then register it so apply_face can find it. Web had
  // no font delivery story at all before this — that, not the plumbing, was why
  // applyFont was Android-only (docs/FONTS.md §2).
  F.loadAssetFont = m.cwrap("pdfe_load_asset_font", "number",
    ["number", "number", "number", "number"]);
  F.loadStandardFont = m.cwrap("pdfe_load_standard_font", "number", ["number", "number"]);
  F.registerFace  = m.cwrap("pdfe_register_face", "number", ["number", "number"]);
  F.editCommit    = m.cwrap("pdfe_edit_commit", "number", ["number", "number"]);
  // DOCUMENT REFLOW (docs/DOCUMENT_REFLOW.md). The public name on this surface is
  // `documentReflow`, never "reflow" — that word already means the LINE-mode wrap
  // inside a paragraph, and two meanings for one word in one API is a support ticket.
  F.flowEnable    = m.cwrap("pdfe_flow_enable", "number", ["number", "number"]);
  F.flowSettle    = m.cwrap("pdfe_flow_settle", "number", ["number", "number", "number", "number"]);
  F.flowRefresh   = m.cwrap("pdfe_flow_refresh_page", "number", ["number", "number", "number"]);
  F.flowFrame     = m.cwrap("pdfe_flow_page_frame", "number", ["number", "number", "number"]);
  F.flowUndo      = m.cwrap("pdfe_flow_undo", "number", ["number", "number", "number"]);
  F.flowUndoPage  = m.cwrap("pdfe_flow_undo_page", "number", ["number"]);
  F.flowCanUndo   = m.cwrap("pdfe_flow_can_undo", "number", ["number"]);
  F.flowRedo      = m.cwrap("pdfe_flow_redo", "number", ["number", "number", "number"]);
  F.flowRedoPage  = m.cwrap("pdfe_flow_redo_page", "number", ["number"]);
  F.flowCanRedo   = m.cwrap("pdfe_flow_can_redo", "number", ["number"]);
  F.pageAdopt     = m.cwrap("pdfe_page_adopt", "number", ["number", "number", "number"]);
  F.editCancel    = m.cwrap("pdfe_edit_cancel", "number", ["number"]);
  F.generateContent = m.cwrap("pdfe_generate_content", "number", ["number"]);
  F.wasmSave      = m.cwrap("pdfe_wasm_save", "number", ["number"]);
  F.init(0);
  // Probe the save sink BEFORE announcing readiness: the shell must know up
  // front whether saves will stream (OPFS) or fall back to in-heap, because
  // that changes what it is allowed to offer the user (§7).
  probeOpfs().then((ok) => {
    opfsOk = ok;
    postMessage({ type: "ready", opfs: ok, inHeapMaxMB: IN_HEAP_MAX / (1024 * 1024) });
  });
});

// Close a page's handles in the required order: text page first, then page.
function closePageHandles(i) {
  const tp = textPages.get(i);
  if (tp) { F.closeTextPage(tp); textPages.delete(i); }
  const p = pageHandles.get(i);
  // NOTHING TO UN-ADOPT: pdfe_close_page drops any adopted registry entry naming this
  // handle, refcount or not — the handle is going away, so an entry pointing at it must go
  // with it, which is exactly the stale view adoption exists to prevent.
  if (p) { F.closePage(p); pageHandles.delete(i); }
}

function acquirePage(i) {
  let p = pageHandles.get(i);
  if (p) { pageHandles.delete(i); pageHandles.set(i, p); return p; } // LRU touch
  p = F.loadPage(doc, i);
  pageHandles.set(i, p);
  // ADOPT IT INTO THE CORE'S PAGE REGISTRY, so the flow layer resolves this index to THIS
  // handle instead of opening a second view of the page. pdfe_load_page does not cache, and
  // two views of one page are two independent object lists — the measured 3600-vs-3578
  // divergence, and the direct cause of three separate flow bugs (the cascade stopping at
  // its first destination, an undo restoring onto a view nobody was watching, and a page
  // that could not be deleted). Adoption makes those unconstructible rather than guarded
  // against. Dropped again by closePageHandles below; harmless when flow is off.
  if (p && F.pageAdopt) F.pageAdopt(doc, i, p);
  // LRU backstop: evict the oldest evictable handle. Queued tile/paint jobs
  // for an evicted page just re-acquire it — a reload cost, never a bug.
  if (pageHandles.size > MAX_OPEN_PAGES) {
    for (const k of pageHandles.keys()) {
      if (k === i || k === editPage || dirtyPages.has(k)) continue;
      closePageHandles(k);
      break;
    }
  }
  return p;
}

function poolBuf(bytes) {
  if (pool.size < bytes) {
    if (pool.ptr) mod._free(pool.ptr);
    pool = { ptr: mod._malloc(bytes), size: bytes };
  }
  return pool.ptr;
}

// Render a device-pixel region of |page| and put it onto |ctx| at (dx, dy).
// Heap view is re-derived AFTER the wasm call — views detach on heap growth
// (docs/WEB_VIEWER.md §10); zero-copy ImageData is legal because the build is
// single-threaded (plain ArrayBuffer heap).
function blitRegion(ctx, pageHandle, scale, x, y, w, h) {
  const ptr = poolBuf(w * h * 4);
  F.renderRegion(pageHandle, ptr, w, h, w * 4, scale, x, y, PDFE_RENDER_RGBA);
  const view = new Uint8ClampedArray(mod.HEAPU8.buffer, ptr, w * h * 4);
  ctx.putImageData(new ImageData(view, w, h), x, y);
}

// ---- edit-session helpers ------------------------------------------------------

function textPageOf(i) {
  let tp = textPages.get(i);
  if (!tp) { tp = F.loadTextPage(acquirePage(i)); textPages.set(i, tp); }
  return tp;
}

// The session adopts (and may internally reload) the text page — re-sync ours.
function syncEditTextPage() {
  if (!editor) return;
  const tp = F.editTextPage(editor);
  if (tp) textPages.set(editPage, tp);
}

function readF32(ptr, n) {
  return Array.from(new Float32Array(mod.HEAPU8.buffer, ptr, n));
}

function withU16(str, fn) {
  const ptr = mod._malloc((str.length + 1) * 2);
  const v = new Uint16Array(mod.HEAPU8.buffer, ptr, str.length + 1);
  for (let i = 0; i < str.length; i++) v[i] = str.charCodeAt(i);
  v[str.length] = 0;
  const r = fn(ptr);
  mod._free(ptr);
  return r;
}

// The password seam: pdfe.h specifies UTF-8 for names/passwords (UTF-16 is for
// document text only), and a null pointer means "no password" — the default. The
// bytes are freed the moment the open returns; a password is never retained in
// the heap, and the worker keeps no copy of it either.
function withUtf8(str, fn) {
  if (str === null || str === undefined || str === "") return fn(0);
  const bytes = new TextEncoder().encode(str);
  const ptr = mod._malloc(bytes.length + 1);
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  try { return fn(ptr); }
  finally { mod.HEAPU8.fill(0, ptr, ptr + bytes.length); mod._free(ptr); }
}

// PDFE_OPEN_* (pdfe.h) → the SDK error codes the host switches on. The core
// already made the required-vs-wrong call, so this is a pure rename.
function openErrorCode(err) {
  if (err === 100) return "password-required";  // PDFE_OPEN_ERR_PASSWORD_REQUIRED
  if (err === 4) return "password-wrong";       // PDFE_OPEN_ERR_PASSWORD
  return "open-failed";
}

function readEditorText() {
  const n = F.editText(editor, 0, 0);
  if (n <= 0) return "";
  const ptr = mod._malloc(n * 2);
  F.editText(editor, ptr, n);
  const v = new Uint16Array(mod.HEAPU8.buffer, ptr, n); // re-derived post-call (§10)
  const s = String.fromCharCode(...v);
  mod._free(ptr);
  return s;
}

// The characters the last set_text REFUSED (I69) — "" when it accepted everything,
// which is the overwhelmingly common case, so this is one cheap call per keystroke.
function readLastRejected() {
  const n = F.editLastRejected(editor, 0, 0);
  if (n <= 0) return "";
  const ptr = mod._malloc(n * 2);
  F.editLastRejected(editor, ptr, n);
  const v = new Uint16Array(mod.HEAPU8.buffer, ptr, n);  // re-derived post-call (§10)
  const s = String.fromCharCode(...v);
  mod._free(ptr);
  return s;
}

function readCaret(index) {
  const ptr = mod._malloc(12);
  const ok = F.editCaret(editor, index, ptr);
  const v = ok ? readF32(ptr, 3) : null;
  mod._free(ptr);
  return v; // [x, topPt, botPt] page points
}

// The style of characters [s, e) as the CORE reports it. A NULL field means MIXED
// across the range — never a guessed value, because a swatch showing one of several
// colours makes the user's next click overwrite text they never looked at.
// A collapsed range (e <= s) reads the character BEFORE the cursor, which is the
// same inherit-from-the-left rule a typed character follows.
const PDFE_STYLE_COLOR = 1, PDFE_STYLE_SIZE = 2, PDFE_STYLE_BASELINE = 8;
// The FONT-IDENTITY bits (pdfe.h, 2026-08-13). FAMILY is separate from FONT on
// purpose: one family can be carried by several subset handles, and a picker must
// still be able to show its name.
const PDFE_STYLE_FAMILY = 16, PDFE_STYLE_BOLD = 32, PDFE_STYLE_ITALIC = 64,
      PDFE_STYLE_FACES = 128, PDFE_STYLE_FACE_SRC = 256;
const CAN_BOLD_ON = 1, CAN_BOLD_OFF = 2, CAN_ITALIC_ON = 4, CAN_ITALIC_OFF = 8;
// …and, since 2026-08-18, the two questions a MIXED range asks. ALL_* is the toggle's
// pressed state measured over the fonts that CAN carry the property (so one symbolic
// bullet cannot jam the button); PART_* says the press will not reach everything.
const ALL_BOLD = 16, ALL_ITALIC = 32, PART_BOLD = 64, PART_ITALIC = 128;
// pdfe_edit_apply_face's positive non-apply: a bare caret armed the face for what is
// typed next, and the page is untouched.
const PDFE_FACE_ARMED = 2;
// …and its positive PARTIAL apply: some runs took the face, some had none. Unlike an
// arm this IS an edit — it dirtied and journalled — so it must set the document dirty.
const PDFE_FACE_APPLIED_PARTIAL = 3;
const FONT_NAME_BASE = 0, FONT_NAME_FAMILY = 1;

// The range's font name, or null when it MIXES. Two-call, like every core string
// getter; the core decides mixedness (one walk, shared with the mask) so this cannot
// disagree with the bits above.
function readFontName(s, e, which) {
  const n = F.editFontNameAt(editor, s, e, which, 0, 0);
  if (n <= 0) return null;
  const ptr = mod._malloc(n);
  F.editFontNameAt(editor, s, e, which, ptr, n);
  const bytes = new Uint8Array(mod.HEAPU8.buffer, ptr, n - 1).slice();  // drop the NUL
  mod._free(ptr);
  return new TextDecoder().decode(bytes);
}

// ---- THE ONE CANONICAL FONT SET (docs/FONTS.md §2bis) -----------------------
//
// The same 6 families x 4 faces the AAR ships, fetched from `fonts/` next to this worker
// and registered on the open document. It is registered AUTOMATICALLY rather than on
// request, and that is a parity decision: which faces are registered decides which face a
// bold/italic apply resolves to, and that answer lands in SAVED BYTES — so "the host
// forgot to call prepareFonts" must not be a way for the same document to edit differently
// on web than on Android.
//
// Default location is `./fonts/` RELATIVE TO THIS WORKER, which is the npm layout by
// construction: the worker ships at dist/assets/pdfe-worker.js, so the set lands at
// dist/assets/fonts/. A host on a different layout passes `fontsUrl` to open().
let fontsBaseUrl = null;
let bundledFonts = { state: "none", families: [], failed: [] };   // none|loading|ready

async function registerBundledFonts() {
  if (!doc || bundledFonts.state === "loading") return;
  bundledFonts = { state: "loading", families: [], failed: [] };
  const base = new URL(fontsBaseUrl || "./fonts/", self.location.href);
  const docAtStart = doc;
  try {
    const man = await (await fetch(new URL("manifest.json", base))).json();
    const families = [], failed = [];
    for (const fam of man.families || []) {
      let n = 0;
      // The family's REGULAR face name, which is what a host passes to applyFont(): the
      // picker offers a family, but applyFont takes a registered face, and B/I then reach
      // the rest of the ladder. faces[0] is Regular by the manifest's own ordering.
      const regular = (fam.faces && fam.faces[0] && fam.faces[0].file || "")
        .replace(/\.ttf$/, "");
      for (const face of fam.faces || []) {
        // The document may have closed under us mid-fetch; a handle registered onto a
        // freed doc is a use-after-free, so bail rather than press on.
        if (doc !== docAtStart) return;
        try {
          const buf = await (await fetch(new URL(face.file, base))).arrayBuffer();
          const src = new Uint8Array(buf);
          const bp = mod._malloc(src.length);
          mod.HEAPU8.set(src, bp);
          // The cache key is the FACE name — the filename without .ttf — which is the
          // same string Android uses, so both platforms key the per-document cache alike.
          const name = face.file.replace(/\.ttf$/, "");
          const h = withUtf8(name, (np) => F.loadAssetFont(doc, np, bp, src.length));
          mod._free(bp);
          if (h) { fontHandles.set(name, h); F.registerFace(doc, h); n++; }
          else failed.push(face.file);
        } catch { failed.push(face.file); }
      }
      if (n) families.push({ key: fam.key, label: fam.label, faces: n, regular });
    }
    bundledFonts = { state: "ready", families, failed };
  } catch (e) {
    // No manifest / no network: the SDK simply offers no bundled families. Everything
    // else still works, and the standard-14 substitution rungs are built into the engine
    // so Arial/Times/Courier bold-italic are unaffected.
    bundledFonts = { state: "ready", families: [], failed: ["manifest.json"] };
  }
  postMessage({
    type: "fontsReady",
    families: bundledFonts.families,
    failed: bundledFonts.failed,
  });
  // The faces that just landed change which B/I buttons are available, and the host was
  // told the old answer before the fetch finished. The main thread re-reads the style off
  // `fontsReady` — it owns the sink and therefore the selection, which this side does not
  // track (every style request arrives carrying its own start/end).
}

function readRangeStyle(s, e) {
  if (!editor) return null;
  const ptr = mod._malloc(12 * 4);
  const mask = F.editStyleAt(editor, s, e, ptr, 0);
  const v = readF32(ptr, 12);
  mod._free(ptr);
  if (mask < 0) return null;
  const argb = (mask & PDFE_STYLE_COLOR)
    ? (((Math.round(v[3]) << 24) | (Math.round(v[0]) << 16) |
        (Math.round(v[1]) << 8) | Math.round(v[2])) >>> 0)
    : null;
  const bold = (mask & PDFE_STYLE_BOLD) ? v[8] === 1 : null;
  const italic = (mask & PDFE_STYLE_ITALIC) ? v[9] === 1 : null;
  const faces = (mask & PDFE_STYLE_FACES) ? v[10] : 0;
  const subs = (mask & PDFE_STYLE_FACE_SRC) ? v[11] : 0;
  // Which toggle would be served by ANOTHER family's face, folded the same way
  // canBold/canItalic are — "press B" resolved into on-or-off — so the two answers
  // cannot disagree about which direction the button is pointing.
  // THE PRESSED STATE the two toggles paint, and the direction every fold below takes.
  // Reading it from the core rather than deriving it here is deliberate: which fonts
  // count as "capable" is a face-resolution question, and letting three shells answer
  // it separately is exactly how two platforms end up saving different documents.
  const pressedB = bold === null ? !!(faces & ALL_BOLD) : bold;
  const pressedI = italic === null ? !!(faces & ALL_ITALIC) : italic;
  const wouldSub = (isOn, onBit, offBit) => !!(subs & (isOn ? offBit : onBit));
  return {
    start: s, end: e,
    colorArgb: argb,
    sizePt: (mask & PDFE_STYLE_SIZE) ? v[4] : null,
    baselineOffset: (mask & PDFE_STYLE_BASELINE) ? v[7] : null,
    // The font under the cursor, as a host's picker asks for it: a DISPLAY name and
    // a MATCHING key. null = MIXED across the range, exactly like colour and size.
    fontName: readFontName(s, e, FONT_NAME_BASE),
    fontFamily: (mask & PDFE_STYLE_FAMILY) ? readFontName(s, e, FONT_NAME_FAMILY) : null,
    bold, italic,
    // THE BUTTON'S PRESSED STATE, which is not `bold`. `bold` goes null on a mix and
    // stays that way after a partial apply, so a host that painted from it would send
    // "on" twice and the toggle would never come back off. This never returns null: for
    // a uniform range it IS `bold`, and for a mix it is "every font that CAN be bold
    // already is" (docs/FONTS.md §3ter).
    boldPressed: pressedB,
    italicPressed: pressedI,
    // WHETHER THE B / I BUTTON WOULD DO ANYTHING — a different question from whether
    // the text IS bold, since the family may simply have no bold face and this build
    // REFUSES rather than faking one (docs/FONTS.md §3). Resolving "press B" into
    // "turn it on or off" stays the shell's job, so a host binds `disabled` straight
    // to these instead of decoding out[10] itself. Folded off the PRESSED state rather
    // than off `bold`: the same expression as before for a uniform range, and the only
    // one that has an answer for a mixed one (widened 2026-08-18 — a mixed range used
    // to report false here because the core refused it).
    canBold: !!(faces & (pressedB ? CAN_BOLD_OFF : CAN_BOLD_ON)),
    canItalic: !!(faces & (pressedI ? CAN_ITALIC_OFF : CAN_ITALIC_ON)),
    // AND WHETHER PRESSING IT WOULD CHANGE THE TYPEFACE. The family may have no such
    // face, in which case a metric-compatible sibling family serves it (Arial's bold
    // italic comes from Helvetica's). The face is always REAL — never a synthetic
    // slant or weight — but it is not the author's font, so a host that shows this is
    // being honest and one that ignores it is not (docs/FONTS.md §3).
    boldWouldSubstitute: wouldSub(pressedB, CAN_BOLD_ON, CAN_BOLD_OFF),
    italicWouldSubstitute: wouldSub(pressedI, CAN_ITALIC_ON, CAN_ITALIC_OFF),
    // AND WHETHER THE PRESS WILL REACH EVERYTHING. False for every uniform range, so a
    // host that ignores it sees no change on the documents it already handled. Where it
    // is true, pressing applies to the characters it can and leaves the rest exactly as
    // they are — the user chose that over refusing the whole selection because one
    // symbolic bullet cannot be bolded (2026-08-18).
    boldPartial: !!(faces & PART_BOLD),
    italicPartial: !!(faces & PART_ITALIC),
  };
}

// THE CARET MOVED DELIBERATELY — a tap inside the run, an arrow key, a caret-handle
// drag, a selection collapsing. Every such site goes through here and NO typing site
// does, which is the whole point: the core cannot tell a tap from a keystroke (both
// arrive as a new caret), so this function IS the distinction the core's contract
// asks the shell to make (pdfe.h, pdfe_edit_set_typing_color).
//
// Two things ride on it:
//  - the style AT the caret goes out with the message, so a host can repaint its
//    swatch to the colour the next character will actually take;
//  - when `typingColorFollowsCaret` is on, a pending typing-colour override is
//    DROPPED, so typing after the move inherits from the character to the left
//    instead of the colour picked before the move.
let typingColorFollowsCaret = true;
// WHERE the pending override was ARMED (caret index at pick time; -1 = none),
// and with what colour. Picking a colour in a HOST CONTROL steals focus, so the
// user's very next gesture is a click back into the box — and if that click
// lands on the SAME caret index, it is not a cursor move in intent, it is
// "give me my keyboard back". Dropping the pick there made every picker
// unusable for arming a typing colour (user-reported 2026-08-13), and every
// host would have had to reimplement the exception — so it lives HERE, in the
// same choke point that owns the drop. A click anywhere ELSE is a real move
// and drops the pick exactly as §2 documents.
let typingColorArmedAt = -1;
let typingColorArmedArgb = 0;
// The STICKY pick, which outlives an edit session (null = none). See the
// setTypingColor handler for why, and openEditorAt for where it is re-armed.
let stickyColorArgb = null;
// THE TYPING FONT NOW HAS TWO LIFETIMES TOO — the colour switch, transcribed
// (user decision 2026-08-20, reversing the 2026-08-13 "colour-only" one). Same two
// answers, same default, same opt-in:
//   ON  (default) — the pick is dropped by the very next cursor move.
//   OFF (sticky)  — it lasts until the host clears it, across cursor moves AND across
//                   boxes, so a form-filling host types one typeface everywhere.
//
// ⚠️ STICKY COVERS THE FAMILY *AND* BOLD/ITALIC, deliberately (user decision): both
// land on the core's ONE `currentFontId`, so one gate keeps both alive — and a sticky
// family that silently dropped bold would be the half-answer that gets reported as a
// bug. The two are remembered separately only because they are RE-ARMED differently
// across boxes (see openEditorAt): a family is a host-named face this shell can
// resolve, while a face is the core resolving bold/italic against whatever family the
// new caret sits in — which is what "keep typing bold" means in a different box.
//
// The SAME-INDEX EXCEPTION still applies, for the same measured reason colour needed
// it (docs/STYLING.md §2): picking in a host control — a <select> is the obvious font
// picker — steals focus from the sink, so the user's next gesture is a click back
// into the box at the same spot. Without the exception a picker could never arm a
// typing font at all.
let typingFontArmedAt = -1;
let typingFontArmedName = null;
let typingFontFollowsCaret = true;
// The STICKY pick, which outlives an edit session (null = none) — the twin of
// stickyColorArgb. `stickyFontName` is a host-named family (or "" / null = Original);
// `stickyFace` is {bold, italic} when B/I armed it. Only one of the two is ever set:
// whichever gesture armed last is the one a new box re-arms.
let stickyFontName = null;
let stickyFace = null;
// THE TYPING SIZE HAS THE SAME ONE LIFETIME AS THE FONT — follow-the-caret, no sticky
// mode, no switch (pdfe.h is explicit that the sticky option is colour-only). The
// same-index exception matters here more than anywhere: a size dropdown is a <select>,
// so picking one ALWAYS steals focus from the sink, and without the exception a
// collapsed pick could never survive the click back into the box.
let typingSizeArmedAt = -1;
let typingSizeArmedPt = 0;
// THE STYLE THE NEXT KEYSTROKE WILL TAKE AT |index| — the character's own, with any
// SURVIVING arm restated over it. Extracted 2026-08-19 (I76) so the caret-move report
// and the ARM report are literally the same answer: an arm used to emit nothing at all,
// so a host painting from the event kept showing the size under the cursor while the
// SDK typed the picked one ("the UI is not showing it, but inside the SDK it applies").
//
// Call it BEFORE dropping arms (postCaretMoved's order) or after — the flags recompute
// from `…ArmedAt`, which a drop sets to -1, so a dropped arm is never restated.
function armedStyleAt(index) {
  const keepPick = typingColorFollowsCaret && typingColorArmedAt >= 0 &&
                   index === typingColorArmedAt;
  const keepFont = typingFontArmedAt >= 0 && index === typingFontArmedAt;
  const keepSize = typingSizeArmedAt >= 0 && index === typingSizeArmedAt;
  // Collapsed range: readRangeStyle reads the character BEFORE the cursor —
  // the same inherit-from-the-left rule a typed character follows, so this IS
  // the colour the next keystroke gets. When the pick SURVIVES, the next
  // keystroke takes the pick — report that, or the host's swatch would lie.
  const style = readRangeStyle(index, index);
  if (keepPick && style) style.colorArgb = typingColorArmedArgb >>> 0;
  // Same rule for a surviving FONT PICK: the report names what the next keystroke will
  // actually take, so a host's picker does not snap back to the font under the cursor.
  // Only a pick needs restating here, and only its NAME — the pick is a host-named face
  // the core cannot know about.
  //
  // A face ARMED BY B/I needs nothing: since 2026-08-18 the core reports the armed
  // face's own name, family, bold and italic at a bare caret, which is what makes the B
  // button un-press after being pressed. That also RESOLVED the asymmetry this comment
  // used to warn about (name from the pick, bold/italic from the character) — there is
  // now one answer for all four fields, and `typingFontArmedName` stays null for a face
  // arm precisely so this line cannot become a second, rival answer.
  if (keepFont && style && typingFontArmedName) style.fontName = typingFontArmedName;
  // Same rule again for a surviving SIZE pick: report the size the next keystroke will
  // actually take, or the host's dropdown snaps back to the size under the cursor and
  // the user's pick looks like it was ignored.
  if (keepSize && style && typingSizeArmedPt > 0) style.sizePt = typingSizeArmedPt;
  return style;
}

// AN ARM IS A STYLE CHANGE, SO IT IS REPORTED (I76). A RANGE apply already force-posts
// its own `styleApplied` for exactly this reason; a collapsed pick changes nothing on
// the page and so posted nothing, which left every host that paints from the event
// showing the OLD value while the pick was live. Deliberately NOT `caretMoved`: that
// message re-focuses the sink on arrival, and focusing right after a picker stole focus
// pops the keyboard mid-pick on iOS (S39). This one only reports.
function postArmedStyle(index) {
  postMessage({
    type: "caretStyle", index,
    style: armedStyleAt(index),
    following: typingColorFollowsCaret,
  });
}

function postCaretMoved(index) {
  const keepPick = typingColorFollowsCaret && typingColorArmedAt >= 0 &&
                   index === typingColorArmedAt;
  if (typingColorFollowsCaret && editor && !keepPick) {
    F.editSetTypingColor(editor, 0, 0);
    typingColorArmedAt = -1;
  }
  const keepFont = typingFontArmedAt >= 0 && index === typingFontArmedAt;
  // …unless the host asked for the STICKY lifetime, in which case a cursor move is
  // not the end of the pick — the same gate colour has one branch up.
  if (typingFontFollowsCaret && editor && !keepFont && typingFontArmedAt >= 0) {
    F.editSetTypingFont(editor, 0);   // 0 = back to each segment's Original font
    typingFontArmedAt = -1;
    typingFontArmedName = null;
  }
  const keepSize = typingSizeArmedAt >= 0 && index === typingSizeArmedAt;
  if (editor && !keepSize && typingSizeArmedAt >= 0) {
    F.editSetTypingSize(editor, 0, 0);   // clear: inherit from the character on the left
    typingSizeArmedAt = -1;
    typingSizeArmedPt = 0;
  }
  // A deliberate caret move finishes the word (Phase 5): the next keystroke
  // must start a fresh undo entry, not merge into text typed somewhere else.
  if (doc) F.historySeal(doc);
  postMessage({
    type: "caretMoved", index, caret: readCaret(index),
    // The arms this move KEPT are restated by armedStyleAt — one answer, shared with
    // the arm report (I76). The drops above already zeroed the ones it did not keep.
    style: armedStyleAt(index),
    following: typingColorFollowsCaret,
  });
}

function readSelectionRects(s, e) {
  const n = F.editSelRects(editor, s, e, 0, 0);
  if (n <= 0) return [];
  const ptr = mod._malloc(n * 16);
  F.editSelRects(editor, s, e, ptr, n);
  const flat = readF32(ptr, n * 4);
  mod._free(ptr);
  const rects = [];
  for (let i = 0; i + 3 < flat.length; i += 4) rects.push(flat.slice(i, i + 4));
  return rects;
}

// Union [l,b,r,t] of the open run's line rects — the LIVE geometry of the run
// being edited, which is what the shell draws its blue editing box from. The
// grouping bounds (and editParaBounds, which only ever grows) go stale as soon
// as the text reflows. null when there is no session / nothing to measure.
function readRunBounds(len) {
  if (!editor) return null;
  // AN EMPTY RUN IS STILL AN OPEN RUN (I68). This returned null for len <= 0, and
  // the shells' `if (runBounds)` guards then skipped the redraw and LEFT THE
  // PREVIOUS BOX ON SCREEN — so deleting a box's text down to nothing left a tiny
  // blue rectangle sitting where the last surviving character had been, while the
  // caret was somewhere else entirely (user-reported 2026-08-19, with a screenshot
  // of exactly that: a caret, and a small empty rectangle a few centimetres away).
  //
  // The rule below already says the box must always contain the caret; at length 0
  // the caret is ALL there is, so the box IS the caret's box. That keeps the "you
  // are typing here" affordance honest — the user can still see where the next
  // character will land — and it cannot go stale, because it moves with the caret.
  const rects = len > 0 ? readSelectionRects(0, len) : [];
  if (!rects.length) {
    const c0 = readCaret(-1);                    // [x, topPt, botPt]
    return c0 ? [c0[0], c0[2], c0[0], c0[1]] : null;
  }
  let b = [rects[0][0], rects[0][1], rects[0][2], rects[0][3]];
  for (const r of rects) {
    b = [Math.min(b[0], r[0]), Math.min(b[1], r[1]),
         Math.max(b[2], r[2]), Math.max(b[3], r[3])];
  }
  // The caret can sit on a line no selection rect covers (a just-typed
  // Enter's new line has no glyphs yet): union the caret's line so the blue
  // "you are typing here" box always contains the caret (user request
  // 2026-07-31). Same rule in the Android shell's runBoundsPt — keep in step.
  const c = readCaret(-1);           // [x, topPt, botPt]
  if (c) {
    b = [Math.min(b[0], c[0]), Math.min(b[1], c[2]),
         Math.max(b[2], c[0]), Math.max(b[3], c[1])];
  }
  return b;
}

// ---- fonts (docs/FONTS.md) -----------------------------------------------------
// Host-supplied faces, keyed by the host's own name. DOCUMENT-owned handles, so this
// is cleared with the document — see the `open` handler.
const fontHandles = new Map();

// pdfe_edit_apply_face's negative codes -> the SDK's error vocabulary. The refusal is
// a product outcome, not an internal failure: "this family has no bold face" is
// something a host has to be able to tell the user, which is why it gets its own code
// rather than a generic engine-error (docs/FONTS.md §3).
function faceErrorCode(rc) {
  if (rc === -3) return "no-such-face";   // PDFE_FACE_ERR_NO_FACE — THE refusal
  if (rc === -2) return "mixed-fonts";    // PDFE_FACE_ERR_MIXED
  if (rc === -1) return "no-selection";   // PDFE_FACE_ERR_SESSION
  return "engine-error";                  // PDFE_FACE_ERR_APPLY, or anything new
}

// The reply both font verbs send. Shaped on applyColor's, with ONE difference that
// matters: a font apply CHANGES METRICS, so it can rewrap and grow the run — the
// paragraph's cached tap-routing bounds have to grow with it exactly as a keystroke's
// do (I9), and the caller repaints a strip that already covers old ∪ new because the
// core's dirty rect does.
function postFontApplied(what, ok, s, e, dirty, extra) {
  if (editParaBounds && dirty[2] > dirty[0] && dirty[3] > dirty[1]) {
    editParaBounds = [
      Math.min(editParaBounds[0], dirty[0]), Math.min(editParaBounds[1], dirty[1]),
      Math.max(editParaBounds[2], dirty[2]), Math.max(editParaBounds[3], dirty[3]),
    ];
  }
  const blitMs = renderDirtyStrip(editPage, dirty);
  postMessage({
    type: "styleApplied", what, ok, page: editPage,
    dirty, blitMs: Math.round(blitMs * 100) / 100,
    // NO caret, for applyColor's reason: this path only runs with a RANGE, and
    // readCaret(-1) would clamp to index 0 and draw the bar at the start of the run.
    selection: readSelectionRects(s, e),
    h0: readCaret(s), h1: readCaret(e), selStart: s, selEnd: e,
    runBounds: readRunBounds(readEditorText().length),
    style: readRangeStyle(s, e),               // read back AFTER the write
    ...extra,
  });
  postHistory();                               // a style change is a recordable step
}

// Run pdfe_group_page on |page| and refresh both caches (the core's one-slot
// grouping and our per-page bounds). THE only place the core group call lives.
function groupPage(page) {
  const n = F.group(doc, acquirePage(page), textPageOf(page));
  coreGroupedPage = page;
  coreGroupFresh = true;
  const paraBounds = [];
  const blockList = [];
  if (n > 0) {
    const bp = mod._malloc(16);
    for (let i = 0; i < n; i++) {
      paraBounds.push(F.paraInfo(doc, i, bp, 0, 0, 0) ? readF32(bp, 4) : null);
    }
    // Blocks own a CONTIGUOUS paragraph range (pdfe.h "grouping"), so two ints
    // describe the membership.
    const ip = mod._malloc(8);
    const nb = F.blockCount(doc);
    for (let b = 0; b < nb; b++) {
      if (!F.blockInfo(doc, b, bp, ip, ip + 4)) continue;
      const bounds = readF32(bp, 4);
      const first = mod.HEAP32[ip >> 2];
      const count = mod.HEAP32[(ip + 4) >> 2];
      const paras = [];
      for (let p = first; p < first + count; p++) {
        if (paraBounds[p]) paras.push({ index: p, bounds: paraBounds[p] });
      }
      if (paras.length) blockList.push({ index: b, bounds, paras });
    }
    mod._free(ip);
    mod._free(bp);
    // A core that reported no blocks (should not happen) still gets boxes.
    if (!blockList.length) {
      for (let i = 0; i < n; i++) {
        if (paraBounds[i]) {
          blockList.push({ index: blockList.length, bounds: paraBounds[i],
                           paras: [{ index: i, bounds: paraBounds[i] }] });
        }
      }
    }
  }
  // The page's images, from the same core pass.
  const imageList = [];
  {
    const bp = mod._malloc(16), qp = mod._malloc(32), ip = mod._malloc(12);
    const ni = F.imageCount(doc);
    for (let i = 0; i < ni; i++) {
      if (!F.imageInfo(doc, i, bp, qp, ip, ip + 4, ip + 8)) continue;
      imageList.push({
        index: i,
        bounds: readF32(bp, 4),
        quad: readF32(qp, 8),
        objIndex: mod.HEAP32[ip >> 2],
        turns: mod.HEAP32[(ip + 4) >> 2],
        flags: mod.HEAP32[(ip + 8) >> 2],
      });
    }
    mod._free(ip); mod._free(qp); mod._free(bp);
  }

  groupCache.delete(page);
  groupCache.set(page, blockList);   // Map order == age
  imageCache.delete(page);
  imageCache.set(page, imageList);
  if (groupCache.size > MAX_GROUP_CACHE) {
    const oldest = groupCache.keys().next().value;
    groupCache.delete(oldest);
    imageCache.delete(oldest);       // one lifetime, two maps
  }
  return blockList;
}

function cachedGroups(page) {
  const hit = groupCache.get(page);
  if (hit) { groupCache.delete(page); groupCache.set(page, hit); return hit; }
  return groupPage(page);
}

// Any object mutation breaks the core's fresh-open gate globally (mutGen is
// doc-wide) and stales the mutated PAGE's cached bounds. Other pages' bounds
// stay valid — their objects did not move.
function noteMutation(page) {
  coreGroupFresh = false;
  groupCache.delete(page);
  imageCache.delete(page);
}

// Satisfy the fresh-open gate: pdfe_edit_begin_ex needs the core's one-slot
// grouping to be for THIS page with no mutation since. Re-group only then.
function ensureCoreGroup(page) {
  if (coreGroupedPage !== page || !coreGroupFresh) groupPage(page);
}

// Hit-test in TWO levels from the per-page cache: the smallest BLOCK box
// containing the point, then the member PARAGRAPH inside it (containing, else
// nearest — a tap in a block's inter-paragraph gap belongs to the closest
// paragraph; the gap itself is not editable).
//
// Returns { index, bounds, blockIndex, blockBounds } where index/bounds are the
// PARAGRAPH's (what the editor opens), or null. Pure JS over cached bounds —
// this is what makes select/deselect taps instant on already-fetched pages.
// The same rule runs in the Android shell (PdfPageView.resolveAt) — keep in step.
function hitParagraph(page, xPt, yPt) {
  let block = null;
  for (const b of cachedGroups(page)) {
    const r = b.bounds;
    if (xPt < r[0] || xPt > r[2] || yPt < r[1] || yPt > r[3]) continue;
    const area = (r[2] - r[0]) * (r[3] - r[1]);
    if (!block || area < block.area) block = { b, area };
  }
  if (!block) return null;
  const hit = pickPara(block.b, xPt, yPt);
  if (!hit) return null;
  return { index: hit.index, bounds: hit.bounds,
           blockIndex: block.b.index, blockBounds: block.b.bounds };
}

// ONE TAP, TWO KINDS — and TEXT WINS. The core has this rule too
// (pdfe_hit_item), and this is deliberately a SECOND copy rather than a call
// into it: taps are served from the JS cache precisely so they cost no core
// pass (§ the groupCache comment). The two must agree, and wasm/image_test.mjs
// pins the core half.
//
// Text first is not a preference. A full-page scanned background is ONE image
// covering the page with the text drawn on top (aasdshsl19.pdf p0: 103.6% of
// the page under 719 text objects), so topmost-wins makes such a page
// uneditable. Among images, later in the list is drawn later, so the topmost
// wins — a logo on a panel beats the panel.
function hitItem(page, xPt, yPt) {
  const para = hitParagraph(page, xPt, yPt);
  if (para) return { kind: "text", para };
  const imgs = cachedImages(page);
  for (let i = imgs.length - 1; i >= 0; i--) {
    const r = imgs[i].bounds;
    if (xPt >= r[0] && xPt <= r[2] && yPt >= r[1] && yPt <= r[3]) {
      return { kind: "image", image: imgs[i] };
    }
  }
  return null;
}

function cachedImages(page) {
  const hit = imageCache.get(page);
  if (hit) return hit;
  groupPage(page);                       // fills both maps
  return imageCache.get(page) || [];
}

// The picture whose bounds match |want| most closely — the image twin of
// findMovedBlock, and needed for the same reason: after a move the LIST INDEX
// may have changed, and re-resolving by the rect we just created is what keeps
// the dragged picture selected instead of a neighbour.
function findMovedImage(imgs, want) {
  let best = null, bestD = Infinity;
  for (const im of imgs) {
    const d = Math.abs(im.bounds[0] - want[0]) + Math.abs(im.bounds[1] - want[1]) +
              Math.abs(im.bounds[2] - want[2]) + Math.abs(im.bounds[3] - want[3]);
    if (d < bestD) { bestD = d; best = im; }
  }
  return bestD <= 1.0 ? best : null;
}

// Which paragraph of a KNOWN block a point means: the smallest one containing it,
// else the nearest. Split out of hitParagraph so the post-move re-select can pick a
// paragraph inside a block it identified some other way, without duplicating this.
function pickPara(block, xPt, yPt) {
  let best = null, nearest = null, nearestDist = Infinity;
  for (const para of block.paras) {
    const r = para.bounds;
    if (xPt >= r[0] && xPt <= r[2] && yPt >= r[1] && yPt <= r[3]) {
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      if (!best || area < best.area) best = { para, area };
      continue;
    }
    const dx = xPt < r[0] ? r[0] - xPt : (xPt > r[2] ? xPt - r[2] : 0);
    const dy = yPt < r[1] ? r[1] - yPt : (yPt > r[3] ? yPt - r[3] : 0);
    const d = dx * dx + dy * dy;
    if (d < nearestDist) { nearestDist = d; nearest = para; }
  }
  return best ? best.para : nearest;
}

// THE BOX THE USER DRAGGED, after the page has been re-grouped — and it is NOT
// reliably the one under the drop point. hitParagraph prefers the SMALLEST box
// containing the point, which is right for a tap (the tightest target under a
// finger) and wrong here: drop a large box across several small ones and a small
// one wins, so the selection jumped off the box the user was holding.
//
// Identity guarantees the moved box neither merged nor split (docs/BLOCK_MOVE.md
// §5 — five guards enforce it), so after re-grouping its rect IS its old rect
// translated by the drag. Matching that rect is a whole-box signal; a point test
// is a one-pixel one. Best overlap wins, by intersection-over-union so that a box
// merely CROSSED by the drop cannot beat the box that actually landed there.
function findMovedBlock(blocks, want) {
  let best = null, bestScore = 0;
  const wantArea = Math.max(0, want[2] - want[0]) * Math.max(0, want[3] - want[1]);
  for (const b of blocks) {
    const r = b.bounds;
    const iw = Math.min(r[2], want[2]) - Math.max(r[0], want[0]);
    const ih = Math.min(r[3], want[3]) - Math.max(r[1], want[1]);
    if (iw <= 0 || ih <= 0) continue;
    const inter = iw * ih;
    const union = (r[2] - r[0]) * (r[3] - r[1]) + wantArea - inter;
    const score = union > 0 ? inter / union : 0;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  // A high bar deliberately: anything less than a near-exact match means the box
  // did NOT survive the move intact, and silently selecting a lookalike would
  // hide that. Fall back to the point hit and let the old behaviour show.
  return bestScore >= 0.5 ? best : null;
}

// Re-render ONLY the dirty page-point rect as a strip (§4): offset baked into
// the matrix inside pdfe_render_region. Returns the blit duration in ms.
function renderDirtyStrip(page, dirty) {
  const canvas = canvases.get(page);
  const scale = pageScale.get(page);
  if (!canvas || !scale || dirty[2] <= dirty[0] || dirty[3] <= dirty[1]) return 0;
  const ph = pages[page].h;
  let x = Math.floor(dirty[0] * scale);
  let y = Math.floor((ph - dirty[3]) * scale);
  let w = Math.ceil((dirty[2] - dirty[0]) * scale) + 1;
  let h = Math.ceil((dirty[3] - dirty[1]) * scale) + 1;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(canvas.width - x, w); h = Math.min(canvas.height - y, h);
  if (w <= 0 || h <= 0) return 0;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const t0 = performance.now();
  blitRegion(ctx, acquirePage(page), scale, x, y, w, h);
  return performance.now() - t0;
}

// Commit the live session (the core runs the whole commit ladder) and adopt
// the final text page back. Posts editClosed so the shell hides the overlays.
function commitEditor() {
  if (!editor) return;
  const tpp = mod._malloc(4);
  const ok = F.editCommit(editor, tpp);
  const tp = new Uint32Array(mod.HEAPU8.buffer, tpp, 1)[0];
  mod._free(tpp);
  if (tp) textPages.set(editPage, tp);
  const page = editPage;
  if (ok === 1) dirtyPages.delete(page);   // the core commit flushed this page
  noteMutation(page);                      // indices/bounds may have shifted
  editor = 0; editPage = -1; editParaBounds = null;
  // DOCUMENT REFLOW runs HERE — after the commit, before the shell is told the box
  // closed. §2.2's rule is that the editor never sees a split paragraph: the live
  // preview may legally hang past the page bottom while the user types, and the page
  // is re-settled at commit. This is that commit.
  // GUARDED, because a throw here would swallow the editClosed message below and leave
  // the shell's overlays up with no way to recover. An experimental layer must not be
  // able to wedge the editor.
  let flowed = null;
  if (flowOn) {
    try { flowed = settleAfterCommit(page); }
    catch (err) { console.error("[pdfe] documentReflow: settle threw —", err); }
  }
  postMessage({ type: "editClosed", page, ok: ok === 1 });
  // FORCED, not deduped. Entering a box and leaving it without typing changes
  // neither flag, so a deduped post sends nothing — and the shell is left holding
  // the unsaved-changes flag its editclose handler had just set, with an empty
  // undo stack contradicting it. The close is exactly when the shell needs the
  // stack's answer, whether or not the answer changed (the S15 rule).
  postHistory(true);
}

// ---- document reflow --------------------------------------------------------
// The settle walk lives in the core (core/src/flow.cpp) for the same reason the undo
// journal does: web, Android and iOS must behave identically from one implementation.
// This function is only the shell contract around it — group, settle, invalidate,
// re-group, tell the host.
let flowOn = false;

// THE CASCADE LIVES HERE, NOT IN THE CORE, and that is deliberate. pdfe_flow_settle
// settles exactly ONE page and says so: content arriving on the next page is seated
// below what is already there and is not itself re-settled. That keeps the core verb
// small and predictable — but a document does not stop at one page, so somebody has to
// walk the chain, and the shell is the right somebody: it owns the page handles, the
// text-page cache and the caches that go stale, and it can stop.
//
// WHY IT MATTERS THAT IT EXISTS AT ALL: without it, overflow leaving page 3 lands under
// page 4's own content, which on a full page means off the bottom of it — correct in the
// model and invisible to the user. With it, the ripple continues until a page has room
// or a new one is appended, which is what "document reflow" means to anybody watching.
//
// BOUNDED, because an unbounded reflow loop on a bad document is a hung tab: it stops
// when a settle moves nothing, and never runs more than CASCADE_MAX pages.
const CASCADE_MAX = 24;

// ONE USER UNDO REVERSES ONE CASCADE, not one page of it. A cascade creates a flow
// transaction PER PAGE it settles, so this stack records how many each commit produced and
// the undo pops that many. Without it, pressing undo after a reflow that rippled across six
// pages would un-ripple exactly one of them and leave the document half-reflowed — which
// looks far more broken than not undoing at all.
//
// THE APPROXIMATION, stated because it is one: this pairs each cascade with the text step
// that caused it, and the text journal coalesces keystrokes on its own schedule. So "undo"
// means "reverse the last reflow and the last text step", which is right for the case the
// feature exists for (type, commit, reflow) and is not a general reconciliation of two
// independent histories. That reconciliation is the real Phase 6.
let flowGroups = [];
// The same bookkeeping for the other direction. undoFlowGroup moves a group here; a settle
// clears it, mirroring the core's own rule that a new settle drops the redo stack (a
// transaction recorded against geometry that has since changed cannot be replayed onto it).
let flowRedoGroups = [];

function settlePageOnce(p) {
  // The settle reads this page's LINES, so its grouping must be fresh. The TEXT page is
  // reloaded; the PAGE handle is deliberately kept — see the note in the cascade below.
  const tpOld = textPages.get(p);
  if (tpOld) { F.closeTextPage(tpOld); textPages.delete(p); }
  groupPage(p);
  const sp = mod._malloc(16);
  const ok = F.flowSettle(doc, p, acquirePage(p), sp);
  const st = Array.from(new Int32Array(mod.HEAPU8.buffer, sp, 4));
  mod._free(sp);
  if (ok !== 1) return null;
  return { nudged: st[0], linesMigrated: st[1], itemsMigrated: st[2], pagesAdded: st[3] };
}

function settleAfterCommit(page) {
  if (!doc || !flowOn || page < 0) return null;
  const txnsBefore = F.flowCanUndo(doc);
  const total = { nudged: 0, linesMigrated: 0, itemsMigrated: 0, pagesAdded: 0 };
  const touched = new Set();
  let p = page, rounds = 0, moved = false;

  while (rounds++ < CASCADE_MAX) {
    const st = settlePageOnce(p);
    if (!st) { console.warn("[pdfe] documentReflow: settle refused on page", p); break; }
    total.nudged += st.nudged;
    total.linesMigrated += st.linesMigrated;
    total.itemsMigrated += st.itemsMigrated;
    total.pagesAdded += st.pagesAdded;
    touched.add(p);
    if (st.nudged || st.linesMigrated || st.itemsMigrated || st.pagesAdded) moved = true;

    // INVALIDATE both sides. A migration removes page objects, which invalidates every
    // text page for the source page (a documented engine fact, not an observed symptom)
    // and stales our cached bounds for both.
    noteMutation(p);
    dirtyPages.delete(p);            // the settle regenerated the content stream itself
    if (!st.linesMigrated && !st.itemsMigrated) break;   // nothing left this page: done
    touched.add(p + 1);
    noteMutation(p + 1);
    dirtyPages.delete(p + 1);
    // NO HANDLE DANCE HERE ANY MORE, and its absence is the point.
    //
    // This is where the worker used to close and re-load the destination page's handle,
    // because pdfe_flow_settle migrated onto a REGISTRY handle — a different CPDF_Page from
    // the one this worker holds — so our view of page p+1 could not see what had just
    // landed on it and the cascade stopped dead at its first destination.
    //
    // acquirePage now ADOPTS every handle it loads into the core's page registry, so the
    // registry resolves this index to OUR handle and there is only ever one view. The
    // workaround is not merely unnecessary, it is gone — which is the falsification that
    // matters: if adoption did not work, the cascade would stop again and
    // flow_settle_test §6 would go red.
    p = p + 1;
    if (p >= F.pageCount(doc)) break;
  }
  if (rounds > CASCADE_MAX)
    console.warn("[pdfe] documentReflow: cascade hit its", CASCADE_MAX, "page bound");
  const txnsAdded = F.flowCanUndo(doc) - txnsBefore;
  if (txnsAdded > 0) {
    flowGroups.push(txnsAdded);
    // A NEW SETTLE DROPS THE REDO GROUPS, mirroring what the core just did to its own redo
    // stack. Leaving them would leave this shell counting transactions that no longer exist.
    flowRedoGroups.length = 0;
  }
  if (!moved) return null;

  coreGroupedPage = -1; coreGroupFresh = false;

  // Re-group and refresh the model for every page the cascade touched — the contract
  // pdfe_flow_settle documents. Without it the model's object lists are a guess.
  for (const q of touched) {
    const tp = textPages.get(q);
    if (tp) { F.closeTextPage(tp); textPages.delete(q); }
    groupPage(q);
    F.flowRefresh(doc, q, acquirePage(q));
  }

  // The page count may have grown. Measure the new pages WITHOUT loading them.
  const n = F.pageCount(doc);
  let pagesChanged = false;
  if (n !== pages.length) {
    const dims = mod._malloc(8);
    for (let i = pages.length; i < n; i++) {
      F.pageSizeAt(doc, i, dims, dims + 4);
      const v = new Float32Array(mod.HEAPU8.buffer, dims, 2);
      pages.push({ w: v[0], h: v[1] });
    }
    mod._free(dims);
    pagesChanged = true;
  }

  const out = { type: "documentReflowed", page, ...total, pagesChanged,
                cascadedPages: [...touched].sort((a, b) => a - b), pages: pages.slice() };
  postMessage(out);
  return out;
}

// Reverse every flow transaction the last cascade produced, newest first (the core's own
// stack is already LIFO, so repeated calls unwind in the right order).
function undoFlowGroup() {
  const n = flowGroups.pop();
  if (!n) return;
  // LET GO OF THE TAIL PAGES FIRST. pdfe_delete_page refuses a page anything holds a live
  // handle on — which is exactly the protection we want, and which this worker trips on its
  // own: it acquires a page handle to PAINT it, so the page a reflow appended is being held
  // by the very act of showing it to the user. Measured in the browser: the undo restored
  // every object correctly and the extra page stayed, empty, on screen.
  //
  // Closing them here is safe: a page handle is a cache, and anything that still needs one
  // re-acquires it. Only pages after the anchor are dropped, so the page being edited keeps
  // the handle its own identity registry is scoped to.
  const anchor = F.flowUndoPage(doc);
  if (anchor >= 0)
    for (const k of [...pageHandles.keys()]) if (k > anchor) closePageHandles(k);
  const touched = new Set();
  let reversed = 0;
  for (let k = 0; k < n; k++) {
    const pi = F.flowUndoPage(doc);
    if (pi < 0) break;
    // Our OWN handle for that page — the same rule the settle follows, and the reason
    // pdfe_flow_undo takes one at all: a registry handle is a different object list, so an
    // undo that resolved the page itself would put the objects back where nobody is
    // looking (measured — the page reported the same object count before and after a
    // "successful" undo).
    const ok = F.flowUndo(doc, pi, acquirePage(pi));
    if (ok !== 1) break;
    ++reversed;
    touched.add(pi);
    touched.add(pi + 1);
  }
  // HAND THE GROUP TO THE REDO SIDE — and hand across what was ACTUALLY reversed, not what
  // was asked for. The core pushed exactly |reversed| transactions onto its redo stack, so a
  // count taken before the loop would make the shell ask for transactions that are not there.
  if (reversed > 0) flowRedoGroups.push(reversed);
  for (const p of touched) {
    const tp = textPages.get(p);
    if (tp) { F.closeTextPage(tp); textPages.delete(p); }
    noteMutation(p);
    dirtyPages.delete(p);
  }
  coreGroupedPage = -1; coreGroupFresh = false;

  // The page count may have SHRUNK — a reflow that appended a page has just had it taken
  // away again.
  const count = F.pageCount(doc);
  let pagesChanged = false;
  if (count !== pages.length) { pages.length = count; pagesChanged = true; }

  for (const p of touched) {
    if (p >= count) continue;
    groupPage(p);
    F.flowRefresh(doc, p, acquirePage(p));
  }
  postMessage({ type: "documentReflowed", page: [...touched][0] ?? 0, nudged: 0,
                linesMigrated: 0, itemsMigrated: 0, pagesAdded: 0, undone: true,
                pagesChanged, cascadedPages: [...touched].sort((a, b) => a - b),
                pages: pages.slice() });
}

// Replay every flow transaction the last undo reversed, OLDEST FIRST — and that order is
// not the mirror of undoFlowGroup's, it is the opposite of it.
//
// ⚠️ WHY OLDEST-FIRST. A cascade settles pages 0,1,2 and stacks T0,T1,T2. The undo unwinds
// newest-first (T2,T1,T0), which is right: the last page's arrivals have to leave before the
// page before it can take its own content back. A redo has to put them back the way the
// cascade did, which is T0,T1,T2 — replaying newest-first would seat page 2's content on a
// page 1 that has not yet given anything up.
//
// It needs NO bookkeeping here, because the two core stacks already produce it: the undo
// pushed T2,T1,T0 onto the redo stack in that order, so popping it yields T0,T1,T2.
//
// AND IT NEEDS NO HANDLE DANCE. undoFlowGroup drops the tail pages' handles first, because
// pdfe_delete_page refuses a page anything holds a live handle on and the worker holds one
// to paint it. A redo APPENDS instead of deleting, and appending at the tail touches no
// existing page — so there is nothing to let go of. The pages array is grown afterwards
// instead, exactly as settleAfterCommit grows it.
function redoFlowGroup() {
  const n = flowRedoGroups.pop();
  if (!n) return;
  const touched = new Set();
  let replayed = 0;
  for (let k = 0; k < n; k++) {
    const pi = F.flowRedoPage(doc);
    if (pi < 0) break;
    // Our OWN handle for that page — the same rule the settle and the undo follow, and for
    // the same reason: a registry handle is a different object list, so a replay that
    // resolved the page itself would put the content where nobody is looking.
    const ok = F.flowRedo(doc, pi, acquirePage(pi));
    if (ok !== 1) {
      // A REFUSAL IS REPORTED, NEVER RETRIED. The core refuses when a page the transaction
      // created is no longer the tail of the document; retrying or forcing it would put a
      // page's worth of content somewhere the user did not put it.
      console.warn("[pdfe] documentReflow: redo refused on page", pi,
                   "— the replay is partial and the rest of the group is left stacked");
      break;
    }
    ++replayed;
    touched.add(pi);
    touched.add(pi + 1);
  }
  // AND GIVE THE GROUP BACK TO THE UNDO SIDE, or the pair only round-trips ONCE.
  //
  // FOUND IN CHROME, NOT HEADLESSLY, and it could not have been found headlessly: the suite
  // calls pdfe_flow_undo/_redo directly, and the core already hands its own transaction back
  // and forth between its two stacks correctly. This counter is the SHELL's half of that, and
  // without it the second undo of a sequence found flowGroups empty and silently did nothing
  // — measured: undo, redo, undo left the document exactly as the redo had, 8 pages and all.
  if (replayed > 0) flowGroups.push(replayed);
  for (const p of touched) {
    const tp = textPages.get(p);
    if (tp) { F.closeTextPage(tp); textPages.delete(p); }
    noteMutation(p);
    dirtyPages.delete(p);
  }
  coreGroupedPage = -1; coreGroupFresh = false;

  // The page count may have GROWN again — a redo re-creates the page its undo removed.
  // Measured WITHOUT loading the new pages, exactly as the settle does.
  const count = F.pageCount(doc);
  let pagesChanged = false;
  if (count !== pages.length) {
    if (count > pages.length) {
      const dims = mod._malloc(8);
      for (let i = pages.length; i < count; i++) {
        F.pageSizeAt(doc, i, dims, dims + 4);
        const v = new Float32Array(mod.HEAPU8.buffer, dims, 2);
        pages.push({ w: v[0], h: v[1] });
      }
      mod._free(dims);
    } else {
      pages.length = count;
    }
    pagesChanged = true;
  }

  for (const p of touched) {
    if (p >= count) continue;
    groupPage(p);
    F.flowRefresh(doc, p, acquirePage(p));
  }
  postMessage({ type: "documentReflowed", page: [...touched][0] ?? 0, nudged: 0,
                linesMigrated: 0, itemsMigrated: 0, pagesAdded: 0, redone: true,
                pagesChanged, cascadedPages: [...touched].sort((a, b) => a - b),
                pages: pages.slice() });
}

// ---- undo / redo ------------------------------------------------------------
// THE JOURNAL IS NOT HERE. It lives in the core (core/src/undo.cpp) so web,
// Android and iOS behave identically from one implementation; this file only
// executes the ordered shell contract in docs/UNDO_REDO.md §1. Keep the steps
// below in that order and numbered — the Android port is a transcription of
// them, and a step silently dropped on one platform is exactly the class of
// divergence the contract exists to prevent.

let lastHistory = "";   // "canUndo,canRedo" — so the event fires only on change

function historyState() {
  if (!doc) return { canUndo: false, canRedo: false, undoPage: -1, redoPage: -1, recording: false };
  const u = F.undoPage(doc), r = F.redoPage(doc);
  // |recording| rides along because an empty stack means two different things:
  // "everything has been undone" while recording, and "nothing was ever written
  // down" while not. Only the first one says the document is unmodified.
  return { canUndo: u >= 0, canRedo: r >= 0, undoPage: u, redoPage: r,
           recording: !!F.historyEnabled(doc) };
}

// Re-query and post, but only when the pair actually changed: this is called
// from every mutator tail, and a typing burst must not spam the shell.
function postHistory(force) {
  const h = historyState();
  const key = `${h.canUndo},${h.canRedo},${h.recording}`;
  if (!force && key === lastHistory) return;
  lastHistory = key;
  postMessage({ type: "history", ...h });
}

function applyHistory(kind) {
  const undo = kind === "undo";
  if (!doc) return;

  // S0. QUIESCE THE KEYSTROKE PIPE. A keystroke can be posted but not yet
  // applied when Ctrl+Z arrives; running the undo first would let that stale
  // buffer land on top of it and silently revert it. Drain before asking the
  // core anything.
  if (pendingEdit) drainLatch();

  // DOCUMENT REFLOW, AND THE ORDER IS THE OPPOSITE IN EACH DIRECTION. This is the one part
  // of redo that is NOT a mirror of undo, and getting it backwards is silent rather than
  // loud — the replay would still report success.
  //
  // UNDO REVERSES THE FLOW FIRST: the reflow was caused by the text step about to be undone,
  // so the geometry has to come back before the text that justified it disappears. Reversing
  // it afterwards would be reversing a settle of a page that no longer looks like the one
  // that was settled.
  //
  // REDO REPLAYS THE FLOW LAST, for the mirror of that reason: the transaction was recorded
  // against POST-edit geometry, so replaying it before the text is back would replay it onto
  // a page that does not match what was recorded.
  const replayFlow = () => { if (!undo && flowOn && flowRedoGroups.length) redoFlowGroup(); };
  if (undo && flowOn && flowGroups.length) undoFlowGroup();

  // S1. Which page? This IS canUndo — never cache a separate flag.
  const page = undo ? F.undoPage(doc) : F.redoPage(doc);
  // Nothing left in the TEXT journal does not mean nothing left in the FLOW one — the two
  // are paired by convention, not reconciled — so a pending replay still runs.
  if (page < 0) { replayFlow(); postHistory(true); return; }

  // S2. A session on ANOTHER page must be committed; one on this page stays
  // open, which is what makes the in-place fast path (code 2) reachable.
  if (editor && editPage !== page) commitEditor();

  // S3. Residency, not visibility — undo must work on a scrolled-away page.
  const pg = acquirePage(page);
  const tp = textPageOf(page);

  // S5. (S4, scrolling, is the shell's business — the SDK does it on receipt.)
  const dp = mod._malloc(16);
  const fp2 = mod._malloc(16);
  const tpp = mod._malloc(4);
  const code = (undo ? F.undo : F.redo)(doc, pg, tp, dp, fp2, tpp);
  const dirty = readF32(dp, 4);
  // WHERE the run ended up, as distinct from what to repaint. Selecting on the
  // dirty rect's centre looks right until a MOVE is undone: that rect spans the
  // old and new positions and its centre lands in the gap between them.
  const focus = readF32(fp2, 4);
  // S6. Adopt the returned text page UNCONDITIONALLY — the core may have
  // reloaded it, and keeping the stale handle would crash on close.
  const newTp = new Uint32Array(mod.HEAPU8.buffer, tpp, 1)[0];
  mod._free(dp);
  mod._free(fp2);
  mod._free(tpp);
  if (newTp) textPages.set(page, newTp);

  // S7. Branch on the result.
  if (code <= 0) {
    postMessage({
      type: "historyApplied", kind, page, ok: false, code,
      error: code === -3 ? "history-unavailable" : undefined,
    });
    postHistory(true);
    return;
  }

  const live = code === 2;   // applied INTO the open session
  let liveState = null;
  if (live) {
    // S8. Refresh the IME buffer from the core. editParaBounds only ever GROWS
    // while typing, and an undo can shrink the run, so re-seed it rather than
    // union it or the next tap routes against a stale box.
    const text = readEditorText();
    const caretIndex = F.editCaretIndex(editor);
    const bounds = readRunBounds(text.length);
    if (bounds) editParaBounds = bounds;
    liveState = { text, caretIndex, caret: readCaret(caretIndex),
                  runBounds: bounds || editParaBounds };
    // S9. Still un-flushed: a live apply is a preview, exactly like a keystroke.
    dirtyPages.add(page);
  } else {
    // The core reopened, restored and committed, so the page is flushed and any
    // session that was open on it is gone.
    if (editor && editPage === page) { editor = 0; editPage = -1; editParaBounds = null; }
    dirtyPages.delete(page);
  }

  // S10. The grouping is stale either way.
  noteMutation(page);
  // S11. Repaint. The core's rect already covers the run before AND after plus
  // the block box at both states, so no widening is needed here.
  renderDirtyStrip(page, dirty);

  // S12/S13. Re-group, then re-establish the selection BY POSITION — the centre
  // of what changed. Never by index: a step renumbers blocks.
  const blocks = groupPage(page);
  let selection = null;
  // AN IMAGE STEP FIRST. Its focus rect is the PICTURE's, and hit-testing that
  // for a paragraph is not merely useless — a picture usually has text near or
  // over it, so the paragraph branch below would hand the selection to an
  // unrelated text box on every image undo. The list index is stable (nothing
  // adds or removes image objects), so the picture is re-read, not re-found.
  let imageStep = false;
  if (selectedImage && selectedImage.page === page) {
    const fresh = cachedImages(page).find((im) => im.index === selectedImage.index);
    if (fresh) {
      imageStep = true;
      selectedImage = { page, index: fresh.index, bounds: fresh.bounds, quad: fresh.quad,
                        turns: fresh.turns, flags: fresh.flags };
      postMessage({ type: "imageSelected", page, index: fresh.index, bounds: fresh.bounds,
                    quad: fresh.quad, turns: fresh.turns, flags: fresh.flags });
    }
  }
  if (!imageStep && !live && focus[2] > focus[0] && focus[3] > focus[1]) {
    const cx = 0.5 * (focus[0] + focus[2]);
    const cy = 0.5 * (focus[1] + focus[3]);
    const hit = hitParagraph(page, cx, cy);
    if (hit) {
      selectedPara = { page, index: hit.index, bounds: hit.blockBounds, xPt: cx, yPt: cy };
      selection = { index: hit.index, bounds: hit.blockBounds,
                    blockIndex: hit.blockIndex, xPt: cx, yPt: cy };
    } else {
      selectedPara = null;
    }
  }

  postMessage({
    type: "historyApplied", kind, page, ok: true, code, live, blocks,
    images: imageCache.get(page) || [], selection,
    dirty, focus,
    // Present only on the live path — the shell re-seeds its sink from these.
    ...(liveState || {}),
  });
  // …AND ONLY NOW THE FLOW REPLAY: the text is back, so the geometry the transaction was
  // recorded against is back with it. (A text redo that FAILED deliberately does not reach
  // here — the group stays stacked rather than being replayed onto a page that never
  // changed.)
  replayFlow();
  // S14/S15 (dirty flag + button state) are the SDK's half.
  postHistory(true);
}

// ---- paragraph selection (select-then-act) ---------------------------------
// The shell mirrors these two messages into its box overlay + action bar; it
// never decides on its own what is selected.

function selectPara(page, hit, xPt, yPt) {
  // ANDROID PARITY: what the user SELECTS is the box (the block) — the same
  // unit Edit opens and Delete removes.
  selectedPara = { page, index: hit.index, bounds: hit.blockBounds, xPt, yPt };
  postMessage({ type: "paraSelected", page, index: hit.index,
                bounds: hit.blockBounds,
                blockIndex: hit.blockIndex, blockBounds: hit.blockBounds });
}

// A SELECTED PICTURE. Held beside selectedPara rather than folded into it: the
// two answer different questions (a paragraph can be OPENED for typing, a
// picture never can), and every existing test of `selectedPara` means "is there
// a text box selected" and must keep meaning exactly that.
let selectedImage = null;   // { page, index, bounds, quad, turns, flags }

function selectImage(page, im) {
  selectedImage = { page, index: im.index, bounds: im.bounds, quad: im.quad,
                    turns: im.turns, flags: im.flags };
  postMessage({ type: "imageSelected", page, index: im.index,
                bounds: im.bounds, quad: im.quad, turns: im.turns, flags: im.flags });
}

function clearSelection() {
  if (selectedImage) {
    selectedImage = null;
    postMessage({ type: "imageDeselected" });
  }
  if (!selectedPara) return;
  selectedPara = null;
  postMessage({ type: "paraDeselected" });
}

// Delete a whole BLOCK, atomically — one silent action with no
// editOpened/editClosed traffic: no caret flash, no keyboard, no half-erased
// frame. |xPt,yPt| is the point the selection was made at; the block is
// re-resolved from a FRESH grouping (which also satisfies the core's fresh-open
// gate), so a stale index can never delete the wrong text.
//
// The open-code that used to live here (begin_block -> set_text("") -> commit)
// is now pdfe_delete_block in the core. That is deliberate, not tidying: the
// core records the payload that makes the deletion UNDOABLE while the objects
// are still readable, and a shell driving the ladder itself would skip it. Same
// reasoning as pdfe_move_block owning the identity pin.
function deleteParagraphAt(page, xPt, yPt) {
  if (editor) commitEditor();
  ensureCoreGroup(page);   // the fresh-open gate; also refreshes stale bounds
  const hit = hitParagraph(page, xPt, yPt);
  if (!hit) { postMessage({ type: "paraDeleted", page, ok: false }); return; }

  const dPtr = mod._malloc(16);
  const tpp = mod._malloc(4);
  const ok = F.deleteBlock(doc, acquirePage(page), textPageOf(page),
                           hit.blockIndex, dPtr, tpp);
  const d = readF32(dPtr, 4);
  const tp = new Uint32Array(mod.HEAPU8.buffer, tpp, 1)[0];
  mod._free(dPtr);
  mod._free(tpp);
  if (tp) textPages.set(page, tp);
  if (!ok) { postMessage({ type: "paraDeleted", page, ok: false }); return; }

  noteMutation(page);
  dirtyPages.delete(page);   // pdfe_delete_block commits, so the page is flushed
  // The core's rect already unions the run and the block box, but keep the
  // shell's own widening: the box is drawn from grouping bounds, which can be a
  // little wider than the ink, and a few unrepainted pixels read as a ghost.
  const strip = (d[2] > d[0] && d[3] > d[1])
    ? [Math.min(d[0], hit.blockBounds[0]), Math.min(d[1], hit.blockBounds[1]),
       Math.max(d[2], hit.blockBounds[2]), Math.max(d[3], hit.blockBounds[3])]
    : hit.blockBounds;
  renderDirtyStrip(page, strip);
  postMessage({ type: "paraDeleted", page, ok: true });
  postHistory();
}

// ---- image move + rotate (docs/IMAGE_EDIT.md) -------------------------------
//
// Simpler than the block path below, and worth saying why rather than leaving
// the asymmetry looking like an oversight: a picture IS one object, so there is
// no membership to re-resolve and no identity to pin before touching it. What
// the two share is the rule that the SELECTION decides which thing moves, never
// a point test — after a drop, an anchor point can sit inside several things at
// once, and the point test then hands the next nudge to a neighbour.

// The shared tail: repaint, re-group, and re-find the picture we just changed so
// it stays selected. |before| is its rect before the change.
function afterImageChange(page, before, kind) {
  dirtyPages.add(page);
  noteMutation(page);
  const imgs = cachedImages(page);          // re-groups; restores the fresh-open gate
  // Re-find by the rect the core reports NOW for the same list slot, then widen
  // the repaint over both. Doing it from the fresh list rather than from our own
  // arithmetic means a clamped move repaints where the picture actually landed.
  const now = imgs.find((im) => im.index === selectedImage.index) || null;
  const after = now ? now.bounds : before;
  renderDirtyStrip(page, [
    Math.min(before[0], after[0]), Math.min(before[1], after[1]),
    Math.max(before[2], after[2]), Math.max(before[3], after[3]),
  ]);
  if (now) {
    selectedImage = { page, index: now.index, bounds: now.bounds, quad: now.quad,
                      turns: now.turns, flags: now.flags };
    postMessage({ type: "imageSelected", page, index: now.index, bounds: now.bounds,
                  quad: now.quad, turns: now.turns, flags: now.flags });
  }
  // The DIRTY flag is the editor's to set when this result lands — the same
  // split every other mutation follows (see "blockMoved" in pdfe-editor.js).
  //
  // THE WHOLE PAGE'S PICTURE LIST TRAVELS WITH THE RESULT, not just the one that
  // moved. The shell draws a faint outline per picture from its own cached copy,
  // and that copy is otherwise only refreshed by the `groups` message — so after
  // a drag the moved picture's outline stayed at its ORIGINAL position, showing
  // up the moment the user deselected (user-reported). Sending the fresh list is
  // what `blockMoved` already does with `blocks`, and for exactly this reason.
  postMessage({ type: kind, page, ok: true, images: imgs,
                bounds: now ? now.bounds : null, turns: now ? now.turns : null });
  // AND TELL THE HOST ITS UNDO BUTTON CHANGED. The core records the step itself
  // — a shell cannot forget that — but nothing pushes the new can-undo state to
  // the editor except this call, and without it the engine holds a perfectly
  // good undo entry that no button is lit for. Every other recordable mutation
  // in this file ends the same way.
  postHistory(true);
}

function moveSelectedImage(dx, dy) {
  if (editor) commitEditor();
  const page = selectedImage.page;
  ensureCoreGroup(page);
  const before = selectedImage.bounds.slice();
  const dp = mod._malloc(16);
  const ok = F.moveImage(doc, acquirePage(page), selectedImage.index, dx, dy, dp);
  mod._free(dp);
  if (!ok) { postMessage({ type: "imageMoved", page, ok: false }); return; }
  afterImageChange(page, before, "imageMoved");
}

function rotateSelectedImage(turns) {
  if (editor) commitEditor();
  const page = selectedImage.page;
  ensureCoreGroup(page);
  const before = selectedImage.bounds.slice();
  const dp = mod._malloc(16);
  const ok = F.rotateImage(doc, acquirePage(page), selectedImage.index, turns, dp);
  mod._free(dp);
  if (!ok) { postMessage({ type: "imageRotated", page, ok: false }); return; }
  afterImageChange(page, before, "imageRotated");
}

// DELETE THE SELECTED PICTURE (user, 2026-08-28 — this reverses the 2026-08-25
// "image deletion is out of scope" decision; see docs/IMAGE_EDIT.md §1).
//
// NOT a call to afterImageChange, and the difference is the whole point: that
// helper's job is to re-find the picture and keep it selected, and after a
// delete there is nothing to re-find. Getting this wrong would leave the
// selection outline and the rotate handle floating over a picture that is no
// longer there — which is exactly defect #3 of the first image-edit pass.
function deleteSelectedImage() {
  if (editor) commitEditor();
  const page = selectedImage.page;
  const index = selectedImage.index;
  ensureCoreGroup(page);
  const before = selectedImage.bounds.slice();
  const dp = mod._malloc(16);
  const ok = F.deleteImage(doc, acquirePage(page), index, dp);
  mod._free(dp);
  if (!ok) { postMessage({ type: "imageDeleted", page, ok: false }); return; }
  clearSelection();                       // the picture is gone: nothing is selected
  dirtyPages.add(page);
  noteMutation(page);
  const imgs = cachedImages(page);        // re-groups; the deleted one is now absent
  renderDirtyStrip(page, before);         // repaint exactly where it was
  // The whole page's picture list travels with the result, for the same reason
  // afterImageChange sends it: the shell draws its faint outlines from a cached
  // copy, and without a fresh list the deleted picture keeps its outline.
  postMessage({ type: "imageDeleted", page, ok: true, images: imgs });
  postHistory(true);                      // …and light the undo button
}

// ---- block move (drag a text box to a new position) -------------------------
// EXPERIMENTAL, web only (branch feature/web-block-move).
//
// The block's TEXT objects are translated by (dx, dy) page points — a pure
// matrix translation, so glyphs, fonts, colour and rotation are untouched. By
// design this moves TEXT ONLY: underlines, rule lines, vector bullets, cell
// borders and background fills are path objects, the grouper never reports
// them, and they stay where they are.
//
// The core call is pdfe_move_block, not pdfe_translate_objects, because it also
// PINS THE BLOCK'S IDENTITY — without that a dropped box merges with whatever
// it lands near, and a box must keep its identity (user directive 2026-08-03).
// Gathering the block's objects here and translating them directly would move
// the same pixels and silently lose that guarantee, so the shell deliberately
// does not know how to do it.

// Move the block under (xPt, yPt) by (dx, dy) page points. |xPt,yPt| is the
// point the drag STARTED from — the block is re-resolved from a FRESH grouping
// (the same stale-index guard deleteParagraphAt uses), never from an index the
// shell has been holding.
//
// A move changes the page's geometry, so paragraph indices shift even though
// the BOXES are now stable across it. The selection is therefore re-established
// by hit-testing the DROP point against the new grouping, never by reusing the
// old index.
function moveBlockAt(page, xPt, yPt, dx, dy, wantBounds) {
  if (editor) commitEditor();
  ensureCoreGroup(page);
  // WHICH BOX MOVES IS THE SELECTION'S ANSWER, not the anchor point's, whenever
  // the caller knows the selected rect. After a box has been dropped across
  // others its anchor lies inside several boxes at once, and hitParagraph
  // resolves that tie by SMALLEST AREA — so the neighbour won and the next nudge
  // dragged the wrong box out from under the user.
  let hit = null;
  if (wantBounds) {
    const b = findMovedBlock(cachedGroups(page), wantBounds);
    const para = b && pickPara(b, xPt, yPt);
    if (para) {
      hit = { index: para.index, bounds: para.bounds,
              blockIndex: b.index, blockBounds: b.bounds };
    }
  }
  if (!hit) hit = hitParagraph(page, xPt, yPt);
  if (!hit) { postMessage({ type: "blockMoved", page, ok: false }); return; }

  const dp = mod._malloc(16);
  const moved = F.moveBlock(doc, acquirePage(page), hit.blockIndex, dx, dy, dp);
  const d = readF32(dp, 4);
  mod._free(dp);
  if (moved <= 0) { postMessage({ type: "blockMoved", page, ok: false }); return; }

  dirtyPages.add(page);
  noteMutation(page);
  // The core's dirty rect is the union of the before and after object bounds,
  // so it already covers the vacated strip. Union the block's own box anyway:
  // the box is drawn from grouping bounds, which can be slightly wider than the
  // ink the objects report, and a few unrepainted pixels read as a ghost.
  const bb = hit.blockBounds;
  const strip = (d[2] > d[0] && d[3] > d[1])
    ? [Math.min(d[0], bb[0], bb[0] + dx), Math.min(d[1], bb[1], bb[1] + dy),
       Math.max(d[2], bb[2], bb[2] + dx), Math.max(d[3], bb[3], bb[3] + dy)]
    : [Math.min(bb[0], bb[0] + dx), Math.min(bb[1], bb[1] + dy),
       Math.max(bb[2], bb[2] + dx), Math.max(bb[3], bb[3] + dy)];
  renderDirtyStrip(page, strip);

  // Re-group, then re-select THE BOX THAT MOVED — never merely the box under the
  // drop point (user directive 2026-08-12: "the dragged box must remain selected
  // in every case"). Dropping a large box onto small ones handed the selection to
  // one of the small ones, because the point test prefers the smallest box that
  // contains the point. Identity says the moved box is intact, so we look for its
  // translated rect and only fall back to the point when that fails.
  const blocks = groupPage(page);   // also restores the fresh-open gate
  const dropX = xPt + dx, dropY = yPt + dy;
  const movedBlock = findMovedBlock(blocks,
    [bb[0] + dx, bb[1] + dy, bb[2] + dx, bb[3] + dy]);
  let reHit = null;
  if (movedBlock) {
    // Anchor inside the box we actually moved, so a follow-up nudge re-finds the
    // same box even if the drop point sits over a neighbour.
    const para = pickPara(movedBlock, dropX, dropY);
    if (para) {
      reHit = { index: para.index, bounds: para.bounds,
                blockIndex: movedBlock.index, blockBounds: movedBlock.bounds };
    }
  }
  if (!reHit) reHit = hitParagraph(page, dropX, dropY);
  if (reHit) {
    // The anchor must be inside the SELECTED box: it is what the next move and the
    // next tap resolve from, and the raw drop point can be over a neighbour.
    const rb = reHit.blockBounds;
    const ax = Math.min(Math.max(dropX, rb[0]), rb[2]);
    const ay = Math.min(Math.max(dropY, rb[1]), rb[3]);
    selectedPara = { page, index: reHit.index, bounds: reHit.blockBounds,
                     xPt: ax, yPt: ay };
  } else {
    selectedPara = null;
  }
  postMessage({
    type: "blockMoved",
    page,
    ok: true,
    moved,
    blocks,                                   // the fresh boxes, so no extra round trip
    selection: selectedPara
      ? { index: reHit.index, bounds: reHit.blockBounds,
          blockIndex: reHit.blockIndex, blockBounds: reHit.blockBounds,
          // The CLAMPED anchor, the same one selectedPara holds — reporting the raw
          // drop point would leave the shell and the worker disagreeing about where
          // the selection lives the moment the drop lands over a neighbour.
          xPt: selectedPara.xPt, yPt: selectedPara.yPt }
      : null,
  });
  postHistory();
}

// Open the core editor on the paragraph at page point (xPt, yPt). |lineMode|:
// -1 auto (the core heuristic classifies list-like paragraphs as
// line-preserving), 0 force reflow, 1 force line-preserving. Re-groups only
// when the fresh-open gate demands it, then hit-tests the refreshed cache so
// the index it opens always matches the core's own grouping slot.
// ---- ADD TEXT (docs/ADD_TEXT.md) ---------------------------------------------
//
// An ARMED mode, never a heuristic on an existing tap. tap-on-empty = deselect and
// tap-outside = commit are both load-bearing, so the arm sits in FRONT of the tap
// routing and is CONSUMED by the tap it serves — one placement per arming, which is
// also what makes the host's button state unambiguous.
let addTextArmed = false;
// The host's default look for new text (user decision 2026-08-24: "it will be on host
// how he will provide this data"). Held here rather than passed per placement because
// there is no placement CALL from the host — the gesture is a tap.
let newTextStyle = { fontName: null, sizePt: 0, colorArgb: 0 };

// AN ARM REPORTS ITSELF, ON ARM *AND* ON DISARM (parity rule 14 / I76). A host paints
// its button from this; a spent arm that never reported would leave the button lit and
// the next tap would do something the user did not ask for.
function setAddTextArmed(on) {
  const next = !!on;
  if (next === addTextArmed) return;
  addTextArmed = next;
  postMessage({ type: "addTextArmed", armed: addTextArmed });
}

const SPEC_BYTES = 32;   // PdfeNewBoxSpec: 2 x u32, 3 x f32, ptr, f32, u32

// Place a NEW box at (xPt, yPt) and open it for typing. The shell then behaves exactly
// as it does for any open run — same "editOpened" message, same caret, same blue box —
// because after this call the session IS an ordinary session.
function placeNewBoxAt(page, xPt, yPt) {
  // The core's fresh-open gate wants a current grouping, and its page pin reads it.
  ensureCoreGroup(page);
  const sp = mod._malloc(SPEC_BYTES);
  try {
    const u32v = new Uint32Array(mod.HEAPU8.buffer, sp, 2);
    u32v[0] = SPEC_BYTES;
    u32v[1] = 1;                                   // PDFE_NEW_TEXT
    const f32v = new Float32Array(mod.HEAPU8.buffer, sp + 8, 3);
    f32v[0] = xPt; f32v[1] = yPt;
    f32v[2] = 0;                                   // page-bounded wrap (tap-to-place)
    // The seed FACE resolves through this document's handle map, exactly as a sticky
    // typeface pick does. A name with nothing to resolve to here is not an error — the
    // core falls back to its standard-14 floor, which is the same face on every
    // platform, so the host still gets a predictable result rather than a refusal.
    const h = newTextStyle.fontName
      ? (fontHandles.get(newTextStyle.fontName) || 0) : 0;
    new Uint32Array(mod.HEAPU8.buffer, sp + 20, 1)[0] = h;
    new Float32Array(mod.HEAPU8.buffer, sp + 24, 1)[0] = newTextStyle.sizePt || 0;
    new Uint32Array(mod.HEAPU8.buffer, sp + 28, 1)[0] = (newTextStyle.colorArgb || 0) >>> 0;
    const ed = F.editBeginNew(doc, acquirePage(page), textPageOf(page), sp);
    if (!ed) {
      // The core refuses an off-page point (and a stale grouping). Say so rather than
      // leaving the host wondering why its armed tap did nothing.
      postMessage({ type: "error", code: "add-text-refused", page, xPt, yPt });
      return;
    }
    editor = ed;
    editPage = page;
    // The "am I inside the open run" rect the tap router uses. At zero characters this
    // is the caret's own zero-width box (S66) — a later tap is therefore outside it and
    // commits, which is right: an empty box the user taps away from evaporates.
    const c0 = readCaret(-1);
    editParaBounds = c0 ? [c0[0], c0[2], c0[0], c0[1]] : [xPt, yPt, xPt, yPt];
    // A fresh session carries no pick in flight, for the same reason openEditorAt
    // clears these: an armed index names a spot in a run that no longer exists.
    typingColorArmedAt = -1;
    typingFontArmedAt = -1;
    typingFontArmedName = null;
    postMessage({
      type: "editOpened",
      page,
      paraIndex: -1,          // it owns no paragraph in the cached grouping yet…
      blockIndex: -1,         // …and no block, so there is no faint box to hide
      // CREATED, rather than a second event firing at the same moment as this one and
      // carrying nothing it lacks. A host that wants to know "this is a NEW box" reads
      // the flag; everything else about entering edit mode is already this message.
      created: true,
      text: "",
      caretIndex: 0,
      caret: readCaret(0),
      runBounds: readRunBounds(0),
      isParagraph: F.editIsPara(editor) === 1,
      linePreserve: F.editLineMode(editor) === 1,
      style: readRangeStyle(0, 0),
    });
  } finally {
    mod._free(sp);
  }
}

function openEditorAt(page, xPt, yPt, lineMode) {
  ensureCoreGroup(page);
  const hit = hitParagraph(page, xPt, yPt);
  if (!hit) return;
  // ANDROID PARITY (user directive 2026-07-31, block model): the BOX is the
  // edit unit — open the whole BLOCK as one buffer ('\n' separates its
  // paragraphs; the core rewraps only the paragraph the caret is in). The
  // caret still lands on the tapped glyph via editBoundary over the block
  // buffer. This was the last per-paragraph opener; the boxes, selection and
  // identity-hide were already block-scoped.
  const ed = F.editBeginBlock(doc, acquirePage(page), textPageOf(page),
                              hit.blockIndex, lineMode);
  if (!ed) return;
  editor = ed;
  editPage = page;
  editParaBounds = hit.blockBounds;
  // A fresh session starts with no pick in flight — a pending same-index
  // revival must never leak across sessions (the index would name a spot in a
  // different run).
  typingColorArmedAt = -1;
  // A FOLLOW-mode font pick is session-scoped, for the same reason colour's is: the
  // armed INDEX names a spot in a run that no longer exists.
  typingFontArmedAt = -1;
  typingFontArmedName = null;
  // ...but a STICKY pick is deliberately NOT session-scoped: re-arm it on the new
  // session so typing in this box takes the colour the host still shows.
  if (!typingColorFollowsCaret && stickyColorArgb != null)
    F.editSetTypingColor(editor, stickyColorArgb >>> 0, 1);
  const text = readEditorText();
  const caretIdx = F.editBoundary(editor, xPt, yPt);
  // THE SAME FOR A STICKY TYPEFACE, and the two halves re-arm differently on purpose:
  //   * a FAMILY is a host-named face, so it resolves through this document's handle
  //     map exactly as the original pick did. A name with no handle in THIS document
  //     is skipped rather than errored — the host's pick is not wrong, it just has
  //     nothing to resolve to here, and the style report will tell the truth.
  //   * a FACE (B/I) has no name to resolve: the core picks bold/italic against the
  //     family the caret is in, which differs per box. So the INTENT is replayed
  //     through the same collapsed apply_face the button uses, and a family with no
  //     such face is skipped SILENTLY — a refusal here belongs to no gesture the user
  //     just made, and emitting one on box-open would be noise (docs/STYLING.md §2bis).
  if (!typingFontFollowsCaret) {
    if (stickyFontName !== null) {
      const h = stickyFontName ? (fontHandles.get(stickyFontName) || 0) : 0;
      if (h || !stickyFontName) F.editSetTypingFont(editor, h);
    } else if (stickyFace) {
      const dPtr = mod._malloc(16);
      F.editApplyFace(editor, caretIdx, caretIdx,
                      stickyFace.bold ? 1 : 0, stickyFace.italic ? 1 : 0, dPtr);
      mod._free(dPtr);
    }
  }
  postMessage({
    type: "editOpened",
    page,
    paraIndex: hit.index,        // the paragraph being edited
    blockIndex: hit.blockIndex,  // the shell hides THIS block's faint box
    text,
    caretIndex: caretIdx,
    caret: readCaret(caretIdx),
    runBounds: readRunBounds(text.length) || hit.blockBounds, // the blue editing box
    isParagraph: F.editIsPara(editor) === 1,
    linePreserve: F.editLineMode(editor) === 1,
    // THE STYLE AT THE CARET THE USER JUST PLACED — not at the start of the run.
    // Opening a run is a deliberate cursor placement like any other, so it owes
    // the host the same answer a caret move does. A host that instead asked for
    // the style at index 0 painted its swatch with the FIRST word's colour: colour
    // that word red, double-click into the middle of the box, and the toolbar said
    // red while typing correctly produced black.
    style: readRangeStyle(caretIdx, caretIdx),
  });
}

// ---- tier-2 lazy load (docs/WEB_IO.md §3) --------------------------------------
// Large files never enter the heap wholesale: pdfe_open_custom makes PDFium
// pull byte ranges through the io_shim trampoline into globalThis.pdfeReadBlock,
// which serves them from an ALIGNED LRU BLOCK CACHE over the source Blob.
// FileReaderSync is the only synchronous way to read a user's file in a
// browser, and (like the OPFS save handle) exists only in dedicated workers.
// The cache is mandatory, not an optimization: PDFium issues many small reads
// while parsing and per-call slice+read overhead is brutal (§9).
const TIER2_MIN = 50 * 1024 * 1024;   // ≥ 50 MB loads lazily (§3 threshold)
const CACHE_BYTES = 32 * 1024 * 1024; // block-cache ceiling (block count follows)
// 256 KB blocks, MEASURED (§3 table, 110 MB/125-page fixture in Chrome): a
// PDF's objects are scattered, so big blocks fetch mostly bytes nobody asked
// for — 2 MB blocks pulled 332 MB off the Blob where 256 KB pulled 140 MB,
// and were slower at every stage. The CACHE is what's mandatory, not big blocks.
let BLOCK = 256 * 1024;
let MAX_BLOCKS = CACHE_BYTES / BLOCK; // LRU depth (128 blocks)

let sourceBlob = null;   // MUST outlive the doc: FPDF_SaveAsCopy re-reads it
let sourceSize = 0;
let loadTier = 0;
let reader = null;                    // FileReaderSync (worker-only)
const blocks = new Map();             // blockIndex -> Uint8Array; Map order == LRU
const ioStat = { calls: 0, bytes: 0, reads: 0, readBytes: 0, evictions: 0 };

function sourceBlock(i) {
  const hit = blocks.get(i);
  if (hit) { blocks.delete(i); blocks.set(i, hit); return hit; }   // LRU touch
  const start = i * BLOCK;
  const len = Math.min(BLOCK, sourceSize - start);
  const buf = new Uint8Array(reader.readAsArrayBuffer(sourceBlob.slice(start, start + len)));
  ioStat.reads++; ioStat.readBytes += len;
  blocks.set(i, buf);
  if (blocks.size > MAX_BLOCKS) { blocks.delete(blocks.keys().next().value); ioStat.evictions++; }
  return buf;
}

// THE read trampoline (wasm/io_shim.cpp calls this by global name). Returns 1
// only when ALL |len| bytes landed in the heap at |ptr|.
globalThis.pdfeReadBlock = (offset, ptr, len) => {
  if (!sourceBlob || offset < 0 || offset + len > sourceSize) return 0;
  ioStat.calls++; ioStat.bytes += len;
  let done = 0;
  while (done < len) {
    const pos = offset + done;
    const bi = Math.floor(pos / BLOCK);
    const within = pos - bi * BLOCK;
    const blk = sourceBlock(bi);
    const n = Math.min(len - done, blk.length - within);
    if (n <= 0) return 0;
    // Re-derive the heap view for EVERY chunk: a growing heap detaches views
    // (docs/WASM_BUILD.md) — the same rule as the save trampoline.
    mod.HEAPU8.set(blk.subarray(within, within + n), ptr + done);
    done += n;
  }
  return 1;
};

// ---- streaming save (docs/WEB_IO.md §5–§7) -------------------------------------
// pdfe_save emits sequential ~32 KB chunks SYNCHRONOUSLY through the io_shim
// trampoline into globalThis.pdfeSaveWrite. Primary sink: an OPFS
// FileSystemSyncAccessHandle (the only synchronous write target browsers have;
// dedicated-worker-only) — memory stays chunk-flat like Android's SAF fd.
// Fallback (Safari private mode: no OPFS): accumulate chunks in JS memory.
let saveHandle = null;   // live OPFS sync handle during a save
let savePos = 0;
let saveChunks = null;   // fallback accumulation
let opfsOk = false;      // probed once at startup; drives the shell's warning UI

const SAVE_STAGING = "save-staging.pdf";
const SAVE_PROBE = "opfs-probe.tmp";
// Hard ceiling for the in-heap fallback (§7): without OPFS the whole output
// accumulates in JS memory ON TOP of PDFium's parsed objects — the ~3x
// residency of §2. Past this we refuse rather than crash the tab mid-save.
const IN_HEAP_MAX = 250 * 1024 * 1024;

// Can this browser stream a save? Also reaps an orphaned staging file (a tab
// killed mid-save leaves one, and OPFS counts against origin quota — §9).
// Safari private browsing has no OPFS at all, so this is the §7 fallback
// trigger — detected UP FRONT, not by failing halfway through a save.
async function probeOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(SAVE_STAGING).catch(() => {});
    const probe = await root.getFileHandle(SAVE_PROBE, { create: true });
    const h = await probe.createSyncAccessHandle();   // the capability that matters
    h.close();
    await root.removeEntry(SAVE_PROBE).catch(() => {});
    return true;
  } catch (e) {
    return false;
  }
}

globalThis.pdfeSaveWrite = (ptr, size) => {
  // Re-derive the heap view EVERY chunk: PDFium may allocate (and grow the
  // heap, detaching views) between WriteBlock calls (§9).
  const view = new Uint8Array(mod.HEAPU8.buffer, ptr, size);
  if (saveHandle) {
    let off = 0;
    while (off < size) {  // short-write loop; success only when ALL bytes land
      const n = saveHandle.write(off ? view.subarray(off) : view, { at: savePos + off });
      if (!n) return 0;
      off += n;
    }
    savePos += size;
    return 1;
  }
  if (saveChunks) { saveChunks.push(view.slice()); return 1; }
  return 0;
};

async function saveDocument(forceInHeap) {
  if (!doc) { postMessage({ type: "error", detail: "no document" }); return; }
  // Backstop for §7's "large-file saving is simply not offered" rule: the
  // shell warns, but the worker is what actually refuses — a shell bug must
  // not be able to OOM the tab.
  if ((!opfsOk || forceInHeap) && sourceSize > IN_HEAP_MAX) {
    postMessage({
      type: "saveRefused", reason: "in-heap-too-large",
      sizeMB: Math.round(sourceSize / (1024 * 1024)),
      limitMB: IN_HEAP_MAX / (1024 * 1024),
    });
    return;
  }
  // Finalize any live edit first (the Android startSave analog), then flush
  // every page with un-flushed preview edits (pdfe_save does not flush).
  if (editor) commitEditor();
  for (const p of dirtyPages) F.generateContent(acquirePage(p));
  dirtyPages.clear();

  const t0 = performance.now();
  let fileHandle = null;
  let flat = false;
  try {
    if (forceInHeap) throw new Error("forced in-heap (dev knob)");
    const root = await navigator.storage.getDirectory();
    fileHandle = await root.getFileHandle(SAVE_STAGING, { create: true });
    saveHandle = await fileHandle.createSyncAccessHandle();
    saveHandle.truncate(0);
    savePos = 0;
    flat = true;
  } catch (e) {
    // No OPFS sync handle (Safari private mode / old browser): in-heap
    // fallback with a UI warning (§7). Flat memory is lost in this mode only.
    saveHandle = null;
    saveChunks = [];
  }

  const written = F.wasmSave(doc);
  let file = null;
  if (flat) {
    saveHandle.flush();   // the fsync analog — durable before we report success
    saveHandle.close();
    saveHandle = null;
    if (written >= 0) file = await fileHandle.getFile();   // OPFS-backed File: streams from disk
  } else {
    if (written >= 0) file = new File(saveChunks, "edited.pdf", { type: "application/pdf" });
    saveChunks = null;
  }
  const ms = Math.round(performance.now() - t0);
  if (written < 0 || !file) {
    postMessage({ type: "error", detail: "save failed" });
    return;
  }
  // HISTORY IS CLEARED ON SAVE (user decision 2026-08-03). The core does not do
  // it inside pdfe_save — that function's semantics are frozen, and it is also
  // the export path — so every shell must call this here. The parity gate's
  // required-command list is what keeps a shell from forgetting.
  F.historyClear(doc);
  postHistory(true);
  // A Blob/File clones as a reference — delivery (object-URL download /
  // showSaveFilePicker) is the main thread's job (§6).
  postMessage({
    type: "saved", bytes: written, ms, file, flat,
    tier: loadTier,
    io: { ...ioStat },   // tier 2: the source re-reads SaveAsCopy did
    heapMB: Math.round((mod.HEAPU8.length / (1024 * 1024)) * 10) / 10,
  });
}

// ---- single-flight, newest-wins latch (docs/WEB_VIEWER.md §9) ----------------
// One drain tick per animation frame. Priorities inside a drain:
//   1. the newest pending edit (keystrokes preempt everything)
//   2. base-page paints, NEWEST-first (the page under the viewport right now)
//   3. sharp tiles (budgeted slice)
//   4. at most ONE grouping job (they cost 100-250 ms on dense pages)
// Paints and groups became latch jobs for 7000-page documents: both used to
// run synchronously in the message handler, so a fast scroll queued seconds of
// work in front of every tap — and grouping ahead of later pages' paints is
// exactly why faint boxes could appear before the text they box.
let pendingEdit = null;   // newest {fullText, caretIndex, generation, postedAt}
const paintQueue = [];    // LIFO of {page, gen, w, h, scale} — newest wins
const tileQueue = [];     // FIFO of {page, gen, scale, x, y, w, h}
const groupQueue = [];    // FIFO of pageIndex
const groupQueued = new Set();
let latchScheduled = false;
let lastEditPass = -1e9;  // when the last engine pass ran (worker clock)

// Enqueue a grouping job (deduped). Cache hits reply immediately instead.
function requestGroupJob(page) {
  if (groupQueued.has(page)) return;
  groupQueued.add(page);
  groupQueue.push(page);
  scheduleLatch();
}

function scheduleLatch() {
  if (latchScheduled) return;
  latchScheduled = true;
  // Prefer the frame tick (one engine pass per frame, §9) — but worker rAF
  // STALLS whenever the canvases aren't compositing (hidden/undisplayed tab),
  // which would freeze tile fills and edit echoes. The timeout backstop keeps
  // the latch draining regardless; the `fired` guard makes them race safely.
  let fired = false;
  const run = () => { if (fired) return; fired = true; drainLatch(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  // Edits get a frame-length backstop so keystroke latency never depends on
  // compositing; idle tile fills can wait the long backstop.
  setTimeout(run, pendingEdit ? 16 : 100);
}

function drainLatch() {
  latchScheduled = false;
  // 1) Newest pending edit first (preempts tile work).
  if (pendingEdit) {
    const edit = pendingEdit;
    pendingEdit = null;
    if (editor) {
      lastEditPass = performance.now();
      dirtyPages.add(editPage);   // in-memory mutation; flushed at commit/save
      noteMutation(editPage);     // grouping gate broken; this page's boxes stale
      // THE engine pass: one waist crossing (pdfe_edit_set_text with the
      // dirty-rect out-param), then re-render ONLY the dirty strip, then the
      // caret (and selection) geometry back to the main thread.
      // postedAt is echoed VERBATIM: performance.now() origins differ between
      // worker and main thread — the main thread closes the loop on ONE clock.
      const dPtr = mod._malloc(16);
      const t0 = performance.now();
      withU16(edit.fullText, (tPtr) =>
        F.editSetText(editor, tPtr, edit.fullText.length, edit.caretIndex, dPtr));
      const engineMs = performance.now() - t0;
      const dirty = readF32(dPtr, 4);
      mod._free(dPtr);
      // I9 hardening: editParaBounds is captured at OPEN, but an edit can grow
      // the paragraph past it (reflow adding a line, text extending a line).
      // A reposition tap just past the stale edge would then take the
      // commit-then-reopen path mid-typing. Union in each edit's dirty rect so
      // the tap routing tracks the live extent. (Shrink is left alone: a tap
      // in the vacated area still routes to a caret move, which the core
      // clamps to the nearest boundary — harmless.)
      if (editParaBounds && dirty[2] > dirty[0] && dirty[3] > dirty[1]) {
        editParaBounds = [
          Math.min(editParaBounds[0], dirty[0]),
          Math.min(editParaBounds[1], dirty[1]),
          Math.max(editParaBounds[2], dirty[2]),
          Math.max(editParaBounds[3], dirty[3]),
        ];
      }
      syncEditTextPage();
      // I69: THE ENGINE MAY HAVE REFUSED SOME OF WHAT WE SENT. Anything no font in
      // reach can draw is dropped rather than written, because writing it produces a
      // DIFFERENT character (an emoji came back as U+00FF, and saved that way). So
      // the engine's buffer — not `edit.fullText` — is the truth from here on: the
      // shell re-seeds its sink from it, and everything measured below is measured
      // over it.
      const rejected = readLastRejected();
      const engineText = rejected ? readEditorText() : edit.fullText;
      const blitMs = renderDirtyStrip(editPage, dirty);
      const hasSel = edit.selEnd > edit.selStart;
      const sel = hasSel ? readSelectionRects(edit.selStart, edit.selEnd) : [];
      postMessage({
        type: "editApplied",
        generation: edit.generation,
        page: editPage,
        caret: readCaret(-1),
        selection: sel,
        // THE KNOBS' GEOMETRY, and it has to travel with an ordinary edit too.
        // Shift+arrow does NOT go through selectRange/selectWord — the sink's
        // own selection moves and the shell mirrors it as a plain "edit" — so
        // this was the only reply that could carry the new handle positions.
        // Without them the highlight grew while the knobs stayed where the
        // double-tap had left them (QA 2026-08-07, web only).
        // The range is echoed back because the shell must re-arm _selRange for a
        // subsequent knob DRAG, which resolves against it.
        h0: hasSel ? readCaret(edit.selStart) : null,
        h1: hasSel ? readCaret(edit.selEnd) : null,
        selStart: edit.selStart,
        selEnd: edit.selEnd,
        runBounds: readRunBounds(engineText.length),      // the blue editing box
        // Present ONLY when the engine refused something (I69), so a host can say
        // "emoji aren't supported here" instead of leaving the user pressing a dead
        // key. |text| rides along on the same condition: the sink still holds the
        // character the engine dropped, and re-seeding is what makes the refusal
        // stick instead of being re-sent on the next keystroke.
        ...(rejected ? { rejected, text: engineText,
                         caretIndex: F.editCaretIndex(editor) } : {}),

        engineMs: Math.round(engineMs * 100) / 100,
        blitMs: Math.round(blitMs * 100) / 100,
        postedAt: edit.postedAt,
      });
      // The core recorded this pass as an undo step (or skipped it, if the
      // buffer was unchanged — an ArrowLeft/Right re-post does that). Deduped,
      // so a typing burst produces at most one history event.
      postHistory();
    } else {
      // No open session: keep the echo so the pipe stays observable.
      postMessage({
        type: "editEcho",
        generation: edit.generation,
        chars: edit.fullText.length,
        caretIndex: edit.caretIndex,
        postedAt: edit.postedAt,
      });
    }
  }
  // 2) Base-page paints, newest-first: during a fast scroll the page under the
  // viewport RIGHT NOW paints before pages already flung past (whose queued
  // jobs an evict or a newer paint invalidated via the generation bump).
  const paintEnd = performance.now() + 12;
  while (paintQueue.length && performance.now() < paintEnd) {
    const job = paintQueue.pop();
    if (paintGen.get(job.page) !== job.gen) continue; // superseded or evicted
    paintPage(job);
  }
  // 3) Then a budgeted slice of tile fills (skip jobs a newer paint outdated).
  const budgetEnd = performance.now() + 8; // ~half a frame; stay responsive
  while (tileQueue.length && performance.now() < budgetEnd) {
    const job = tileQueue.shift();
    if (paintGen.get(job.page) !== job.gen) continue; // stale: a newer paint won
    const canvas = canvases.get(job.page);
    if (!canvas || !doc) continue;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const t0 = performance.now();
    blitRegion(ctx, acquirePage(job.page), job.scale, job.x, job.y, job.w, job.h);
    postMessage({
      type: "tile",
      page: job.page,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      left: tileQueue.length,
    });
  }
  // 4) At most ONE grouping job per drain — they are the most expensive unit
  // of work here (a dense page groups in 100-250 ms) and boxes are the least
  // urgent pixels: text always lands first now, never after the boxes.
  if (!pendingEdit && !paintQueue.length && !tileQueue.length && groupQueue.length) {
    const page = groupQueue.shift();
    groupQueued.delete(page);
    if (doc && canvases.has(page)) {
      postMessage({ type: "groups", page, blocks: cachedGroups(page),
                    images: cachedImages(page) });
    }
  }
  if (tileQueue.length || paintQueue.length || groupQueue.length || pendingEdit) {
    scheduleLatch();
  }
}

// ---- tiled page paint (docs/WEB_VIEWER.md §5) ---------------------------------
// Base layer first (instant, blurry), then 768px sharp tiles through the latch.
// Runs from the latch drain — |job| carries the generation stamped when the
// paint was REQUESTED, so an evict or a newer request silently retires it.
function paintPage(job) {
  const { page, w, h, scale } = job;
  const canvas = canvases.get(page);
  if (!canvas || !doc) return;
  const gen = job.gen;
  pageScale.set(page, scale);   // dirty-strip renders reuse the paint scale
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const handle = acquirePage(page);

  // Base layer: one cheap low-res full-page render, scaled up by the canvas.
  const t0 = performance.now();
  const baseF = Math.min(1, BASE_MAX / Math.max(w, h));
  const bw = Math.max(1, Math.round(w * baseF));
  const bh = Math.max(1, Math.round(h * baseF));
  const ptr = poolBuf(bw * bh * 4);
  F.render(handle, ptr, bw, bh, bw * 4, PDFE_RENDER_RGBA);
  const view = new Uint8ClampedArray(mod.HEAPU8.buffer, ptr, bw * bh * 4);
  const staging = new OffscreenCanvas(bw, bh);
  staging.getContext("2d").putImageData(new ImageData(view, bw, bh), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(staging, 0, 0, bw, bh, 0, 0, w, h);
  const baseMs = Math.round((performance.now() - t0) * 10) / 10;

  // Sharp tiles: enqueue with seam overlap; the latch fills them async.
  let tiles = 0;
  for (let ty = 0; ty < h; ty += TILE) {
    for (let tx = 0; tx < w; tx += TILE) {
      const x = Math.max(0, tx - TILE_OVERLAP);
      const y = Math.max(0, ty - TILE_OVERLAP);
      const tw = Math.min(w, tx + TILE + TILE_OVERLAP) - x;
      const th = Math.min(h, ty + TILE + TILE_OVERLAP) - y;
      tileQueue.push({ page, gen, scale, x, y, w: tw, h: th });
      tiles++;
    }
  }
  postMessage({ type: "painted", page, baseMs, tiles });
  scheduleLatch();
}

onmessage = async (e) => {
  await ready;
  const msg = e.data;

  if (msg.type === "open") {
    selectedPara = null;   // the shell resets its own overlay state in open()
    if (doc) { // abandon any edit + close text pages/pages first, then the doc
      if (editor) {
        const tp = F.editCancel(editor);
        if (tp) textPages.set(editPage, tp);
        editor = 0; editPage = -1; editParaBounds = null;
      }
      for (const tp of textPages.values()) F.closeTextPage(tp);
      textPages.clear();
      for (const p of pageHandles.values()) F.closePage(p);
      pageHandles.clear(); canvases.clear(); paintGen.clear(); pageScale.clear();
      tileQueue.length = 0; paintQueue.length = 0; pendingEdit = null;
      groupQueue.length = 0; groupQueued.clear(); groupCache.clear(); imageCache.clear();
      flowGroups = []; flowRedoGroups = [];   // the flow stacks died with the document
      coreGroupedPage = -1; coreGroupFresh = false; dirtyPages.clear();
      // Font handles are DOCUMENT-owned (pdfe_close_doc frees them), so the registry
      // must not outlive the doc — a stale handle applied to the next file is a
      // use-after-free. A host re-registers its faces after opening.
      fontHandles.clear();
      F.closeDoc(doc); doc = 0; pages.length = 0;
      // Only now may the old source go: the doc read from it until this point.
      sourceBlob = null; sourceSize = 0; blocks.clear();
    }
    // The document always arrives as a Blob/File. Tier is chosen by SIZE (§3);
    // msg.tier forces one for testing. The Blob is kept for the whole session
    // either way — tier 2 REQUIRES it (save re-reads the source through it).
    sourceBlob = msg.blob;
    sourceSize = sourceBlob.size;
    blocks.clear();
    for (const k of Object.keys(ioStat)) ioStat[k] = 0;
    loadTier = msg.tier || (sourceSize >= TIER2_MIN ? 2 : 1);
    if (msg.blockKB) {   // dev knob (?block=): re-measure the §3 tradeoff
      BLOCK = msg.blockKB * 1024;
      MAX_BLOCKS = Math.max(4, Math.floor(CACHE_BYTES / BLOCK));
    }
    const tOpen = performance.now();
    // msg.password is undefined for the overwhelming majority of documents; both
    // tiers take it because encryption is a property of the FILE, not its size.
    if (loadTier === 2) {
      // Lazy: nothing but PDFium's parsed structures + the block cache in heap.
      reader = reader || new FileReaderSync();
      doc = withUtf8(msg.password, (pw) => F.openCustom(sourceSize, pw));
    } else {
      // Eager: ONE full copy into the heap, pinned until pdfe_close_doc (the
      // FPDF_LoadMemDocument rule, owned inside the core). Hand it over with
      // the ADOPTING entry point — pdfe_open_mem would copy it a second time,
      // doubling peak heap for nothing (this is what Android's JNI does too).
      const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
      const ptr = mod._malloc(bytes.length);
      mod.HEAPU8.set(bytes, ptr);
      // core frees it, incl. on failure — so a wrong password does NOT leak the
      // document, and the retry with the right one starts from a clean heap.
      doc = withUtf8(msg.password, (pw) => F.openMemOwned(ptr, bytes.length, pw));
    }
    const openMs = Math.round(performance.now() - tOpen);
    if (!doc) {
      // Say WHY, so the shell can raise a password prompt instead of a dead end.
      // The source Blob is dropped: nothing was opened from it, and holding a
      // File the host may replace on the retry only invites a stale save.
      const err = F.lastOpenError();
      sourceBlob = null; sourceSize = 0; blocks.clear();
      postMessage({ type: "openFailed", code: openErrorCode(err), err });
      return;
    }
    // ⚠️ HISTORY IS ON IN THIS BUILD, for testing true text undo (user request
    // 2026-08-05). It is normally OPT-IN and OFF, and whether it ships on is the
    // user's call, NOT a side effect of this workstream — decide it before any
    // release (docs/RELEASING.md) and remember what "on" now costs: a recorded
    // edit PARKS the objects it replaces instead of destroying them, so the page
    // accumulates inactive objects until the journal is cleared. Must be enabled
    // BEFORE the first edit — enabling later starts an empty journal.
    F.historySetEnabled(doc, 1);
    // DOCUMENT REFLOW, opt-in per open. Enabling BUILDS THE MODEL, which groups every
    // page — so it must happen here, before anything is edited: grouping moves the
    // identity scope, and doing it later would wipe the pin the edit session is relying
    // on. It also arms doc-wide id allocation, which has to precede the first mint.
    flowOn = !!msg.documentReflow;
    if (flowOn) {
      const t0 = performance.now();
      const built = F.flowEnable(doc, 1);
      // The build left the core's one-slot grouping pointing at the LAST page it
      // touched, so our own cache must not believe it holds page 0.
      coreGroupedPage = -1; coreGroupFresh = false;
      groupCache.clear(); imageCache.clear();
      for (const tp of textPages.values()) F.closeTextPage(tp);
      textPages.clear();
      flowOn = built === 1;
      console.log(`[pdfe] documentReflow: model ${flowOn ? "built" : "FAILED"} in ` +
                  `${Math.round(performance.now() - t0)} ms`);
    }
    const n = F.pageCount(doc);
    const dims = mod._malloc(8);
    // Measure WITHOUT loading pages: FPDF_LoadPage makes the document retain
    // that page's parsed objects (its images included) forever, so laying out
    // an image-heavy 110 MB file this way cost 104 MB of heap — measured
    // 2026-07-27, and it defeated the whole point of the lazy tier.
    for (let i = 0; i < n; i++) {
      F.pageSizeAt(doc, i, dims, dims + 4);
      const v = new Float32Array(mod.HEAPU8.buffer, dims, 2);
      pages.push({ w: v[0], h: v[1] });
    }
    mod._free(dims);
    postMessage({
      type: "opened",
      pages: pages.slice(),
      tier: loadTier,
      bytes: sourceSize,
      openMs,
      io: { ...ioStat },
      heapMB: Math.round((mod.HEAPU8.length / (1024 * 1024)) * 10) / 10,
    });
    // A new document is a new (empty) history. Forced, because the previous
    // document may have left the shell's buttons enabled.
    lastHistory = "";
    postHistory(true);
    // THE CANONICAL SET, on every open, without being asked. Font handles died with the
    // previous document (fontHandles.clear() above), so this is per document. Started
    // AFTER "opened" is posted and deliberately not awaited: a page must not wait on
    // ~1.7 MB of faces to become interactive, and the only capability missing in that
    // window is bold/italic on Calibri and Cambria — every other family is served by
    // engine built-ins, which need no fetch at all.
    bundledFonts = { state: "none", families: [], failed: [] };
    registerBundledFonts();
    return;
  }

  if (msg.type === "attach") {
    canvases.set(msg.page, msg.canvas);
    return;
  }

  if (msg.type === "paint") {
    // scale = device pixels per PDF point, decided by the main thread. Just
    // enqueue: the render itself runs through the latch, so a burst of paint
    // requests from a fast scroll can never wall off taps and edits.
    const gen = (paintGen.get(msg.page) || 0) + 1;
    paintGen.set(msg.page, gen);
    paintQueue.push({ page: msg.page, gen, w: msg.w, h: msg.h, scale: msg.scale });
    scheduleLatch();
    return;
  }

  if (msg.type === "evict") {
    // The shell noticed this page left the keep window: retire its queued
    // work, free its canvas bitmap (a full-page RGBA canvas is megabytes —
    // 7000-page documents CANNOT keep every visited page's pixels), and close
    // its handles. The edit page and dirty pages keep everything (see the LRU
    // note at the top); the canvas keeps its CSS size, so layout never moves.
    const page = msg.page;
    if (page === editPage || dirtyPages.has(page)) return;
    paintGen.set(page, (paintGen.get(page) || 0) + 1);   // retire queued jobs
    pageScale.delete(page);
    const canvas = canvases.get(page);
    if (canvas && canvas.width > 1) { canvas.width = 1; canvas.height = 1; }
    closePageHandles(page);
    return;
  }

  if (msg.type === "stats") {
    // Dev/harness telemetry (the large-document tests read this).
    postMessage({
      type: "stats",
      openPages: pageHandles.size, textPages: textPages.size,
      groupsCached: groupCache.size, dirtyPages: dirtyPages.size,
      groupKeys: [...groupCache.keys()].slice(0, 20),
      coreGroupedPage, coreGroupFresh,
      paintQueue: paintQueue.length, tileQueue: tileQueue.length,
      groupQueue: groupQueue.length,
      heapMB: Math.round((mod.HEAPU8.length / (1024 * 1024)) * 10) / 10,
    });
    return;
  }

  if (msg.type === "edit") {
    // Typing consumes the pick's moment: after a keystroke the caret has moved
    // by insertion, so "the index the pick was armed at" no longer names the
    // user's spot. The override itself lives on (typing never clears it) —
    // only the same-index revival stops applying.
    typingColorArmedAt = -1;
    typingFontArmedAt = -1;   // same reason; the armed FACE itself lives on
    // Newest-wins: overwrite any not-yet-drained edit (§9).
    pendingEdit = {
      fullText: msg.fullText,
      caretIndex: msg.caretIndex,
      selStart: msg.selStart ?? msg.caretIndex,
      selEnd: msg.selEnd ?? msg.caretIndex,
      generation: msg.generation,
      postedAt: msg.postedAt,
    };
    // Latency: if no engine pass ran within this frame, drain NOW — the wait
    // for the next frame tick would dominate keystroke→blit for a human typing
    // cadence. Faster-than-frame bursts still coalesce via the scheduled tick
    // (single-flight, newest-wins — §9's one-pass-per-frame cap is preserved).
    if (performance.now() - lastEditPass > 12) drainLatch();
    else scheduleLatch();
    return;
  }

  if (msg.type === "tap") {
    // Renderer-as-editor tap routing (the Android onTapParagraph analog, all
    // in the worker where the state lives): a tap INSIDE the open paragraph
    // moves the caret; anywhere else commits, then the hit paragraph is
    // SELECTED (not opened — select-then-act). Tapping the already-selected
    // paragraph a second time is the shortcut into editing.
    if (!doc) return;
    // ADD TEXT: the arm outranks every branch below and is CONSUMED here. Placed
    // before the "inside the open run" test on purpose — while armed, a tap means
    // "put a box here", even if it lands inside the box being edited.
    if (addTextArmed) {
      setAddTextArmed(false);            // spent, and reported spent
      if (editor) commitEditor();        // tap-outside-commits still holds
      clearSelection();
      placeNewBoxAt(msg.page, msg.xPt, msg.yPt);
      return;
    }
    if (editor && msg.page === editPage && editParaBounds &&
        msg.xPt >= editParaBounds[0] && msg.xPt <= editParaBounds[2] &&
        msg.yPt >= editParaBounds[1] && msg.yPt <= editParaBounds[3]) {
      const idx = F.editBoundary(editor, msg.xPt, msg.yPt);
      postCaretMoved(idx);
      return;
    }
    if (editor) commitEditor();   // tap outside / another paragraph: commit first
    const item = hitItem(msg.page, msg.xPt, msg.yPt);   // cached bounds: instant
    if (!item) { clearSelection(); return; }   // empty space: just deselect
    if (item.kind === "image") {
      // A picture has no second-tap-to-edit: there is nothing to open. Tapping
      // the selected one again simply keeps it selected.
      const same = selectedImage && selectedImage.page === msg.page &&
                   selectedImage.index === item.image.index;
      if (!same) { clearSelection(); selectImage(msg.page, item.image); }
      return;
    }
    const hit = item.para;
    const again = selectedPara &&
      selectedPara.page === msg.page && selectedPara.index === hit.index;
    clearSelection();
    if (again) {
      openEditorAt(msg.page, msg.xPt, msg.yPt, -1);   // re-groups only if the gate demands
    } else {
      selectPara(msg.page, hit, msg.xPt, msg.yPt);
      // Warm the core's one-slot grouping in the background so the Edit /
      // Delete that usually follows a select doesn't pay the re-group.
      if (coreGroupedPage !== msg.page || !coreGroupFresh) requestGroupJob(msg.page);
    }
    return;
  }

  if (msg.type === "openSelected") {
    // The shell's Edit action: open the selected paragraph, caret at the point
    // it was selected at. Re-resolved from a fresh grouping (the index may have
    // shifted since selection) — same routing a tap takes.
    if (!doc || !selectedPara) return;
    const { page, xPt, yPt } = selectedPara;
    clearSelection();
    if (editor) commitEditor();
    openEditorAt(page, xPt, yPt, -1);
    return;
  }

  if (msg.type === "deleteSelected") {
    if (!doc) return;
    // ROUTED BY WHAT IS SELECTED, deliberately reusing the ONE message rather
    // than adding a second: "delete what I picked" is the same host intent
    // either way, and a new bridge command would be surface every shell has to
    // learn for no gain. A picture and a paragraph can never both be selected
    // (selecting either clears the other), so there is no ambiguity to resolve.
    if (selectedImage) { deleteSelectedImage(); return; }
    if (!selectedPara) return;
    const { page, xPt, yPt } = selectedPara;
    clearSelection();
    deleteParagraphAt(page, xPt, yPt);
    return;
  }

  if (msg.type === "deselect") {
    clearSelection();
    return;
  }

  // ---- IMAGE EDIT (docs/IMAGE_EDIT.md) -------------------------------------
  if (msg.type === "moveImage") {
    if (!doc || !selectedImage) { postMessage({ type: "imageMoved", ok: false }); return; }
    moveSelectedImage(Number(msg.dx) || 0, Number(msg.dy) || 0);
    return;
  }
  if (msg.type === "rotateImage") {
    if (!doc || !selectedImage) { postMessage({ type: "imageRotated", ok: false }); return; }
    rotateSelectedImage(Number(msg.turns) || 0);
    return;
  }
  if (msg.type === "imageMoveLimits") {
    if (!doc || !selectedImage) return;
    ensureCoreGroup(selectedImage.page);
    const lp = mod._malloc(16);
    const ok = F.imageMoveLimits(doc, acquirePage(selectedImage.page),
                                 selectedImage.index, lp);
    const limits = ok ? readF32(lp, 4) : null;
    mod._free(lp);
    if (limits) postMessage({ type: "moveLimits", limits });
    return;
  }

  // ---- ADD TEXT ------------------------------------------------------------
  if (msg.type === "armAddText") { setAddTextArmed(true); return; }
  if (msg.type === "cancelAddText") { setAddTextArmed(false); return; }
  if (msg.type === "setNewTextStyle") {
    // Every field is optional and independent, so a host can set only the colour and
    // leave the face and size on the core's floor. null/0 means "not specified".
    if ("fontName" in msg) newTextStyle.fontName = msg.fontName || null;
    if ("sizePt" in msg) newTextStyle.sizePt = Number(msg.sizePt) || 0;
    if ("colorArgb" in msg)
      newTextStyle.colorArgb = msg.colorArgb == null ? 0 : (msg.colorArgb >>> 0);
    return;
  }

  // Undo/redo take NO arguments: the core knows which page each step belongs
  // to, and a shell that passed one could pass a stale one.
  if (msg.type === "undo") { applyHistory("undo"); return; }
  if (msg.type === "redo") { applyHistory("redo"); return; }
  // Phase 5: the SDK's ~300 ms idle debounce (and blur) says "the pause
  // happened" — the next keystroke starts a fresh word-level undo entry.
  if (msg.type === "sealHistory") { if (doc) F.historySeal(doc); return; }

  // The host persisted the document itself (an upload, its own storage) and is
  // declaring it — same bookkeeping a save does, without producing bytes. Added
  // 2026-08-24 with Android's markSaved(): the SDK cannot see where a host puts
  // the bytes, so only the host can say a save happened (I78).
  if (msg.type === "markSaved") {
    if (doc) { F.historyClear(doc); postHistory(true); }
    postMessage({ type: "markedSaved" });
    return;
  }

  if (msg.type === "history") { postHistory(true); return; }

  // DIAGNOSTIC: the whole journal, for a host debug panel. Read straight from
  // the core (pdfe_history_describe) — never a mirror kept here, because a
  // mirror shows what THIS FILE believes was recorded, which is exactly the
  // wrong answer when the two disagree. Pull-only: nothing computes it per
  // keystroke, so a closed panel costs nothing.
  if (msg.type === "historyDump") {
    if (!doc) { postMessage({ type: "historyDump", dump: null }); return; }
    // Two-call sizing: ask for the length, then read it (the JSON grows with
    // the stacks, so no fixed buffer can be right).
    const need = F.historyDescribe(doc, 0, 0);
    let dump = null;
    if (need > 0) {
      const buf = mod._malloc(need + 1);
      F.historyDescribe(doc, buf, need + 1);
      const json = new TextDecoder().decode(new Uint8Array(mod.HEAPU8.buffer, buf, need));
      mod._free(buf);
      try { dump = JSON.parse(json); } catch (e) { dump = { parseError: String(e) }; }
    }
    postMessage({ type: "historyDump", dump });
    return;
  }

  // How far the selected box may be dragged and still land on the page, so the
  // SDK's ghost stops where the drop will. Asked once when a drag is promoted —
  // it is a pure function of the box and the page, so it cannot change mid-drag,
  // and the core clamps the real move regardless of what the preview showed.
  if (msg.type === "moveLimits") {
    if (!doc || !selectedPara) { postMessage({ type: "moveLimits", limits: null }); return; }
    const page = selectedPara.page;
    ensureCoreGroup(page);
    // Same rule as the move itself: the SELECTED box's rect decides, or a drag
    // starting from a box dropped over others would be clamped to a neighbour's
    // travel range instead of its own.
    const selBlock = findMovedBlock(cachedGroups(page), selectedPara.bounds);
    const hit = selBlock
      ? { blockIndex: selBlock.index }
      : hitParagraph(page, selectedPara.xPt, selectedPara.yPt);
    if (!hit) { postMessage({ type: "moveLimits", limits: null }); return; }
    const lp = mod._malloc(16);
    const ok = F.blockMoveLimits(doc, acquirePage(page), hit.blockIndex, lp);
    const limits = ok ? readF32(lp, 4) : null;
    mod._free(lp);
    postMessage({ type: "moveLimits", limits });
    return;
  }

  // EXPERIMENTAL (feature/web-block-move): drag the selected box to a new spot.
  // Driven off the SELECTION, like Edit and Delete, so the worker stays the only
  // thing that decides which block an action applies to.
  if (msg.type === "moveSelected") {
    if (!doc || !selectedPara) return;
    const { page, xPt, yPt, bounds } = selectedPara;
    // Pass the SELECTED BOX'S RECT, not just its anchor: once a box has been
    // dropped across others, the anchor sits inside more than one box and the
    // point test picks the smallest — so a second nudge moved a neighbour
    // instead of the box the user was still holding.
    moveBlockAt(page, xPt, yPt, Number(msg.dx) || 0, Number(msg.dy) || 0, bounds);
    return;
  }

  if (msg.type === "toggleLineMode") {
    // Commit the open paragraph and reopen it in the OTHER line mode, forced
    // past the core heuristic (the Android btnLineMode analog). The paragraph
    // is re-resolved by hit-testing its own box center against the fresh
    // grouping commitEditor left behind.
    if (!editor || !editParaBounds) return;
    const page = editPage;
    const cx = (editParaBounds[0] + editParaBounds[2]) / 2;
    const cy = (editParaBounds[1] + editParaBounds[3]) / 2;
    const forced = F.editLineMode(editor) === 1 ? 0 : 1;
    commitEditor();
    openEditorAt(page, cx, cy, forced);
    return;
  }

  if (msg.type === "groups") {
    // Faint paragraph boxes (the Android edit-mode overlay): hand back every
    // paragraph's union bounds. A cached page answers immediately (scrolling
    // back to a page costs nothing); a fresh page becomes a LOW-priority latch
    // job, because grouping a dense page runs 100-250 ms and must never sit in
    // front of paints, tiles, or a tap.
    if (!doc) return;
    const cached = groupCache.get(msg.page);
    if (cached) {
      postMessage({ type: "groups", page: msg.page, blocks: cached,
                    images: imageCache.get(msg.page) || [] });
      return;
    }
    requestGroupJob(msg.page);
    return;
  }

  if (msg.type === "selectWord") {
    // Long-press word selection (the Android onSelectWord analog): boundary at
    // the pressed point, expanded to the containing non-whitespace run. The
    // boundary map clamps to the open run, so selection can never leave it
    // (the SEL6 invariant holds by construction).
    if (!editor || msg.page !== editPage) return;
    const text = readEditorText();
    let idx = F.editBoundary(editor, msg.xPt, msg.yPt);
    idx = Math.max(0, Math.min(idx, text.length));
    const isWord = (c) => c !== undefined && !/\s/.test(c);
    // A boundary can sit just past the pressed word's last char — step back
    // one when the left neighbour is a word char but the right isn't.
    if (!isWord(text[idx]) && isWord(text[idx - 1])) idx--;
    if (!isWord(text[idx])) {   // pressed whitespace: just move the caret
      postCaretMoved(idx);
      return;
    }
    let ws = idx, we = idx + 1;
    while (ws > 0 && isWord(text[ws - 1])) ws--;
    while (we < text.length && isWord(text[we])) we++;
    postMessage({
      type: "selectionChanged", start: ws, end: we,
      rects: readSelectionRects(ws, we), style: readRangeStyle(ws, we),
      h0: readCaret(ws), h1: readCaret(we),
    });
    return;
  }

  if (msg.type === "selectRange") {
    // Select an explicit char range — the index-based sibling of selectWord, and
    // what Ctrl/Cmd+A drives with (0, length). Same reply, so the shell needs no
    // new case; a collapsed range degrades to a caret move.
    if (!editor) return;
    const len = readEditorText().length;
    const s = Math.max(0, Math.min(msg.start, len));
    const e = Math.max(s, Math.min(msg.end, len));
    if (e <= s) {
      postCaretMoved(s);
      return;
    }
    postMessage({
      type: "selectionChanged", start: s, end: e,
      rects: readSelectionRects(s, e), style: readRangeStyle(s, e),
      h0: readCaret(s), h1: readCaret(e),
    });
    return;
  }

  if (msg.type === "dragCaret") {
    // The caret thumb: move the COLLAPSED caret to the dragged point. Same
    // boundary map as tap/drag (so it can never leave the open run), but it must
    // never take the `tap` path — tap commits the run when the point lands
    // outside its bounds, which a fingertip mid-drag will do.
    if (!editor || msg.page !== editPage) return;
    const idx = F.editBoundary(editor, msg.xPt, msg.yPt);
    postCaretMoved(idx);
    return;
  }

  // SHIFT+CLICK — extend the selection from where the caret already is to the
  // point clicked. WEB ONLY by nature: it needs a keyboard and a mouse together,
  // which a phone shell does not have (the touch equivalent is the handles).
  //
  // Deliberately NOT dragSelect: that anchors on a page POINT (the press point of
  // a drag), and this anchors on a character INDEX — the selection's fixed end,
  // which the shell knows and no point can reproduce once the caret has moved by
  // keyboard. Everything after the anchor is identical, so the two share the
  // clamp, the collapse-to-caret rule and the reply shape.
  if (msg.type === "selectToPoint") {
    if (!editor || msg.page !== editPage) return;
    const len = readEditorText().length;
    const a = Math.max(0, Math.min(msg.anchor | 0, len));
    const b = F.editBoundary(editor, msg.xPt, msg.yPt);
    const s = Math.min(a, b), e = Math.max(a, b);
    // Shift+clicking exactly where the caret is means "no selection", not a
    // zero-width one — same rule dragSelect follows when a drag collapses.
    if (e <= s) { postCaretMoved(s); return; }
    postMessage({
      type: "selectionChanged", start: s, end: e, headAtStart: b < a,
      rects: readSelectionRects(s, e), style: readRangeStyle(s, e),
      h0: readCaret(s), h1: readCaret(e),
    });
    return;
  }

  if (msg.type === "dragSelect") {
    // Mouse/touch drag selection: anchor = the press point, head = the drag
    // point, both mapped through the boundary map (clamped to the run, so the
    // SEL6 invariant holds here too). Collapsing back to the anchor becomes a
    // plain caret move.
    if (!editor || msg.page !== editPage) return;
    const a = F.editBoundary(editor, msg.ax, msg.ay);
    const b = F.editBoundary(editor, msg.xPt, msg.yPt);
    const s = Math.min(a, b), e = Math.max(a, b);
    if (e <= s) {
      postCaretMoved(s);
      return;
    }
    postMessage({
      type: "selectionChanged", start: s, end: e, headAtStart: b < a,
      rects: readSelectionRects(s, e), style: readRangeStyle(s, e),
      h0: readCaret(s), h1: readCaret(e),
    });
    return;
  }

  if (msg.type === "caretLine") {
    // ArrowUp/Down: move one VISUAL line using core geometry — the 1×1 sink
    // textarea wraps at every char, so its native up/down degenerates to
    // left/right. Take the caret's x, step one line height up/down (PDF y
    // grows upward), and let the wrap map's boundaryAt pick the char. Past
    // the first/last line it lands back on the same line — a harmless no-op.
    // With |edge| (Home/End — same degenerate-sink problem) stay ON the
    // caret's line (mid-line y) and clamp an extreme x to its first/last
    // boundary instead.
    // With |extend| (Shift held) the moved index is the selection HEAD and
    // |anchor| stays fixed — vertical selection extension by the PDF wrap.
    if (!editor) return;
    const c = readCaret(msg.index);   // [x, topPt, botPt], topPt > botPt
    if (!c) return;
    let x, y;
    if (msg.edge) {
      x = msg.edge < 0 ? -1e6 : 1e6;
      y = (c[1] + c[2]) / 2;
    } else {
      const h = Math.max(2, c[1] - c[2]);
      x = c[0];
      y = msg.dir < 0 ? c[1] + 0.7 * h : c[2] - 0.7 * h;
    }
    let idx = F.editBoundary(editor, x, y);
    if (msg.edge > 0) {
      // The line-end boundary IS the wrap point, and the wrap point's caret
      // renders at the NEXT line's start — step back while the caret still
      // draws below the starting line so End visually stays on its own line.
      const h = Math.max(2, c[1] - c[2]);
      while (idx > msg.index) {
        const cc = readCaret(idx);
        if (cc && cc[2] < c[2] - 0.5 * h) idx--;
        else break;
      }
    }
    if (msg.extend) {
      const s = Math.min(msg.anchor, idx), e = Math.max(msg.anchor, idx);
      if (e > s) {
        postMessage({
          type: "selectionChanged", start: s, end: e, headAtStart: idx < msg.anchor,
          rects: readSelectionRects(s, e), style: readRangeStyle(s, e),
          h0: readCaret(s), h1: readCaret(e),
        });
        return;
      }
    }
    postCaretMoved(idx);
    return;
  }

  if (msg.type === "dragHandle") {
    // Selection handle drag: map the dragged point to a char boundary and move
    // ONE end, never flipping past the other (start stays < end — SEL4).
    if (!editor) return;
    const len = readEditorText().length;
    let s = msg.start, e = msg.end;
    const idx = F.editBoundary(editor, msg.xPt, msg.yPt);
    if (msg.which === 0) s = Math.max(0, Math.min(idx, e - 1));
    else e = Math.min(len, Math.max(idx, s + 1));
    postMessage({
      type: "selectionChanged", start: s, end: e, headAtStart: msg.which === 0,
      rects: readSelectionRects(s, e), style: readRangeStyle(s, e),
      h0: readCaret(s), h1: readCaret(e),
    });
    return;
  }

  // ---- character-level styling ---------------------------------------------
  // The colour NEWLY TYPED characters take. Fire-and-forget: nothing to draw, and
  // nothing to reply. The SHELL clears it on an explicit cursor move and never on
  // typing — the core cannot tell a tap from a keystroke (docs/STYLING.md).
  if (msg.type === "setTypingColor") {
    if (editor) F.editSetTypingColor(editor, msg.argb >>> 0, msg.set ? 1 : 0);
    // STICKY SURVIVES THE BOX (user decision 2026-08-13). The core's typing colour
    // lives on the EDIT SESSION, so opening another box used to lose it and typing
    // fell back to the caret's colour — reported as wrong, and it is: "sticky until
    // the host clears it" cannot mean "until the user taps the next paragraph".
    // Remembered HERE, re-armed in openEditorAt. Only while sticky: a FOLLOW-mode
    // pick is dropped by the very next cursor move, so persisting it would resurrect
    // something the user already moved away from.
    if (!typingColorFollowsCaret) stickyColorArgb = msg.set ? (msg.argb >>> 0) : null;
    if (!msg.set) stickyColorArgb = null;      // clearTypingColor() ends it in both modes
    // Remember WHERE a collapsed-caret pick armed the override (msg.at; -1 for
    // a range apply or a clear): a tap back to that exact index keeps the pick
    // — see postCaretMoved.
    typingColorArmedAt = msg.set && msg.at != null && msg.at >= 0 ? msg.at : -1;
    typingColorArmedArgb = msg.set ? (msg.argb >>> 0) : 0;
    // …and the arm reports itself (I76) — but only when there IS a run to read a style
    // from: a STICKY pick made with no box open has nothing to report yet, and the box
    // that opens next reports its own style anyway.
    if (editor && typingColorArmedAt >= 0) postArmedStyle(typingColorArmedAt);
    return;
  }

  // Which of the two lifetimes a picked colour has (docs/STYLING.md §2):
  // ON  — it lasts until the user moves the cursor, then the caret's own colour
  //       takes over (the default; what a word processor does).
  // OFF — it is sticky until the host clears it, so every run typed in this
  //       session takes the picked colour wherever the cursor goes.
  if (msg.type === "setTypingColorFollowsCaret") {
    typingColorFollowsCaret = !!msg.on;
    // Back to follow-the-caret: the cross-session pick retires with the mode, or the
    // next box would silently type in a colour whose lifetime rule no longer exists.
    if (typingColorFollowsCaret) stickyColorArgb = null;
    return;
  }

  // The same switch for the TYPEFACE — family AND bold/italic together, because both
  // are the core's one `currentFontId` (2026-08-20). Same two lifetimes, same default,
  // same retirement rule as colour's above.
  if (msg.type === "setTypingFontFollowsCaret") {
    typingFontFollowsCaret = !!msg.on;
    if (typingFontFollowsCaret) {
      stickyFontName = null;
      stickyFace = null;
      // A pick made under the STICKY rule has no index to revive from, so leaving it
      // armed would outlive the rule that justified it. Drop it now rather than at the
      // next cursor move, which is what the host just asked for.
      if (editor) F.editSetTypingFont(editor, 0);
      typingFontArmedAt = -1;
      typingFontArmedName = null;
    }
    return;
  }

  if (msg.type === "applyColor") {
    if (!editor) return;                       // no run open: silent, like selectWord
    // ORDER MATTERS. msg.start/end were computed against the SINK's current text, so
    // a keystroke still sitting in the latch must land FIRST or the indices point at
    // the wrong characters — and that set_text pass would then rebuild the run and
    // drop the colour. The `edit` branch's inline drain makes this window narrow,
    // not absent, so do not rely on it.
    if (pendingEdit) drainLatch();
    const len = readEditorText().length;
    const s = Math.max(0, Math.min(msg.start, len));
    const e = Math.max(s, Math.min(msg.end, len));
    if (e <= s) return;
    dirtyPages.add(editPage);
    noteMutation(editPage);                    // split/coalesce renumbers objects
    const dPtr = mod._malloc(16);
    const rc = F.editApplyColor(editor, s, e, msg.argb >>> 0, dPtr);
    const dirty = readF32(dPtr, 4);
    mod._free(dPtr);
    syncEditTextPage();
    // A colour change moves nothing, so the core's rect is inside the run and there
    // is no growth to union in (that guard exists for reflow, which colour cannot
    // cause).
    const blitMs = renderDirtyStrip(editPage, dirty);
    postMessage({
      type: "styleApplied", what: "color", ok: rc >= 0, page: editPage,
      argb: msg.argb >>> 0,
      // Diagnostics, the same pair editApplied carries: `dirty` empty or blitMs 0
      // means the strip was never repainted, which is the first thing to check if a
      // colour ever fails to appear.
      dirty, blitMs: Math.round(blitMs * 100) / 100,
      // NO caret: this path only runs with a RANGE (it returns early on a collapsed
      // one), and a range has no caret. It used to send readCaret(-1), and -1 clamps
      // to index 0 — so the shell drew a blinking bar at the START of the run while
      // the highlight sat mid-run, which reads as the cursor jumping to the beginning.
      selection: readSelectionRects(s, e),
      h0: readCaret(s), h1: readCaret(e), selStart: s, selEnd: e,
      runBounds: readRunBounds(len),
      style: readRangeStyle(s, e),             // read back AFTER the write
    });
    postHistory();                             // a style change is a recordable step
    return;
  }

  // ---- size: the same two verbs as colour, and ONE difference that matters -----
  //
  // A size apply MOVES GEOMETRY VERTICALLY — the only styling property that does.
  // So unlike applyColor, whose comment says "a colour change moves nothing and the
  // core's rect is inside the run", this one must repaint whatever the I25 height
  // cascade pushed: the lines below the changed one ride down, and on a big change
  // the run's own box grows past where it was. The core's dirty rect already covers
  // that (it unions the old and new bounds), so the rule here is simply to trust it
  // and to union the run's bounds as well rather than assuming the strip is enough.
  if (msg.type === "applySize") {
    if (!editor) return;                       // no run open: silent, like applyColor
    // Same ordering rule as applyColor, and for the same reason: msg.start/end were
    // computed against the SINK's text, so a latched keystroke must land first or the
    // indices name the wrong characters and the set_text pass drops the size.
    if (pendingEdit) drainLatch();
    const len = readEditorText().length;
    const s = Math.max(0, Math.min(msg.start, len));
    const e = Math.max(s, Math.min(msg.end, len));
    const pt = Number(msg.sizePt);
    // The core REJECTS a non-positive size rather than clamping it, so refusing here
    // keeps the two layers saying the same thing instead of sending it a value it will
    // only bounce (pdfe.h: "never clamped").
    if (!(pt > 0)) {
      postMessage({ type: "styleApplied", what: "size", ok: false,
                    reason: "bad-size", page: editPage, sizePt: pt });
      return;
    }
    if (e <= s) {
      postMessage({ type: "styleApplied", what: "size", ok: false,
                    reason: "no-selection", page: editPage, sizePt: pt });
      return;
    }
    dirtyPages.add(editPage);
    noteMutation(editPage);                    // the apply re-typesets and renumbers
    const dPtr = mod._malloc(16);
    const rc = F.editApplySize(editor, s, e, pt, dPtr);
    const dirty = readF32(dPtr, 4);
    mod._free(dPtr);
    syncEditTextPage();
    const blitMs = renderDirtyStrip(editPage, dirty);
    postMessage({
      type: "styleApplied", what: "size", ok: rc >= 0, page: editPage,
      sizePt: pt,
      dirty, blitMs: Math.round(blitMs * 100) / 100,
      selection: readSelectionRects(s, e),
      h0: readCaret(s), h1: readCaret(e), selStart: s, selEnd: e,
      runBounds: readRunBounds(readEditorText().length),
      style: readRangeStyle(s, e),             // read back AFTER the write
    });
    postHistory();                             // a style change is a recordable step
    return;
  }

  if (msg.type === "setTypingSize") {
    if (!editor) return;
    const pt = Number(msg.sizePt) || 0;
    const on = msg.set ? 1 : 0;
    if (on && !(pt > 0)) return;               // refused, not clamped — same as apply
    F.editSetTypingSize(editor, pt, on);
    // Remember WHERE it was armed, so the click back from the dropdown keeps it. `at`
    // is -1 for a range apply, whose painted text needs no revival.
    if (on && typeof msg.at === "number" && msg.at >= 0) {
      typingSizeArmedAt = msg.at;
      typingSizeArmedPt = pt;
      postArmedStyle(msg.at);   // the arm is a style change: TELL the host (I76)
    } else if (!on) {
      typingSizeArmedAt = -1;
      typingSizeArmedPt = 0;
    }
    return;
  }

  // ---- fonts: the DELIVERY contract, then the two verbs -----------------------
  // THE HOST PROVIDES THE VARIANTS (user decision 2026-08-13). The SDK bundles no
  // font catalog, so a face reaches the engine only by a host handing over bytes (or
  // naming a standard-14 face). This is the web mirror of Android's FontCatalog ->
  // FontSpec -> pdfe_load_asset_font path, and it is the thing web genuinely did not
  // have — which is why applyFont was Android-only until now, plumbing aside.
  //
  // Handles are DOCUMENT-owned (freed at pdfe_close_doc), so the registry is keyed by
  // the host's own name and cleared with the document; a host re-registers after
  // opening a new file. Names are the identity a host applies by, exactly as Android
  // keys its native font cache by the picker's display name rather than an asset path.
  if (msg.type === "loadFont") {
    const name = String(msg.name || "");
    if (!doc || !name) {
      postMessage({ type: "fontLoaded", ok: false, name, reason: "bad-source" });
      return;
    }
    let handle = fontHandles.get(name) || 0;
    if (!handle) {
      if (msg.bytes && msg.bytes.byteLength) {
        const src = new Uint8Array(msg.bytes);
        const bp = mod._malloc(src.length);
        mod.HEAPU8.set(src, bp);
        // COMPOSITE (CID) always — pdfe_load_asset_font's contract, and the reason is
        // a real bug (the Meticula zero-width-space one). Nothing to decide here.
        handle = withUtf8(name, (np) => F.loadAssetFont(doc, np, bp, src.length));
        mod._free(bp);
      } else {
        handle = withUtf8(name, (np) => F.loadStandardFont(doc, np));
      }
      if (handle) fontHandles.set(name, handle);
    }
    // REGISTERING IS WHAT MAKES BOLD/ITALIC POSSIBLE, and it is not optional here:
    // a face nobody registered is a face pdfe_edit_apply_face cannot find, so a host
    // that loaded Roboto-Bold would still be told "no bold face". The core derives
    // the family, weight and slant from the font itself so all three shells agree.
    if (handle) F.registerFace(doc, handle);
    postMessage({
      type: "fontLoaded", ok: !!handle, name,
      reason: handle ? undefined : "font-failed",
    });
    return;
  }

  // APPLY A FAMILY. Two verbs over one gesture, the same shape as colour: a RANGE is
  // restyled now, a BARE CARET arms what the next keystroke takes.
  if (msg.type === "applyFont") {
    // STICKY IS REMEMBERED EVEN WITH NO RUN OPEN, before the early return below: the
    // host picked a typeface for what it is about to type, and openEditorAt arms it on
    // the next box. Recorded here rather than in the collapsed branch, so a pick made
    // over a RANGE is also remembered — the painted characters keep it, and so does the
    // next thing typed, which is what "sticky" says on the tin.
    if (!typingFontFollowsCaret) {
      stickyFontName = msg.name == null ? "" : String(msg.name);
      stickyFace = null;
    }
    if (!editor) return;                       // no run open: silent, like applyColor
    if (pendingEdit) drainLatch();             // indices were computed against the sink
    const name = msg.name == null ? null : String(msg.name);
    // null / "" is ORIGINAL — the core's own sentinel for "keep each segment's own
    // font", which is why a font can have one and a colour cannot (pdfe.h).
    const handle = name ? (fontHandles.get(name) || 0) : 0;
    if (name && !handle) {
      postMessage({ type: "styleApplied", what: "font", ok: false, page: editPage,
                    fontName: name, reason: "font-failed" });
      return;
    }
    const len = readEditorText().length;
    const s = Math.max(0, Math.min(msg.start | 0, len));
    const e = Math.max(s, Math.min(msg.end | 0, len));
    if (e <= s) {
      // BARE CARET: arm the typing font. Remember WHERE, so a click back to the same
      // index keeps the pick (the picker-steals-focus exception above).
      F.editSetTypingFont(editor, handle);
      typingFontArmedAt = s;
      typingFontArmedName = name;
      postMessage({ type: "styleApplied", what: "typingFont", ok: true, page: editPage,
                    fontName: name, caretIndex: s });
      return;
    }
    dirtyPages.add(editPage);
    noteMutation(editPage);                    // split/coalesce renumbers objects
    const dPtr = mod._malloc(16);
    const rc = F.editApplyFont(editor, s, e, handle, dPtr);
    const dirty = readF32(dPtr, 4);
    mod._free(dPtr);
    syncEditTextPage();
    postFontApplied("font", rc >= 0, s, e, dirty, { fontName: name });
    return;
  }

  // BOLD / ITALIC. One message for both, because the core has one call for both —
  // there is no bold property in a PDF, only a different font. `bold`/`italic` are
  // true / false / null, where null means "leave that one alone".
  if (msg.type === "applyFace") {
    if (!editor) return;
    if (pendingEdit) drainLatch();
    const len = readEditorText().length;
    const s = Math.max(0, Math.min(msg.start | 0, len));
    const e = Math.max(s, Math.min(msg.end | 0, len));
    const tri = (v) => (v == null ? -1 : (v ? 1 : 0));
    // A BARE CARET ARMS the face for what is typed next (PDFE_FACE_ARMED) rather than
    // refusing, which is what pressing B with no selection has always meant. Nothing on
    // the page changes, so this must NOT enter the dirty/mutation bookkeeping below —
    // marking a document modified for an edit that never happened is a lie about what
    // happened (docs/FONTS.md §3).
    const arming = e <= s;
    if (!arming) {
      dirtyPages.add(editPage);
      noteMutation(editPage);
    }
    const dPtr = mod._malloc(16);
    const rc = F.editApplyFace(editor, s, e, tri(msg.bold), tri(msg.italic), dPtr);
    const dirty = readF32(dPtr, 4);
    mod._free(dPtr);
    if (!arming) syncEditTextPage();
    // ARM BOOKKEEPING: record WHERE it was armed so the caret-move choke point can drop
    // it again (the same one-lifetime rule a font pick follows). Deliberately no
    // typingFontArmedName — the CORE now reports the armed face's own name, family and
    // bold/italic at a bare caret, so overriding the name here would be a second, rival
    // answer to the same question.
    if (rc === PDFE_FACE_ARMED) {
      typingFontArmedAt = s;
      // STICKY: the INTENT, not a face handle — a new box resolves bold/italic against
      // its own family (openEditorAt). Read from the reply's own truth, since msg.bold /
      // msg.italic may be null meaning "leave that axis alone".
      if (!typingFontFollowsCaret) {
        const f = readRangeStyle(s, s) || {};
        stickyFace = { bold: !!f.bold, italic: !!f.italic };
        stickyFontName = null;
      }
    }
    // rc 0 is "already that face" — a success with nothing repainted, and the host
    // still gets a fresh style read so its buttons settle. rc 2 is an arm: also a
    // success, and also nothing repainted.
    postFontApplied("face", rc >= 0, s, e, dirty, {
      bold: msg.bold, italic: msg.italic,
      reason: rc >= 0 ? undefined : faceErrorCode(rc),
      // A PARTIAL apply modified the document exactly as much as a full one did — it
      // dirtied a rect and journalled a step — so it must mark the document dirty.
      // Treating it as "nothing happened" would lose the user's edit on close.
      changed: rc === 1 || rc === PDFE_FACE_APPLIED_PARTIAL,
      armed: rc === PDFE_FACE_ARMED,
      partial: rc === PDFE_FACE_APPLIED_PARTIAL,
    });
    return;
  }

  // Register the bundled set (and report which families it offers). Called automatically
  // after every open — handles are document-owned, so this is per document — and also
  // callable by a host that wants to await readiness for its own progress UI.
  if (msg.type === "prepareFonts") {
    if (msg.fontsUrl) fontsBaseUrl = String(msg.fontsUrl);
    if (bundledFonts.state === "ready") {
      postMessage({
        type: "fontsReady",
        families: bundledFonts.families,
        failed: bundledFonts.failed,
      });
    } else {
      registerBundledFonts();          // deliberately not awaited: open must not block
    }
    return;
  }

  // The style at a caret or over a range, on demand — what a host paints its swatch
  // from when nothing has changed but the cursor moved.
  if (msg.type === "styleAt") {
    postMessage({
      type: "styleRead", page: editPage,
      style: editor ? readRangeStyle(msg.start | 0, msg.end | 0) : null,
    });
    return;
  }

  if (msg.type === "commit") {
    commitEditor();
    return;
  }

  if (msg.type === "save") {
    await saveDocument(!!msg.forceInHeap);
    return;
  }

  if (msg.type === "reapStaging") {
    // Delivery finished reading the staged file (§6): drop it so OPFS quota
    // doesn't carry a copy of the last save around.
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(SAVE_STAGING);
    } catch (e) { /* nothing staged, or already gone */ }
    return;
  }
};
