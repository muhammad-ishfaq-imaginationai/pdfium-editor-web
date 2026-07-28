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

importScripts("./editor.js?v=cf38aa8"); // classic worker: defines createPdfe

const PDFE_RENDER_RGBA = 0x1;

const TILE = 768;      // §5: square tiles, 768 device px
const TILE_OVERLAP = 3; // §5: ~2.5px seam overlap, rounded up to whole pixels
const BASE_MAX = 384;  // base layer: longest page side in device px (cheap + instant)

let mod = null;
const F = {};
let doc = 0;
const pages = [];              // [{w, h}] PDF points
const pageHandles = new Map(); // pageIndex -> PDFE_PAGE (skeleton: no LRU yet)
const textPages = new Map();   // pageIndex -> PDFE_TEXTPAGE (grouping + edit begin)
const canvases = new Map();    // pageIndex -> OffscreenCanvas
const paintGen = new Map();    // pageIndex -> generation (stale tile jobs drop)
const pageScale = new Map();   // pageIndex -> device px per PDF point (last paint)

// ---- the live edit session (pdfe_edit_*; core Step 4) -------------------------
// One live session per document. The worker owns it outright — this queue IS
// the serializer (docs/CORE_API.md §6). The session adopts the page's text
// page; we re-sync our handle after every mutating call.
let editor = 0;
let editPage = -1;
let editParaBounds = null;     // [l,b,r,t] page pts of the open paragraph (tap routing)
// Pages with in-memory edits not yet flushed into their content stream —
// pdfe_save does NOT flush; we run pdfe_generate_content on these first
// (the PdfSession.dirtyPages analog). Commit flushes its page in the core.
const dirtyPages = new Set();
// Pooled render buffer per docs/WEB_VIEWER.md §10 (FPDFBitmap_CreateEx external
// buffers are caller-owned; pooling also avoids per-render heap growth).
let pool = { ptr: 0, size: 0 };

// locateFile: the Emscripten glue resolves editor.wasm relative to the
// WORKER's URL (/web/), not the glue's — point it back at /wasm/dist/.
const ready = createPdfe({ locateFile: (f) => "./" + f + "?v=cf38aa8" }).then((m) => {
  mod = m;
  F.init         = m.cwrap("pdfe_init", "number", ["number"]);
  F.openMem      = m.cwrap("pdfe_open_mem", "number", ["number", "number", "number"]);
  F.openMemOwned = m.cwrap("pdfe_open_mem_owned", "number", ["number", "number", "number"]);
  F.openCustom   = m.cwrap("pdfe_wasm_open_custom", "number", ["number", "number"]);
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
  F.editBegin     = m.cwrap("pdfe_edit_begin", "number",
    ["number", "number", "number", "number"]);
  F.editBeginEx   = m.cwrap("pdfe_edit_begin_ex", "number",
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
  F.editCommit    = m.cwrap("pdfe_edit_commit", "number", ["number", "number"]);
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

function acquirePage(i) {
  let p = pageHandles.get(i);
  if (!p) { p = F.loadPage(doc, i); pageHandles.set(i, p); }
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

function readCaret(index) {
  const ptr = mod._malloc(12);
  const ok = F.editCaret(editor, index, ptr);
  const v = ok ? readF32(ptr, 3) : null;
  mod._free(ptr);
  return v; // [x, topPt, botPt] page points
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

// Group the page and hit-test the paragraphs: the smallest paragraph whose
// union box contains the point (page pts). Returns {index, bounds} or null.
function hitParagraph(page, xPt, yPt) {
  const handle = acquirePage(page);
  const n = F.group(doc, handle, textPageOf(page));
  if (n <= 0) return null;
  const bp = mod._malloc(16);
  let best = null;
  for (let i = 0; i < n; i++) {
    if (!F.paraInfo(doc, i, bp, 0, 0, 0)) continue;
    const b = readF32(bp, 4); // [l, b, r, t]
    if (xPt < b[0] || xPt > b[2] || yPt < b[1] || yPt > b[3]) continue;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (!best || area < best.area) best = { index: i, bounds: b, area };
  }
  mod._free(bp);
  return best;
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
  editor = 0; editPage = -1; editParaBounds = null;
  postMessage({ type: "editClosed", page, ok: ok === 1 });
}

// Open the core editor on |hit| (a hitParagraph result) at page point
// (xPt, yPt). |lineMode|: -1 auto (the core heuristic classifies list-like
// paragraphs as line-preserving), 0 force reflow, 1 force line-preserving.
function openEditorAt(page, hit, xPt, yPt, lineMode) {
  const ed = F.editBeginEx(doc, acquirePage(page), textPageOf(page), hit.index, lineMode);
  if (!ed) return;
  editor = ed;
  editPage = page;
  editParaBounds = hit.bounds;
  const text = readEditorText();
  const caretIdx = F.editBoundary(editor, xPt, yPt);
  postMessage({
    type: "editOpened",
    page,
    paraIndex: hit.index,   // the shell hides this paragraph's faint box
    text,
    caretIndex: caretIdx,
    caret: readCaret(caretIdx),
    isParagraph: F.editIsPara(editor) === 1,
    linePreserve: F.editLineMode(editor) === 1,
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
// One drain tick per animation frame. Edit passes preempt tile fills; only the
// NEWEST pending edit survives coalescing. Since core Step 4 the engine pass is
// REAL: pdfe_edit_set_text -> dirty-strip render -> caret geometry back.
let pendingEdit = null;   // newest {fullText, caretIndex, generation, postedAt}
const tileQueue = [];     // FIFO of {page, gen, scale, x, y, w, h}
let latchScheduled = false;
let lastEditPass = -1e9;  // when the last engine pass ran (worker clock)

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
      const blitMs = renderDirtyStrip(editPage, dirty);
      const sel = edit.selEnd > edit.selStart
        ? readSelectionRects(edit.selStart, edit.selEnd) : [];
      postMessage({
        type: "editApplied",
        generation: edit.generation,
        page: editPage,
        caret: readCaret(-1),
        selection: sel,
        engineMs: Math.round(engineMs * 100) / 100,
        blitMs: Math.round(blitMs * 100) / 100,
        postedAt: edit.postedAt,
      });
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
  // 2) Then a budgeted slice of tile fills (skip jobs a newer paint outdated).
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
  if (tileQueue.length || pendingEdit) scheduleLatch();
}

// ---- tiled page paint (docs/WEB_VIEWER.md §5) ---------------------------------
// Base layer first (instant, blurry), then 768px sharp tiles through the latch.
function paintPage(page, w, h, scale) {
  const canvas = canvases.get(page);
  if (!canvas || !doc) return;
  const gen = (paintGen.get(page) || 0) + 1;
  paintGen.set(page, gen);
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
      tileQueue.length = 0; pendingEdit = null;
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
    if (loadTier === 2) {
      // Lazy: nothing but PDFium's parsed structures + the block cache in heap.
      reader = reader || new FileReaderSync();
      doc = F.openCustom(sourceSize, 0);
    } else {
      // Eager: ONE full copy into the heap, pinned until pdfe_close_doc (the
      // FPDF_LoadMemDocument rule, owned inside the core). Hand it over with
      // the ADOPTING entry point — pdfe_open_mem would copy it a second time,
      // doubling peak heap for nothing (this is what Android's JNI does too).
      const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
      const ptr = mod._malloc(bytes.length);
      mod.HEAPU8.set(bytes, ptr);
      doc = F.openMemOwned(ptr, bytes.length, 0);   // core frees it, incl. on failure
    }
    const openMs = Math.round(performance.now() - tOpen);
    if (!doc) { postMessage({ type: "error", detail: "open failed" }); return; }
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
    return;
  }

  if (msg.type === "attach") {
    canvases.set(msg.page, msg.canvas);
    return;
  }

  if (msg.type === "paint") {
    // scale = device pixels per PDF point, decided by the main thread.
    paintPage(msg.page, msg.w, msg.h, msg.scale);
    return;
  }

  if (msg.type === "edit") {
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
    // moves the caret; anywhere else commits, then a hit paragraph opens.
    if (!doc) return;
    if (editor && msg.page === editPage && editParaBounds &&
        msg.xPt >= editParaBounds[0] && msg.xPt <= editParaBounds[2] &&
        msg.yPt >= editParaBounds[1] && msg.yPt <= editParaBounds[3]) {
      const idx = F.editBoundary(editor, msg.xPt, msg.yPt);
      postMessage({ type: "caretMoved", index: idx, caret: readCaret(idx) });
      return;
    }
    if (editor) commitEditor();   // tap outside / another paragraph: commit first
    const hit = hitParagraph(msg.page, msg.xPt, msg.yPt);
    if (!hit) return;             // empty space: nothing more to do
    // The grouping ran just above (hitParagraph), so the core's fresh-open
    // gate is satisfied by construction.
    openEditorAt(msg.page, hit, msg.xPt, msg.yPt, -1);
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
    const hit = hitParagraph(page, cx, cy);
    if (!hit) return;
    openEditorAt(page, hit, cx, cy, forced);
    return;
  }

  if (msg.type === "groups") {
    // Faint paragraph boxes (the Android edit-mode overlay): group the page
    // and hand back every paragraph's union bounds. Grouping is cached on the
    // doc handle per page; re-running it here is the same call tap routing
    // makes, so the fresh-open gate stays satisfied.
    if (!doc) return;
    const n = F.group(doc, acquirePage(msg.page), textPageOf(msg.page));
    const bp = mod._malloc(16);
    const paras = [];
    for (let i = 0; i < n; i++) {
      if (!F.paraInfo(doc, i, bp, 0, 0, 0)) continue;
      paras.push({ index: i, bounds: readF32(bp, 4) });
    }
    mod._free(bp);
    postMessage({ type: "groups", page: msg.page, paras });
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
      postMessage({ type: "caretMoved", index: idx, caret: readCaret(idx) });
      return;
    }
    let ws = idx, we = idx + 1;
    while (ws > 0 && isWord(text[ws - 1])) ws--;
    while (we < text.length && isWord(text[we])) we++;
    postMessage({
      type: "selectionChanged", start: ws, end: we,
      rects: readSelectionRects(ws, we),
      h0: readCaret(ws), h1: readCaret(we),
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
      postMessage({ type: "caretMoved", index: s, caret: readCaret(s) });
      return;
    }
    postMessage({
      type: "selectionChanged", start: s, end: e, headAtStart: b < a,
      rects: readSelectionRects(s, e),
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
          rects: readSelectionRects(s, e),
          h0: readCaret(s), h1: readCaret(e),
        });
        return;
      }
    }
    postMessage({ type: "caretMoved", index: idx, caret: readCaret(idx) });
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
      rects: readSelectionRects(s, e),
      h0: readCaret(s), h1: readCaret(e),
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
