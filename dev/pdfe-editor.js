// pdfe-editor.js — the EMBEDDABLE editor surface (docs/EDITOR_SDK.md).
//
// This is the SDK every host embeds: web pages, the iOS WKWebView shell, and
// (later) an Android WebView shell. It owns EXACTLY the three shell duties from
// docs/PLATFORM_SHELLS.md — the render surface, input, and nothing else:
//
//   * renders pages (worker-owned OffscreenCanvas, tiled — WEB_VIEWER.md §5)
//   * draws caret / selection / handles / faint paragraph boxes from CORE
//     geometry (§6) — never from browser text metrics
//   * turns taps, long-press, drags, pinch and IME keystrokes into core calls
//
// It owns ZERO chrome (user decision 2026-07-28): no toolbar, no file input, no
// Save button, no dialogs, no status line, no default document, no localStorage.
// Open/Save/Edit-toggle/zoom-buttons/warnings all belong to the HOST, which
// drives them through the API below and listens to events. That split is what
// lets the same editor drop into a website, an iOS app, or an Android app while
// each keeps its own UI.
//
// All editing behavior still lives in the C++ core (libpdfe) behind the worker,
// so this file cannot make platforms diverge — it has no editing logic to drift.

const PDFE_STYLE_ID = "pdfe-editor-styles";

// The surround behind the pages. Requested by the DocuFence web team
// (2026-08-03); it was #9e9e9e before. Kept here as the ONE definition so the
// CSS fallback, the option default and the docs cannot drift apart.
const PDFE_DEFAULT_BG = "#f8f9fb";

// Double-tap / double-click word select. 350 ms matches the pinch-suppression
// window already used in the tap path; 20 px is generous enough for a fingertip
// yet far below a deliberate second tap on a different word.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 20;
// The caret thumb is sampled this far ABOVE the finger, so the boundary lookup
// lands on the caret's own line rather than the one the fingertip covers. Same
// constant and same reason as the selection-handle drag.
const HANDLE_TOUCH_LIFT = 22;

// Injected once per document. Class-scoped (never ids) so several editors can
// coexist on one page, and minimal so a host's own CSS reset can't break the
// geometry the overlays depend on.
const PDFE_CSS = `
.pdfe-host { position: relative; overflow: hidden; }
.pdfe-scroll {
  position: relative; width: 100%; height: 100%; overflow: auto;
  /* The surround behind the pages (each page paints its own white). A custom
     property, not a hard-coded value, so a host can theme it with one option
     (backgroundColor) or one CSS line of its own, and so several editors on a
     page can differ. The default is the light neutral the DocuFence web team
     asked for (2026-08-03); it was #9e9e9e until then.
     NOTE no backticks in this comment: it lives inside a template literal. */
  background: var(--pdfe-bg, #f8f9fb); -webkit-overflow-scrolling: touch;
  /* No native text selection over the pages: on iOS a long-press otherwise
     raises the callout bar / magnifier on top of OUR word selection, and the
     drawn round handles are the only selection UI we ship. The sink is exempt —
     it is a real editable and needs its own (invisible) selection. */
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  /* pan-x pan-y: one finger scrolls natively, but the browser's pinch-zoom and
     double-tap zoom are suppressed — pinch is reimplemented as APP zoom (I17:
     native pinch scales the rendered bitmap and blurs the text; app zoom
     repaints sharp tiles). */
  touch-action: pan-x pan-y;
}
.pdfe-strip {
  position: relative; padding: 12px 0 24px;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  /* min-width: max-content: when a zoomed canvas grows wider than the viewport
     a centered flex child overflows BOTH sides and the left half is
     unreachable by scrolling (I17 follow-up). Sizing the strip to its content
     makes the scroll range cover everything. */
  min-width: max-content;
}
.pdfe-strip canvas { background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.45); display: block; }
.pdfe-layer { position: absolute; left: 0; top: 0; }
/* Edit-mode paragraph boxes. The hairline stays 1px at every zoom (a thicker
   rule would sit ON the glyphs); visibility comes from ALPHA and a faint fill,
   not from weight (user decision 2026-07-29). Edit mode draws every box as a
   GREY DASHED hairline; the selected box switches to a SOLID SKY-BLUE hairline
   with a blue wash (user decision 2026-07-29), so "which box am I acting on"
   is unmistakable without the overlay ever growing. */
.pdfe-parabox { position: absolute; border: 1px dashed #757575cc; background: #7575751f;
                pointer-events: none; border-radius: 1px; }
.pdfe-parabox.pdfe-selected { border-style: solid; border-color: #03a9f4; background: #03a9f426; }
/* A SELECTED PICTURE. Same sky blue as a selected text box so "this is
   selected" reads identically, but a POLYGON — a turned picture's outline is
   still a rectangle geometrically and still needs four arbitrary corners, and a
   CSS box cannot express that. pointer-events: none for the same reason the
   paragraph boxes have it: the canvas below owns the tap. */
.pdfe-imagebox { position: absolute; pointer-events: none; overflow: visible; }
/* UNSELECTED: the picture's twin of .pdfe-parabox — a grey dashed hairline that
   says "this is a thing you can grab", drawn for every picture in edit mode. */
.pdfe-imagebox polygon { fill: none; stroke: #9e9e9e; stroke-width: 1;
                         stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
/* SELECTED: solid sky blue + the same wash, matching .pdfe-parabox.pdfe-selected
   so "selected" reads identically whichever kind it is. Two pixels, not one: a
   1 px hairline over a busy photograph is genuinely hard to see, which is what
   the first look at this reported. */
.pdfe-imagebox-selected polygon { fill: #03a9f426; stroke: #03a9f4; stroke-width: 2;
                                  stroke-dasharray: none; }
/* The rotate handle. Sky blue to read as part of the selection, circular so it
   is obviously a button and not a resize grip — this feature has no resize, and
   a square corner handle would promise one. 28 px is the smallest comfortable
   touch target that still sits on a small picture. */
.pdfe-rotate { position: absolute; z-index: 5; display: none;
               width: 28px; height: 28px; padding: 0; border-radius: 50%;
               border: 1px solid #03a9f4; background: #fff; color: #03a9f4;
               box-shadow: 0 1px 4px #0003; cursor: pointer;
               align-items: center; justify-content: center; }
.pdfe-rotate:hover { background: #03a9f4; color: #fff; }
.pdfe-rotate:active { transform: scale(0.92); }
/* EXPERIMENTAL (feature/web-block-move): the drag ghost. A box being dragged is
   previewed as an outline that follows the finger; the real text is translated
   ONCE on drop, so a drag costs no engine work per frame. Dashed and washed so
   it reads as "not there yet", and above the faint boxes it slides over. */
.pdfe-moveghost { position: absolute; border: 2px dashed #03a9f4; background: #03a9f41f;
                  pointer-events: none; border-radius: 2px; z-index: 3; display: none; }
/* NOTE: the box overlay deliberately stays pointer-events: none. Making the
   selected box interactive so it could carry a move cursor would steal the
   pointerdown from the canvas and break "tap the selected box again to edit" —
   so the drag is hit-tested in the canvas handler against the selection's
   bounds instead, and there is no hover cursor affordance yet.
   (Never write a backtick in this block: PDFE_CSS is a template literal, and a
   stray one ends the string — it broke the whole SDK once, 2026-08-03.) */
/* The run OPEN for editing: a solid BLUE box (user request 2026-07-29) so "you
   are typing in here" is visible. Border only — a wash would tint the glyphs
   being edited and fight the selection highlight. It is its own element (not a
   .pdfe-parabox) because its geometry is the run's LIVE bounds from the core,
   refreshed every keystroke, while the grouping bounds go stale on reflow. */
.pdfe-editbox { position: absolute; border: 1px solid #1976d2; border-radius: 1px;
                display: none; pointer-events: none; z-index: 1; }
/* The selected box's action bar: the ONLY chrome the SDK owns, because it is
   part of the canvas gesture (it must sit ON the box it acts on). It lives in
   the strip, so it scrolls and zooms with the page for free. */
.pdfe-actions { position: absolute; z-index: 4; display: none; gap: 2px; padding: 3px;
                border-radius: 8px; background: #fff; box-shadow: 0 2px 10px #00000059;
                white-space: nowrap; }
.pdfe-actions button { font: 600 13px/1 system-ui, -apple-system, sans-serif;
                       color: #1a237e; background: transparent; border: 0;
                       border-radius: 6px; padding: 8px 12px; cursor: pointer;
                       touch-action: manipulation; }
.pdfe-actions button:hover { background: #3f51b51f; }
.pdfe-actions .pdfe-act-del { color: #c62828; }
.pdfe-actions .pdfe-act-del:hover { background: #c628281f; }
.pdfe-caret { position: absolute; width: 2px; background: #000; z-index: 1;
              display: none; pointer-events: none; animation: pdfe-blink 1s steps(1) infinite; }
@keyframes pdfe-blink { 50% { opacity: 0; } }
.pdfe-selrect { position: absolute; background: #3f51b555; z-index: 1; pointer-events: none; }
.pdfe-handle { position: absolute; width: 18px; height: 18px; border-radius: 50%;
               background: #3f51b5; border: 2px solid #fff; box-shadow: 0 1px 4px #0007;
               z-index: 3; display: none; touch-action: none; cursor: grab; }
/* The CARET thumb: the insertion handle under a COLLAPSED caret, so a finger can
   drag the caret instead of having to tap the exact glyph. Its own class (not
   .pdfe-handle) because _drawHandles owns those two and hides them on every
   collapsed-caret message. Deliberately NOT inside .pdfe-caret: the caret blinks,
   and a blinking grip reads as a rendering fault. */
.pdfe-carethandle { position: absolute; width: 18px; height: 18px; border-radius: 50%;
                    background: #3f51b5; border: 2px solid #fff; box-shadow: 0 1px 4px #0007;
                    z-index: 3; display: none; touch-action: none; cursor: grab; }
/* The IME sink (WEB_VIEWER.md §7): 1x1, transparent, parked at the caret. NEVER
   a visible editor — it exists only to summon the keyboard and receive
   keystrokes/composition. pointer-events:none is LOAD-BEARING (I9): the sink
   sits exactly where the user taps next (the caret), and with hit-testing on it
   swallows that tap — the canvas never sees it, so the caret doesn't move and
   commit-on-tap-outside doesn't fire. Programmatic focus() still works. */
.pdfe-sink { position: absolute; left: -100px; top: -100px; width: 1px; height: 1px;
             padding: 0; border: 0; outline: 0; background: transparent; color: transparent;
             caret-color: transparent; resize: none; overflow: hidden; z-index: 1;
             pointer-events: none; font-size: 16px; /* prevents iOS focus-zoom */
             -webkit-user-select: text; user-select: text; }
`;

function injectStyles(doc) {
  if (doc.getElementById(PDFE_STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = PDFE_STYLE_ID;
  el.textContent = PDFE_CSS;
  doc.head.appendChild(el);
}

/** Errors the host is expected to branch on (never strings to parse). */
export class PdfeError extends Error {
  constructor(code, message, detail = {}) {
    super(message || code);
    this.name = "PdfeError";
    this.code = code;
    Object.assign(this, detail);
  }
}

/**
 * A colour to packed 0xAARRGGBB, or null if it cannot be parsed.
 *
 * Accepts a NUMBER (already packed — passed straight through, so a host can hand us
 * exactly what it stores) or a CSS-ish hex string: #rgb, #rrggbb, #rrggbbaa. A
 * string without alpha becomes OPAQUE, because <input type="color"> yields #rrggbb
 * and a user picking a colour there means a visible one.
 *
 * Deliberately NOT a full CSS colour parser: named colours and rgb()/hsl() would
 * need a canvas round-trip, and the palette is the host's business (it can convert).
 */
function parseArgb(color) {
  if (typeof color === "number" && Number.isFinite(color)) return color >>> 0;
  if (typeof color !== "string") return null;
  let h = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-f]{6}$/i.test(h)) h = "ff" + h;              // no alpha => opaque
  else if (/^[0-9a-f]{8}$/i.test(h)) h = h.slice(6) + h.slice(0, 6);  // rrggbbaa -> aarrggbb
  else return null;
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? null : (n >>> 0);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export class PdfeEditor {
  /**
   * @param {object} opts
   *  container       Element (or selector) the editor fills. The HOST sizes it.
   *  workerUrl       URL of pdfe-worker.js       (default: next to this module)
   *  engineUrl       URL of editor.js glue       (default: next to the worker)
   *  version         cache-buster appended to worker/engine URLs (optional)
   *  maxPageWidthCss fit-width ceiling in CSS px (default 900; 0 = no cap)
   *  initialZoom     zoom the document opens at, as a ratio of fit-width
   *                  (default 0.5 — i.e. the toolbar reads 50%). 1 = fit-width.
   *  minZoom/maxZoom zoom clamps (default 0.25 / 3)
   *  longPressMs     word-select press duration (default 600)
 *  backgroundColor surround behind the pages, any CSS colour
 *                  (default '#f8f9fb'); also settable later via
 *                  setBackgroundColor()
   *  simulateNoOpfs  dev knob: pretend saves cannot stream (exercises the
   *                  host's in-memory-consent path on a browser that has OPFS)
   */
  constructor(opts = {}) {
    const container = typeof opts.container === "string"
      ? document.querySelector(opts.container)
      : opts.container;
    if (!container) throw new PdfeError("no-container", "PdfeEditor needs a container element");

    this.container = container;
    this._doc = container.ownerDocument;
    this._win = this._doc.defaultView;
    injectStyles(this._doc);

    this.maxPageWidthCss = opts.maxPageWidthCss ?? 900;
    // minZoom sits BELOW initialZoom on purpose: at 0.5 (the old floor) the
    // zoom-out button would be dead the moment a document opened.
    this.minZoom = opts.minZoom ?? 0.25;
    this.maxZoom = opts.maxZoom ?? 3;
    this.initialZoom = opts.initialZoom ?? 0.5;
    this.longPressMs = opts.longPressMs ?? 600;
    // "auto" (default) binds Ctrl/Cmd+Z and Ctrl+Y / Ctrl+Shift+Z whenever the
    // editor was the last surface the user touched; "container" is the same but
    // stricter; "none" leaves the keyboard entirely to the host.
    this.undoShortcuts = opts.undoShortcuts ?? "auto";
    this._simulateNoOpfs = !!opts.simulateNoOpfs;
    this._backgroundColor = opts.backgroundColor || PDFE_DEFAULT_BG;
    // BLOCK MOVE (dragging a box to a new position) is EXPERIMENTAL and therefore
    // OFF unless a host opts in — user decision 2026-08-04, shipping it in 1.7.3.
    // DEFAULT ON since 2026-08-12 (user directive: box moving is no longer
    // experimental and ships in the next release). Off means the gesture is not
    // armed AND moveSelection() is a no-op, so a product that hits trouble with
    // it can still be switched back with one flag and no redeploy of this SDK
    // (docs/BLOCK_MOVE.md).
    this._blockMove = opts.blockMove ?? true;
    // ADD TEXT: armed between armAddText() and the tap that places a box.
    // Read by _tapWantsKeyboard, which must answer synchronously inside the
    // gesture for iOS to raise a keyboard at all (S39).
    this._addingText = false;

    // How long a picked typing colour lives (docs/STYLING.md §2). DEFAULT ON:
    // the colour lasts until the user moves the cursor, then the caret's own
    // colour takes over — what every word processor does, and what the core's
    // contract was written for. OFF keeps the pick sticky until the host clears
    // it, which is the behaviour a form-filling host wants when every field it
    // types into must come out one colour regardless of what was there.
    this._typingColorFollowsCaret = opts.typingColorFollowsCaret ?? true;
    // THE SAME TWO LIFETIMES FOR THE TYPEFACE (2026-08-20), and the same default. It
    // covers the family AND bold/italic together, because both are the core's one
    // typing-font slot — see docs/STYLING.md §2bis.
    this._typingFontFollowsCaret = opts.typingFontFollowsCaret ?? true;

    // ---- document/view state --------------------------------------------------
    this._pages = [];            // [{w,h}] PDF points
    this._painted = new Set();   // pages already painted at the current zoom
    this._livePages = new Set(); // pages whose canvas holds a bitmap (any zoom) —
                                 // the eviction sweep's working set (7000-page
                                 // documents cannot keep every visited bitmap)
    this._zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.initialZoom));
    this._fitScale = 1;          // CSS px per PDF point at zoom 1
    this._dpr = Math.min(this._win.devicePixelRatio || 1, 2);
    this._pageCanvases = [];
    this._pageOffsets = [];      // [[topInScroller, heightCss]] per page, cached per zoom
    this._currentPage = 0;       // the page the reader is looking at (drives `page`)
    this._reportedPage = -1;     // last value handed to the host (dedupe)
    this._docBytes = 0;
    this._docName = "";
    this._dirty = false;

    // ---- edit state -----------------------------------------------------------
    this._editMode = false;
    this._editingPage = -1;
    this._editingParaIndex = -1;
    // The BLOCK the open paragraph lives in — the box hidden while editing. A
    // block can hold several paragraphs, so the paragraph index alone cannot say
    // which box to hide.
    this._editingBlockIndex = -1;
    this._editingIsParagraph = false;
    this._editingLinePreserve = false;
    this._editingChars = 0;
    // page -> BLOCKS: [{ index, bounds:[l,b,r,t], paras:[{index, bounds}] }].
    // Blocks are the boxes; their member paragraphs are the edit units.
    this._pageGroups = new Map();
    this._groupsPending = new Set();
    this._selected = null;            // {page, index, bounds} — the WORKER decides this
    // A SELECTED PICTURE (docs/IMAGE_EDIT.md). Separate from _selected because
    // the two are different things to a host: a text box can be opened for
    // typing and deleted, a picture can be dragged and turned. `selectionKind`
    // is the one question a host's toolbar branches on.
    this._selectedImage = null;       // {page, index, bounds, quad, turns, flags}
    // Per-page picture geometry, the twin of _pageGroups — what the faint
    // outlines are drawn from, so a picture LOOKS interactive before it is
    // tapped, exactly as a text box does.
    this._pageImages = new Map();
    // Mirror of the ENGINE's history state. Never computed here: canUndo is
    // whatever the core says, so a stale local flag can never grey the wrong
    // button (docs/UNDO_REDO.md §1 S1).
    this._history = { canUndo: false, canRedo: false, undoPage: -1, redoPage: -1,
                      recording: false };
    // Set when the engine TRUNCATED the undo stack (PDFE_UNDO_UNAVAILABLE): the
    // document is still modified but the stack no longer proves it, so from here
    // on only a save or a fresh document may clear the flag. Without this, the
    // one path that empties the stack without reverting anything would report a
    // modified document as saved — and a host that gates its "discard changes?"
    // prompt on `dirty` would throw the edits away.
    this._dirtyUntracked = false;
    this._lastCaretGeom = null;
    this._lastEditBounds = null;      // [l,b,r,t] live bounds of the open run
    this._lastSelection = [];
    this._lastHandles = [null, null];
    this._selRange = null;
    // The engine's last style report for the character selection. A NULL FIELD
    // means MIXED; null overall means unknown/no run.
    this._textStyle = null;
    // In-flight loadFont() resolvers, keyed by the host's font name — a LIST per
    // name, because the worker interns a face once and answers once, so two callers
    // racing on the same name must both be resolved by that single reply (a single
    // slot would leave the first promise pending forever).
    this._fontWaits = new Map();
    // In-flight prepareFonts() resolvers. A LIST for the same reason: the bundled set is
    // registered once per document and answered once, so every waiter shares that reply.
    this._fontsWaits = [];
    this._bundledFamilies = [];
    this._editGeneration = 0;
    this._composing = false;
    // The caret thumb is TOUCH-ONLY (a permanent grip under a mouse caret is
    // not a desktop idiom), so the last pointer type that touched a page decides
    // whether it is drawn.
    this._lastPointerType = "mouse";
    this._draggingCaret = false;
    // A box drag is in flight. The Edit/Delete bar is parked for its duration:
    // the bar is positioned on the box's OLD rect, so leaving it up shows the
    // actions detached from the ghost the user is watching. Android does the
    // same thing (`onBoxDragStateChanged` -> GONE); this is the web/iOS half.
    this._draggingBox = false;
    // Double-tap/double-click word select: the last tap's time, point and page.
    this._lastTapAt = 0;
    this._lastTapX = 0;
    this._lastTapY = 0;
    this._lastTapPage = -1;

    this.latencySamples = [];    // keystroke->blit ms (dev telemetry / gates)
    this._listeners = new Map();
    this._pending = new Map();   // one-shot op promises: open / save
    this._caps = { canStreamSave: !opts.simulateNoOpfs, inHeapMaxMB: 0 };
    this._destroyed = false;

    this._buildDom();
    this._startWorker(opts);
  }

  // ===========================================================================
  // Public API — everything a host UI needs, and nothing about how it looks.
  // ===========================================================================

  /** Resolves once the engine is up: {canStreamSave, inHeapMaxMB}. */
  get ready() { return this._readyPromise; }

  get capabilities() { return { ...this._caps }; }
  get pageCount() { return this._pages.length; }
  get pages() { return this._pages.map((p) => ({ ...p })); }
  /**
   * The page the reader is looking at, 0-based — the one covering the most of the
   * visible band (ties go to the lower index, so a page boundary parked exactly
   * mid-viewport cannot flicker between two numbers). Hosts that show a "Page 3
   * of 12" label should listen for the `page` event rather than poll this.
   */
  get currentPage() { return this._currentPage; }
  get documentName() { return this._docName; }
  get documentBytes() { return this._docBytes; }
  get dirty() { return this._dirty; }
  get zoom() { return this._zoom; }
  get editMode() { return this._editMode; }
  /** Live edit session (null when nothing is open). */
  get editing() {
    if (this._editingPage < 0) return null;
    return {
      page: this._editingPage,
      paraIndex: this._editingParaIndex,
      blockIndex: this._editingBlockIndex,
      isParagraph: this._editingIsParagraph,
      linePreserve: this._editingLinePreserve,
      chars: this._editingChars,
    };
  }
  /** Escape hatch for test harnesses only — hosts must not post to it. */
  get worker() { return this._worker; }

  /**
   * Open a document. `source` may be a Blob/File, an ArrayBuffer/Uint8Array, or
   * a URL string (fetched here, so same-origin/CORS rules are the host's).
   * Bytes are handed to the worker BY REFERENCE (a Blob structured-clone costs
   * nothing) — see docs/WEB_IO.md §3 for the two-tier load.
   *
   * `opts.password` (default: none) unlocks an encrypted PDF. The SDK shows no
   * prompt of its own — it REJECTS and lets the host ask, with two distinct
   * PdfeError codes so the wording can differ:
   *   'password-required' — the file is encrypted and you passed no password.
   *   'password-wrong'    — the password you passed was rejected; ask again.
   * Retry by calling open() again with the same source and a password. The
   * password is used for that one open, never stored, never logged, and never
   * included in any event payload.
   */
  async open(source, opts = {}) {
    await this._readyPromise;
    let blob = source;
    if (typeof source === "string") {
      const res = await fetch(source);
      if (!res.ok) throw new PdfeError("open-failed", `fetch ${source} → ${res.status}`);
      blob = new File([await res.blob()], opts.name || source.split("/").pop() || "document.pdf");
    } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      blob = new File([source], opts.name || "document.pdf", { type: "application/pdf" });
    }
    if (!(blob instanceof Blob)) throw new PdfeError("bad-source", "open() needs a Blob, bytes or URL");

    this._docName = opts.name || blob.name || "document.pdf";
    this._docBytes = blob.size;
    this._dirty = false;
    this._dirtyUntracked = false;
    this._painted = new Set();
    this._selected = null;
    this._selectedImage = null;
    this._history = { canUndo: false, canRedo: false, undoPage: -1, redoPage: -1,
                      recording: false };
    this._closeEditUiState();
    const p = this._promiseFor("open");
    this._post({ type: "open", blob, tier: opts.tier || 0, blockKB: opts.blockKB || 0,
                 password: opts.password || "" });
    return p;
  }

  /**
   * Save. Commits any live edit first (in the worker, so nothing is lost), then
   * resolves with `{file, bytes, ms, flat, heapMB, tier, io}` — a File the HOST
   * delivers however it wants (download, File System Access, a native bridge).
   *
   * Rejects with PdfeError codes the host is expected to handle:
   *   'save-needs-consent' — this browser cannot stream saves (no OPFS sync
   *      handle, e.g. private browsing), so the whole output would sit in
   *      memory. Show your own warning, then retry save({allowInMemory:true}).
   *   'save-too-large'     — no streaming AND the document exceeds the in-heap
   *      ceiling (detail: sizeMB, limitMB). Refuse in your UI.
   * The SDK deliberately shows no dialog of its own.
   */
  async save(opts = {}) {
    // SAVING IMPLIES LEAVING THE BOX — one host call, not two (user directive
    // 2026-08-12), and the same order Android has always used (`afterCommit`).
    // The worker commits the run inside saveDocument() either way, so this is
    // not about losing text; it is about the UI: without it the box stayed open
    // and the KEYBOARD stayed up over the save sheet / download on iOS and
    // Android. Done here rather than in the worker because the sink and the
    // overlays live on this side.
    //
    // FIRST STATEMENT, BEFORE EVERY `await`: this must run inside the host's
    // click handler, synchronously. Behind an await it lands a microtask later,
    // outside the user gesture — the same constraint that forces editSelection()
    // to focus synchronously to raise a keyboard at all (S39), read the other way
    // round. It is also why this sits before the no-document check: leaving the
    // box is right even when the save then rejects.
    this.getOutOfBoxEditing();
    await this._readyPromise;
    if (!this._pages.length) throw new PdfeError("no-document", "nothing open to save");
    const forceInHeap = this._simulateNoOpfs || !!opts.forceInHeap;
    if (!this._caps.canStreamSave || forceInHeap) {
      const sizeMB = this._docBytes / (1024 * 1024);
      const limitMB = this._caps.inHeapMaxMB;
      if (limitMB && sizeMB > limitMB) {
        throw new PdfeError("save-too-large",
          "document too large to save without streaming storage",
          { sizeMB, limitMB });
      }
      if (!opts.allowInMemory) {
        throw new PdfeError("save-needs-consent",
          "saves cannot stream in this browser; confirm an in-memory save",
          { sizeMB, limitMB });
      }
    }
    const p = this._promiseFor("save");
    this._post({ type: "save", forceInHeap });
    return p;
  }

  /**
   * Tell the SDK the saved File has been fully consumed, so the staged OPFS copy
   * can be dropped (docs/WEB_IO.md §6). Only call this once your delivery has
   * finished reading the File — a browser download is still reading it.
   */
  releaseSaved() { this._post({ type: "reapStaging" }); }

  /**
   * Edit mode is the Android FAB analog: OFF = taps only scroll/zoom, nothing
   * edits; ON = faint paragraph boxes appear, taps open runs, long-press
   * selects a word. Turning it off commits any open run.
   */
  setEditMode(on) {
    on = !!on;
    if (this._editMode === on || this._destroyed) return;
    this._editMode = on;
    if (on) {
      this._sweepVisible();
    } else {
      // Turning edit mode off is leaving box editing, keyboard included.
      this.getOutOfBoxEditing();
      this._post({ type: "deselect" });
      this._selected = null;
      this._selectedImage = null;
      this._pageGroups.clear();
      this._pageImages.clear();
      this._groupsPending.clear();
      this._renderBoxes();
    }
    this._emit("editmode", { editMode: on });
  }
  toggleEditMode() { this.setEditMode(!this._editMode); }

  /**
   * LEAVE BOX EDITING — the programmatic form of tapping outside the box, and
   * what a host should call when its own chrome needs the user out of a run
   * (a Done button, a route change, opening a dialog, before a save).
   *
   * Keeps the typing: the run is committed into the document, never discarded.
   *
   * AND DROPS THE KEYBOARD, which is the half a host cannot do itself: the
   * typing target is our internal sink, so only we can blur it. Without this the
   * box closed while the on-screen keyboard stayed up over whatever the host
   * showed next — visible on Android and iOS, invisible on desktop, which is
   * why it survived so long. Android's SDK has always hidden the IME here
   * (`hideEditBox`); this is web/iOS catching up.
   *
   * Safe to call when nothing is open — then it does nothing at all.
   */
  getOutOfBoxEditing() {
    if (this._editingPage >= 0) this._post({ type: "commit" });
    this._setSinkFocus(false);
  }

  /**
   * The original name for {@link getOutOfBoxEditing}, kept forever: hosts ship
   * against it and removing a public method is a MAJOR break
   * (docs/CONSUMER_CONTRACT.md). Identical behaviour, including the keyboard.
   */
  commit() { this.getOutOfBoxEditing(); }

  /**
   * The paragraph the user has SELECTED (first tap in edit mode) — the state
   * between "nothing" and "typing": `{page, index}` or null. The SDK draws the
   * selected box and its Edit / Delete bar itself; these commands exist so a
   * host can drive the same two actions from its own chrome.
   */
  get selection() {
    return this._selected ? { page: this._selected.page, index: this._selected.index } : null;
  }
  /**
   * WHAT IS SELECTED: "text", "image", or null. The one question a host's
   * toolbar branches on — turn-left/turn-right belong to a picture, Edit and
   * Delete to a text box.
   *
   * A READABLE state, not only an observable one: the `select` event carries the
   * same `kind`, but a host that reloads (or a native shell whose web view was
   * recreated) has no event history to replay, so it must be able to ASK. That
   * is parity rule 13's requirement, and this is its sixth state.
   */
  get selectionKind() {
    if (this._selectedImage) return "image";
    if (this._selected) return "text";
    return null;
  }
  /** The selected picture, or null: {page, index, bounds, quad, quarterTurns, clipped}. */
  get imageSelection() {
    const im = this._selectedImage;
    if (!im) return null;
    return { page: im.page, index: im.index, bounds: im.bounds, quad: im.quad,
             quarterTurns: im.turns ?? 0, clipped: !!(im.flags & 1) };
  }
  /**
   * Turn the selected PICTURE by |turns| x 90 degrees about its own centre.
   * Positive is clockwise. A no-op (and harmless) when the selection is text or
   * empty — a host may wire the buttons unconditionally.
   *
   * There is deliberately no free-angle version: the gesture is two buttons
   * (docs/IMAGE_EDIT.md §1, closed by user decision 2026-08-25).
   */
  rotateSelection(turns = 1) {
    if (!this._selectedImage) return false;
    this._post({ type: "rotateImage", turns: Math.trunc(Number(turns) || 0) });
    return true;
  }
  /**
   * Move the selected PICTURE by (dx, dy) PDF points. The drag gesture uses this
   * too. Clamped by the core so the picture lands on the page.
   */
  moveImageSelection(dx, dy) {
    if (!this._selectedImage) return false;
    this._post({ type: "moveImage", dx: Number(dx) || 0, dy: Number(dy) || 0 });
    return true;
  }
  /**
   * Open the selected paragraph for typing (the Edit action).
   *
   * THIS is the gesture that asks for a keyboard. Focus here, synchronously,
   * because iOS raises the keyboard only inside a user gesture and the worker's
   * "opened" reply lands long after the host's click handler has returned — so
   * focusing on the reply would open the run with no keyboard (S39). Hosts call
   * this from a real click; if one ever calls it programmatically the focus is
   * harmless, it simply will not raise a keyboard.
   */
  editSelection() {
    if (!this._selected) return;
    this._post({ type: "openSelected" });
    this._setSinkFocus(true);
  }
  /**
   * Delete the selected paragraph: its text is removed from the PDF's real text
   * layer and the page repaints in place — no dialog, no confirmation (the host
   * owns confirm policy, as it owns save). It IS undoable — see `undo()`.
   */
  deleteSelection() { if (this._selected) this._post({ type: "deleteSelected" }); }
  /** Drop the selection (the tap-on-empty-space gesture). */
  clearSelection() {
    if (this._selected || this._selectedImage) this._post({ type: "deselect" });
  }
  /**
   * Move the selected box by (dx, dy) PDF points — the programmatic sibling of
   * the drag gesture, for a host that wants nudge buttons or arrow keys.
   */
  moveSelection(dx, dy) {
    if (!this._blockMove) return;          // experimental, off unless opted in
    if (this._selected) this._post({ type: "moveSelected", dx, dy });
  }

  /** Is box dragging enabled? EXPERIMENTAL, off unless the host opted in. */
  get blockMove() { return this._blockMove; }

  /**
   * Turn box dragging on or off at runtime — the kill switch for an
   * EXPERIMENTAL feature (`blockMove` in the constructor sets the initial value,
   * and the default is OFF). Turning it off disarms the gesture and makes
   * `moveSelection()` a no-op; it does not undo a move already applied.
   */
  setBlockMove(on) {
    this._blockMove = !!on;
    if (!this._blockMove && this._draggingBox) {
      // A drag in flight stops here — and the bar it parked has to come back,
      // or switching the feature off mid-gesture strands the selection with no
      // actions until the next re-render.
      this._draggingBox = false;
      this._renderBoxes();
    }
    if (!this._blockMove) this._hideMoveGhost();
    return this._blockMove;
  }

  // ---- ADD TEXT: place a new box where the document has none ---------------
  // docs/ADD_TEXT.md. An ARMED MODE, never a heuristic on an existing tap:
  // tap-on-empty already means deselect and tap-outside already means commit, and
  // both are load-bearing. So the host arms, the next tap places, and the arm is
  // spent — one box per arming.

  /**
   * Is Add Text armed right now? True between `armAddText()` and the tap that
   * places a box (or `cancelAddText()`). Read it rather than mirroring the
   * `addtextarmed` event into a field of your own — one missed event and the mirror
   * is wrong forever.
   */
  get addingText() { return this._addingText; }

  /**
   * Arm Add Text: the NEXT tap on the page creates an empty text box there, with
   * the caret already inside it, and the user types. The arm is consumed by that
   * tap. Typing, styling, undo, save and dragging then work exactly as they do in
   * any other box.
   *
   * Nothing is created until a character is typed — a box the user places and taps
   * away from simply evaporates, leaving no object and no undo step.
   *
   * The new text's font, size and colour come from `setNewTextStyle()`; with none
   * set you get Helvetica 12pt black, which resolves identically on every platform.
   */
  armAddText() {
    if (!this._editMode) this.setEditMode(true);   // placing text IS editing
    this._post({ type: "armAddText" });
    return true;
  }

  /** Disarm Add Text without placing anything. Safe to call when not armed. */
  cancelAddText() { this._post({ type: "cancelAddText" }); }

  /**
   * The default look for text created by `armAddText()`. Every field is optional and
   * independent, so setting only `color` leaves the face and size alone.
   *
   * @param {{font?: string|null, size?: number, color?: number|string|null}} style
   *   `font` is a family name you have loaded with `loadFont()` (or a standard-14
   *   name); a name this document cannot resolve falls back to the built-in
   *   Helvetica rather than failing. `size` is in points. `color` accepts the same
   *   forms as `applyTextColor`.
   */
  setNewTextStyle(style = {}) {
    const msg = { type: "setNewTextStyle" };
    if ("font" in style) msg.fontName = style.font || null;
    if ("size" in style) msg.sizePt = Number(style.size) || 0;
    if ("color" in style) {
      // parseArgb is the ONE colour parser this SDK has (applyTextColor uses it), so a
      // host's "#c00" means the same thing here as it does there. An unparseable value
      // is reported rather than silently becoming black, and the seed is left alone.
      if (style.color == null) msg.colorArgb = 0;
      else {
        const argb = parseArgb(style.color);
        if (argb === null) {
          this._emit("error",
            { code: "color-failed", detail: `unparseable colour: ${style.color}` });
          return;
        }
        msg.colorArgb = argb >>> 0;
      }
    }
    this._post(msg);
  }

  // ---- character-level styling: colour ------------------------------------
  // The PALETTE IS THE HOST'S BUSINESS (user directive 2026-08-10: "its on client
  // side, how many color they want to use. they will pass selected color to our
  // sdk"). This SDK owns no colour identity, no swatch list and no naming — it
  // takes any 32-bit value and reports what the engine finds.

  /**
   * Apply a colour to the character selection in the open run, AND make it the
   * colour of newly typed characters. No-op when no run is open. With a bare caret
   * it sets only the typing colour, which is a real capability, not a failure.
   *
   * `color`: 0xAARRGGBB, or "#rgb" / "#rrggbb" / "#rrggbbaa".
   */
  applyTextColor(color) {
    // ⚠️ A STICKY PICK IS ALLOWED WITH NO RUN OPEN — the same rule applyFont carries, and
    // reported by the user in the same session (2026-08-20): *"if you are out of a box and
    // set a colour, then enter a box, it is not writing the new text in the new colour."*
    // Sticky means "everything I type from now on", which includes the box the host has
    // not opened yet. In FOLLOW mode the early return stands: an arm with no caret to
    // follow is meaningless.
    if (this._editingPage < 0 && this._typingColorFollowsCaret) return;
    const argb = parseArgb(color);
    if (argb === null) {
      this._emit("error", { code: "color-failed", detail: `unparseable colour: ${color}` });
      return;
    }
    // Styling the selection IS an interaction with the editor, so the next
    // Ctrl+Z belongs to us — even though the gesture's pointerdown landed on
    // the host's colour control and released the ownership latch. Ownership
    // only; deliberately NO sink.focus(): a native picker popup may still be
    // open (live drag), and on iOS a focus() here would pop the keyboard
    // mid-pick (the S39 rule).
    this._ownsKeyboard = true;
    // THE SINK IS THE AUTHORITY for the range, not this._selRange: Shift+arrow moves
    // the sink's own selection before the worker has replied. Same rule Android
    // follows by re-reading its IME sink live.
    const s = this.sink.selectionStart, e = this.sink.selectionEnd;
    // Typing colour first, so it is armed even if there is no range to paint.
    // A COLLAPSED pick carries the caret index it was armed at (`at`): picking
    // in a host control steals focus, and the user's click back to that SAME
    // index must keep the pick instead of dropping it (the worker's
    // postCaretMoved owns that rule — docs/STYLING.md §2). A range apply sends
    // no index: the painted text needs no revival.
    // `at` is -1 when there is no run open: a sticky pick made outside a box was armed
    // at no caret, so there is no same-index revival to remember.
    this._post({ type: "setTypingColor", argb, set: 1,
                 at: this._editingPage < 0 || e > s ? -1 : s });
    if (e > s) this._post({ type: "applyColor", argb, start: s, end: e });
  }

  /**
   * Apply a font SIZE to the character selection, in the same two-verb shape as
   * `applyTextColor`: a range is restyled, and a bare caret arms the size that newly
   * typed characters take.
   *
   * `pt` is EFFECTIVE (on-page) points — what the user picked from your dropdown, not
   * text-space units. On a matrix-scaled document those differ, and the core divides
   * by |matrix.a| for you (I12); a host that pre-divided would halve the size twice.
   *
   * THE TYPING SIZE FOLLOWS THE CARET and that is its only lifetime — dropped when the
   * cursor moves, with no sticky mode and no switch, matching the font family (the
   * sticky option is colour-only by user decision — docs/STYLING.md §2).
   *
   * A non-positive size is REFUSED, not clamped: nothing changes and the host gets an
   * `error` event with code `size-failed`. (`styleApplied` is an INTERNAL worker→shell
   * message and `bad-size` an internal reason string — neither is public surface, and
   * naming them here sent a client host looking for an event that does not exist.)
   *
   * Bind your dropdown's current value to `textStyle.sizePt`, which arrives with every
   * `styled`/`selection` event and is `null` when the range mixes sizes — so the
   * control can show "mixed" rather than lying about one of them.
   */
  applyFontSize(pt) {
    if (this._editingPage < 0) return;
    const sizePt = Number(pt);
    if (!(sizePt > 0)) {
      this._emit("error", { code: "size-failed", detail: `bad font size: ${pt}` });
      return;
    }
    // Same ownership rule as applyTextColor and applyFont: styling IS an interaction
    // with the editor, so the next Ctrl+Z is ours even though the gesture landed on
    // the host's dropdown. Deliberately no sink.focus() — a native <select> popup may
    // still be open, and on iOS focusing here pops the keyboard mid-pick (S39).
    this._ownsKeyboard = true;
    // THE SINK IS THE AUTHORITY for the range, not this._selRange — Shift+arrow moves
    // it before the worker has replied.
    const s = this.sink.selectionStart, e = this.sink.selectionEnd;
    // Typing size first, so a collapsed pick is armed even with no range to paint. The
    // collapsed case carries the caret index it was armed at for the same reason
    // colour does: picking in a host control steals focus, and the click back to that
    // same index must keep the pick rather than drop it.
    this._post({ type: "setTypingSize", sizePt, set: 1, at: e > s ? -1 : s });
    if (e > s) this._post({ type: "applySize", sizePt, start: s, end: e });
  }

  /**
   * Drop the typing-SIZE override, back to inheriting from the character on the left.
   * The twin of `clearTypingColor`, and the shell calls it on the same occasions: an
   * explicit cursor move, never on typing.
   */
  clearTypingSize() {
    if (this._editingPage < 0) return;
    this._post({ type: "setTypingSize", sizePt: 0, set: 0 });
  }

  /**
   * Drop the typing-colour override, back to inheriting from the character on the
   * left. THE SHELL CALLS THIS ON AN EXPLICIT CURSOR MOVE — a tap, an arrow key, a
   * handle drag — and never on typing. The core cannot make that distinction (both
   * arrive as a new caret), which is why the lifetime lives here.
   */
  clearTypingColor() {
    if (this._editingPage < 0) return;
    this._post({ type: "setTypingColor", argb: 0, set: 0 });
  }

  /**
   * Choose how long a picked typing colour lives — both behaviours are supported
   * and this switches between them at runtime (docs/STYLING.md §2):
   *
   * - `true` (default): the pick applies to what you type next, and is DROPPED
   *   the moment the user moves the cursor — the caret's own colour takes over
   *   and a `styled` event with `what: "caret"` tells you what it now is, so
   *   your swatch can follow. What a word processor does.
   * - `false`: the pick is STICKY until `clearTypingColor()`, so everything typed
   *   in this session comes out that colour wherever the cursor goes. What a
   *   form-filling host wants.
   *
   * The caret's colour is still reported either way — only the override's
   * lifetime changes — so a host can show it without adopting the behaviour.
   */
  setTypingColorFollowsCaret(on) {
    this._typingColorFollowsCaret = !!on;
    this._post({ type: "setTypingColorFollowsCaret", on: this._typingColorFollowsCaret });
    return this._typingColorFollowsCaret;
  }
  /** Whether a picked typing colour is dropped when the cursor moves. */
  get typingColorFollowsCaret() { return this._typingColorFollowsCaret; }

  /**
   * Choose how long a picked TYPEFACE lives — the exact twin of
   * `setTypingColorFollowsCaret`, added 2026-08-20 (docs/STYLING.md §2bis):
   *
   * - `true` (default): a family pick or a B/I press at a bare caret applies to what
   *   you type next and is DROPPED when the cursor moves.
   * - `false`: it is STICKY — it survives cursor moves AND box changes, until you set
   *   the mode back or apply `null` (Original). What a form-filling host wants when
   *   every field it types into must come out in one typeface.
   *
   * ⚠️ **It covers the family and bold/italic together**, because both are one slot in
   * the engine. Sticky bold is sticky bold in whatever family the next box uses — the
   * intent is replayed there, and silently skipped if that family has no such face.
   *
   * ⚠️ **In sticky mode the `styled` event still reports the typeface UNDER the
   * cursor**, exactly as it does for colour, so a host painting its picker blindly
   * would show the context font while the next keystroke takes the pick. Read this
   * getter and skip the repaint — the same guard the reference hosts use for colour.
   *
   * Returns the value in force afterwards.
   */
  setTypingFontFollowsCaret(on) {
    this._typingFontFollowsCaret = !!on;
    this._post({ type: "setTypingFontFollowsCaret", on: this._typingFontFollowsCaret });
    return this._typingFontFollowsCaret;
  }
  /** Whether a picked typeface (family or bold/italic) is dropped when the cursor moves. */
  get typingFontFollowsCaret() { return this._typingFontFollowsCaret; }

  /** Ask the engine for the style at a caret or over a range; answered by `styled`. */
  requestTextStyle(start, end) {
    if (this._editingPage < 0) return;
    this._post({ type: "styleAt", start: start | 0, end: (end == null ? start : end) | 0 });
  }

  // ---- character-level styling: the font FAMILY, and bold / italic ---------
  // THE HOST PROVIDES THE VARIANTS (user decision 2026-08-13). This SDK bundles no
  // font catalog — no name list, no bytes, no default ladder — for the same reason it
  // owns no colour palette: which typefaces a product offers is the product's
  // decision, and a bundled catalog is one every consumer would have to fight.
  //
  // So a face reaches the engine one way: the host loads it here. That was the whole
  // gap on web — Android has had applyFont since its own picker shipped, and what it
  // had that web did not was DELIVERY, not plumbing.

  /**
   * Register a font face the host provides, so it can be applied by name and so
   * Bold/Italic can find it as a sibling of its family.
   *
   * ```js
   * await editor.loadFont({ name: "Helvetica-Bold" });            // a standard-14 face
   * await editor.loadFont({ name: "Roboto", bytes: ttfBytes });   // an embedded TTF
   * ```
   *
   * `name` is the identity you apply by — your own label, not a filename. Pass
   * `bytes` (ArrayBuffer/TypedArray) to embed a real font, or omit it to load a
   * standard-14 face by its PDF name ("Helvetica", "Times-Bold", "Courier-Oblique"…).
   * Embedded faces auto-embed on save.
   *
   * REGISTER EVERY VARIANT YOU WANT TO OFFER. `applyBold`/`applyItalic` resolve the
   * SIBLING FACE of the family already under the cursor, and refuse when that face
   * does not exist — they never synthesise a bold or slant a face by matrix. So a
   * host that wants Bold to work on Roboto text loads Roboto-Bold too; the engine
   * pairs them by family on its own (it reads the family, weight and slant off the
   * font, so you do not restate them).
   *
   * Handles belong to the open DOCUMENT: re-register after opening another file.
   * Resolves to `{ ok, name }`; `ok: false` carries a `reason`.
   */
  loadFont(spec) {
    const name = String((spec && spec.name) || "");
    if (!name) {
      this._emit("error", { code: "bad-source", detail: "loadFont needs a name" });
      return Promise.resolve({ ok: false, name, reason: "bad-source" });
    }
    let bytes = spec && spec.bytes;
    if (bytes && !(bytes instanceof ArrayBuffer)) {
      // Copy out of any TypedArray view so the transfer carries only these bytes.
      bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return new Promise((resolve) => {
      const waits = this._fontWaits.get(name);
      if (waits) { waits.push(resolve); return; }   // already in flight: share the reply
      this._fontWaits.set(name, [resolve]);
      // The bytes are TRANSFERRED, not copied: a font file is up to a few MB and the
      // worker interns it into the document immediately.
      this._post({ type: "loadFont", name, bytes: bytes || null },
                 bytes ? [bytes] : undefined);
    });
  }

  /**
   * Await the SDK's own bundled font families, and learn which ones there are.
   *
   * THEY REGISTER AUTOMATICALLY on every open — you do not have to call this to get
   * working bold/italic, and that is deliberate: which faces are registered decides which
   * face a bold/italic apply resolves to, and that answer lands in SAVED BYTES, so
   * "the host forgot to call it" must not be a way for this platform to diverge from
   * Android (docs/FONTS.md §2bis).
   *
   * What this gives you is the TIMING: the returned promise settles when the faces have
   * landed, so you can show a spinner and only then tell the user the fonts are usable.
   * Resolves `{ ok, families: [{ key, label, faces }], failed: [] }`; `families` is what a
   * picker should offer, and `key` is what a style report's `fontFamily` will match.
   *
   * Add your OWN faces with `loadFont()` — they sit alongside these. Note that a face you
   * add reaches one platform only; ours are the same everywhere by construction.
   */
  prepareFonts() {
    return new Promise((resolve) => {
      this._fontsWaits.push(resolve);
      this._post({ type: "prepareFonts" });
    });
  }

  /**
   * Apply a font FAMILY, in the same two-verb shape as `applyTextColor`: with a range
   * selected it restyles that range; with a bare caret it sets the font NEWLY TYPED
   * text takes.
   *
   * `name` is one you passed to `loadFont`. `null` means ORIGINAL — every character
   * keeps the font it already had, which is a real value here (a font has a "no
   * change" sentinel where a colour cannot, since every 32-bit value is a legal
   * colour).
   *
   * THE TYPING FONT FOLLOWS THE CARET by default: it is dropped the moment the cursor
   * moves. `setTypingFontFollowsCaret(false)` makes the pick STICKY instead — it then
   * survives caret moves AND box changes, which is the mode a form-filling host wants
   * (the colour-only rule was reversed 2026-08-20). One exception in FOLLOW mode, the
   * same one colour has — a click back to the SAME caret index keeps the pick, because
   * picking in your own control steals focus and the click back is "give me my
   * keyboard", not a move.
   */
  applyFont(name) {
    // ⚠️ A STICKY PICK IS ALLOWED WITH NO RUN OPEN, and that is the whole point of the
    // mode (user-reported 2026-08-20): a form-filling host picks the typeface FIRST and
    // then starts clicking fields. Before this, the call was silently dropped and the
    // host's picker was left showing a font that would never be applied — "it shows that
    // font in the UI, but that font is not applying on the new text I am writing".
    // In FOLLOW mode the early return stands: an arm with no caret to follow is
    // meaningless, and dropping it is what has always happened.
    if (this._editingPage < 0 && this._typingFontFollowsCaret) return;
    // Same ownership rule as applyTextColor: styling IS an interaction, so the next
    // Ctrl+Z is ours even though the gesture landed on the host's picker. No focus()
    // — a native <select> popup may still be open.
    this._ownsKeyboard = true;
    const s = this.sink.selectionStart, e = this.sink.selectionEnd;
    this._post({ type: "applyFont", name: name == null ? null : String(name),
                 start: s, end: e });
  }

  /**
   * Turn BOLD on or off over the character selection.
   *
   * There is no bold PROPERTY in a PDF — only a different font — so this resolves the
   * bold sibling of the family under the cursor and applies it. When that face does
   * not exist it REFUSES and changes nothing, raising `error` with code
   * `no-such-face`: no synthetic emboldening, and never another family's bold face
   * (user decision 2026-08-13). Load the variant with `loadFont` and it works.
   *
   * Bind your button's `disabled` to `textStyle.canBold` and its pressed state to
   * `textStyle.boldPressed` — NOT to `textStyle.bold`, which is null over a mixed
   * range and jams the toggle on (that is why boldPressed exists). Both come with
   * every `styled`/`selection` event, so the button is right before the user clicks
   * rather than after. `canBold` means "at least one font in the range can take the
   * face", so an enabled button can still decline with `mixed-fonts`.
   *
   * A BARE CARET ARMS the face for what is typed next, exactly as a colour or a
   * family does — a `styled` event with `what: "typingFace"`, nothing repainted, and
   * the document NOT marked dirty. It does not refuse, so gate the button on
   * `canBold` alone and never on having a selection.
   */
  applyBold(on) { this._applyFace(on == null ? true : !!on, null); }

  /** Turn ITALIC on or off over the selection. Everything in `applyBold` applies,
   *  with `canItalic` / `italic` as the button's inputs. */
  applyItalic(on) { this._applyFace(null, on == null ? true : !!on); }

  /** Both toggles are one engine call, because they are one mechanism: italicising
   *  bold text needs the bold-italic FACE, not two independent flags. null = leave
   *  that property as it is. */
  _applyFace(bold, italic) {
    if (this._editingPage < 0) return;
    this._ownsKeyboard = true;
    const s = this.sink.selectionStart, e = this.sink.selectionEnd;
    this._post({ type: "applyFace", bold, italic, start: s, end: e });
  }

  /** The character range selected inside the open run, or null (no run / bare caret).
   *  Read LIVE from the sink, so it is always exact. Prefer the `selection` event. */
  get textSelection() {
    if (this._editingPage < 0) return null;
    const s = this.sink.selectionStart, e = this.sink.selectionEnd;
    return e > s ? { start: s, end: e } : null;
  }

  /** The ENGINE's last report for that range. A NULL FIELD MEANS MIXED — show a
   *  blank control, never a guess. Cached from the last event; prefer `selection`. */
  get textStyle() { return this._textStyle || null; }

  // ---- undo / redo --------------------------------------------------------
  // The history lives in the ENGINE, not here (docs/UNDO_REDO.md): every
  // mutating core call records its own inverse, so nothing the SDK does can
  // leave a step unrecorded. This surface is just the two verbs plus the state
  // a host greys its buttons on.

  /** Undo the last change (typing, a box drag, a delete). No-op when empty. */
  undo() { this._post({ type: "undo" }); }
  /** Redo the last undone change. No-op when empty. */
  redo() { this._post({ type: "redo" }); }
  /** True when there is something to undo — drives an Undo button's enabled state. */
  get canUndo() { return this._history.canUndo; }
  /** True when there is something to redo. */
  get canRedo() { return this._history.canRedo; }
  /** 0-based page the next undo would affect, or -1. Lets a host label the button. */
  get undoPage() { return this._history.undoPage; }
  /** 0-based page the next redo would affect, or -1. */
  get redoPage() { return this._history.redoPage; }

  /**
   * DIAGNOSTIC: the engine's whole journal, for a debug panel or a bug report.
   * Resolves to the object `pdfe_history_describe` produced (null with no
   * document): `{undo:[…], redo:[…], undoCount, redoCount, bytes, maxEntries,
   * maxBytes, previewChars, suspended, liveAnchor, stagedDelete}`, each stack
   * OLDEST FIRST so the last element is the step the next undo will apply.
   *
   * It comes from the CORE, not from anything this file remembers — a
   * shell-side mirror would show what the SDK believes was recorded, which is
   * useless precisely when the belief is wrong. **The shape is diagnostic and
   * may gain fields at any time: display it, never branch on it.**
   */
  async historyDump() {
    await this._readyPromise;
    const p = this._promiseFor("historyDump");
    this._post({ type: "historyDump" });
    return p;
  }

  setZoom(z) {
    const next = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    if (next === this._zoom) return;
    this._zoom = next;
    this._applyZoom();
    this._repositionOverlays();
    this._emit("zoom", { zoom: next });
  }
  zoomIn(step = 1.25) { this.setZoom(this._zoom * step); }
  zoomOut(step = 1.25) { this.setZoom(this._zoom / step); }
  /** Reset to fit-width (zoom 1) and re-measure the container. */
  fitWidth() { this._zoom = 1; this._refit(); this._emit("zoom", { zoom: 1 }); }

  /** The surround behind the pages (each page paints its own white). */
  get backgroundColor() { return this._backgroundColor; }

  /**
   * Recolour the surround at runtime — any CSS colour. Pass a falsy value to
   * return to the default. Purely visual: no re-render, no reflow, nothing
   * cached, so a host may drive it from a theme switch on every frame if it
   * likes. Native shells reach it through the bridge command of the same name.
   */
  setBackgroundColor(color) {
    this._backgroundColor = color || PDFE_DEFAULT_BG;
    if (this.root) this.root.style.setProperty("--pdfe-bg", this._backgroundColor);
    return this._backgroundColor;
  }

  /**
   * Per-paragraph line mode (the Android btnLineMode analog): reflow (¶) vs
   * keep-lines (≡). The core's heuristic already picks one when a run opens;
   * this flips the open run. Only meaningful while `editing.isParagraph`.
   */
  toggleLineMode() { if (this._editingPage >= 0) this._post({ type: "toggleLineMode" }); }
  setLineMode(preserve) {
    if (this._editingPage >= 0 && !!preserve !== this._editingLinePreserve) this.toggleLineMode();
  }

  /**
   * Jump to a page (0-based): its top edge goes to the top of the view. This is the
   * "Go to page" a host's page box drives — the host owns the input, this owns the
   * scroll. Returns `false` for an out-of-range page (nothing moves) so a host can
   * mark its field invalid; it never throws.
   *
   * Out-of-range is rejected rather than clamped: a host that typed 500 into a
   * 12-page document wants to know, and silently landing on page 12 hides the typo.
   *
   * An open paragraph is left open (jumping is not committing — that is the host's
   * decision, like save). Note that typing afterwards scrolls the caret back into
   * view, so a host offering "go to page" mid-edit usually wants `commit()` first.
   */
  goToPage(page) {
    const i = Math.trunc(Number(page));
    if (!Number.isFinite(i) || i < 0 || i >= this._pageCanvases.length) return false;
    if (!this._pageOffsets.length) this._measurePageOffsets();
    this.scroller.scrollTop = this._pageOffsets[i][0] - 8;
    // Announce the new page now instead of waiting for the browser's scroll event,
    // so a host that shows a page label sees it update in the same task.
    this._updateCurrentPage();
    return true;
  }

  /** @deprecated since 1.2 — use {@link goToPage}. Kept for existing hosts. */
  scrollToPage(page) { return this.goToPage(page); }

  /**
   * Scroll the caret into view if it is outside (or nearly outside) the visible
   * area — the Android scroll-into-view analog. Called automatically when a run
   * opens and when the caret moves; hosts also call it after their own layout
   * changes (e.g. an on-screen keyboard shrinking the container on iOS).
   */
  scrollCaretIntoView(margin = 48) {
    if (this._editingPage < 0 || !this._lastCaretGeom || this._pinchActive) return;
    const g = this._lastCaretGeom;
    const top = this._pageToCss(g[0], g[1]);
    const bot = this._pageToCss(g[0], g[2]);
    if (!top) return;
    // Strip coords -> scroll coords (the strip is the scroller's only child).
    // _stripTop comes from the offsets cache — no layout read per keystroke.
    const y0 = this._stripTop + top.y, y1 = this._stripTop + bot.y;
    const x = this._stripLeft + top.x;
    const viewH = this.scroller.clientHeight, viewW = this.scroller.clientWidth;
    const sTop = this.scroller.scrollTop, sLeft = this.scroller.scrollLeft;
    if (y0 - margin < sTop) this.scroller.scrollTop = Math.max(0, y0 - margin);
    else if (y1 + margin > sTop + viewH) this.scroller.scrollTop = y1 + margin - viewH;
    if (x - margin < sLeft) this.scroller.scrollLeft = Math.max(0, x - margin);
    else if (x + margin > sLeft + viewW) this.scroller.scrollLeft = x + margin - viewW;
  }

  // ---- undo/redo keyboard --------------------------------------------------
  //
  // TWO listeners, one handler, because the sink only holds focus while a run is
  // open — and Ctrl+Z must also work with nothing selected, to undo a delete or
  // a box drag.
  //
  // The preventDefault() below is LOAD-BEARING, not tidiness. Without it the
  // textarea's OWN native undo fires, reverts the sink's value, and that fires
  // `input` — which posts a full-buffer edit to the core. The user's undo would
  // silently become an edit. That is corruption, not a cosmetic bug.
  //
  /** @returns true when the key was consumed. */
  _handleHistoryKey(e) {
    if (this._composing || e.isComposing || e.keyCode === 229) return false;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const k = (e.key || "").toLowerCase();
    // Cmd+Y is a browser binding on macOS; only bind Ctrl+Y.
    const isRedo = (k === "y" && !e.metaKey) || (k === "z" && e.shiftKey);
    const isUndo = k === "z" && !e.shiftKey;
    if (!isUndo && !isRedo) return false;
    e.preventDefault();
    e.stopPropagation();
    if (isRedo) this.redo(); else this.undo();
    return true;
  }

  /**
   * Could this element hold a TEXT CARET — i.e. does it have text undo of its own
   * to protect from our Ctrl+Z? The one question both history-key guards ask
   * (I67). `<select>`, `<button>`, a colour swatch, a range slider and a plain div
   * all answer no: they take focus but they cannot be typed into.
   *
   * An INPUT with no `type` defaults to text, hence the empty alternative.
   */
  static _caretCapable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName || "";
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    return /^(|text|search|email|url|tel|password|number)$/.test((el.type || "").toLowerCase());
  }

  _wireHistoryKeys() {
    if (this.undoShortcuts === "none") return;
    // Which surface the user last touched. Without this the SDK would steal
    // Ctrl+Z from a host that has its own binding elsewhere on the page.
    //
    // ONLY A CARET-CAPABLE SURFACE TAKES OWNERSHIP AWAY (I67). Releasing it on any
    // outside pointerdown made every host toolbar click disarm Ctrl+Z until the user
    // happened to click back into the page — the same defect as the keydown guard
    // below, one event earlier, and the reason S45 had to hand `_ownsKeyboard = true`
    // to applyTextColor and then to every style verb added after it. A toolbar that
    // acts ON this editor is not a rival for the chord; a host's text field is. So
    // host chrome leaves ownership exactly as it was, and the style verbs' re-take
    // stays as the belt to this braces.
    this._ownsKeyboard = false;
    this._listen(this._doc, "pointerdown", (e) => {
      if (this.container.contains(e.target)) { this._ownsKeyboard = true; return; }
      if (PdfeEditor._caretCapable(e.target)) this._ownsKeyboard = false;
    }, true);
    this._listen(this._doc, "keydown", (e) => {
      if (e.defaultPrevented) return;                  // the sink listener got it
      if (this.undoShortcuts === "container" && !this._ownsKeyboard) return;
      if (!this._ownsKeyboard) return;
      // Never steal from a real input the host owns outside our container —
      // where "real" means IT HAS TEXT UNDO TO PROTECT. A colour swatch, range
      // slider, checkbox or DROPDOWN cannot hold a caret, so Ctrl+Z aimed at one
      // is aimed at the DOCUMENT.
      //
      // ASKED AS "CAN IT HOLD A CARET?", NOT AS A LIST OF EXCEPTIONS — and that
      // polarity is the fix, not a tidy-up. S45 (2026-08-12) fixed this symptom for
      // the colour swatch by EXEMPTING a list of textless <input> types, which left
      // `SELECT` still counted as a protected input: it had been in the guard since
      // the guard was written. So a size or family pick — both are `<select>`, and a
      // dropdown keeps focus after a change — left Ctrl+Z silently dead, and stayed
      // dead through every later action, because focus does not leave a <select> on
      // its own. The user reported exactly that shape twice: "ctrl z not applying
      // undo for font size", then "change font, drag box, ctrl z did not work
      // either" (2026-08-19, I67 — measured in the browser: target SELECT#fontsize,
      // defaultPrevented false, ownership already re-taken by applyFontSize).
      //
      // An exemption list fails DEAD when it is missing an entry; this test fails
      // OPEN — an unlisted exotic widget gets undo it might not have wanted, instead
      // of a document whose undo has silently stopped working.
      const t = e.target;
      if (t && t !== this.sink && !this.container.contains(t) &&
          PdfeEditor._caretCapable(t)) return;
      this._handleHistoryKey(e);
    });
  }

  /**
   * Bring a page rect into view ONLY if it is currently off-screen. Used after
   * an undo: an undo you cannot see reads as a no-op and users hammer the
   * button, but scrolling on every undo of a keystroke is jarring — so scroll
   * only when there is actually nothing to see. |rect| is [l,b,r,t] page points.
   */
  _scrollRectIntoViewIfOffscreen(page, rect, margin = 48) {
    if (!rect || !(rect[2] > rect[0] && rect[3] > rect[1]) || this._pinchActive) return;
    const topLeft = this._pageToCss(rect[0], rect[3], page);
    const botRight = this._pageToCss(rect[2], rect[1], page);
    if (!topLeft || !botRight) return;
    const y0 = this._stripTop + topLeft.y, y1 = this._stripTop + botRight.y;
    const viewH = this.scroller.clientHeight;
    const sTop = this.scroller.scrollTop;
    const visible = y1 > sTop && y0 < sTop + viewH;
    if (visible) return;
    this.scroller.scrollTop = Math.max(0, y0 - margin);
  }

  /** Latency telemetry for the parity/latency gates (docs/PARITY_TESTING.md). */
  latencyP95() { return percentile(this.latencySamples, 95); }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._listeners.get(type)?.delete(fn); }

  /** Tear everything down: worker, DOM, observers, listeners. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try { this._io?.disconnect(); } catch (e) { /* already gone */ }
    try { this._resizeObs?.disconnect(); } catch (e) { /* already gone */ }
    clearTimeout(this._evictTimer);
    clearTimeout(this._refitTimer);
    clearTimeout(this._zoomTimer);
    for (const [target, type, fn, opt] of this._domListeners) {
      target.removeEventListener(type, fn, opt);
    }
    this._domListeners.length = 0;
    try { this._worker.terminate(); } catch (e) { /* already gone */ }
    this.root.remove();
    this.container.classList.remove("pdfe-host");
    this._listeners.clear();
    for (const [, { reject }] of this._pending) {
      reject(new PdfeError("destroyed", "editor destroyed"));
    }
    this._pending.clear();
    // loadFont() RESOLVES rather than rejecting, here and everywhere: its answer is
    // already an {ok, reason} record, so a host awaiting one at teardown gets a
    // normal negative answer instead of an unhandled rejection during unmount.
    for (const [name, waits] of this._fontWaits) {
      for (const w of waits) w({ ok: false, name, reason: "destroyed" });
    }
    this._fontWaits.clear();
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  _emit(type, detail) {
    for (const fn of this._listeners.get(type) || []) {
      try { fn(detail); } catch (e) { console.error(`[pdfe] listener for "${type}" threw`, e); }
    }
  }

  _promiseFor(key) {
    const prev = this._pending.get(key);
    if (prev) prev.reject(new PdfeError("superseded", `${key} superseded by a newer call`));
    return new Promise((resolve, reject) => this._pending.set(key, { resolve, reject }));
  }
  _settle(key, ok, value) {
    const p = this._pending.get(key);
    if (!p) return;
    this._pending.delete(key);
    ok ? p.resolve(value) : p.reject(value);
  }

  _post(msg, transfer) {
    if (this._destroyed) return;
    this._worker.postMessage(msg, transfer || []);
  }

  _listen(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    this._domListeners.push([target, type, fn, opt]);
  }

  _buildDom() {
    this._domListeners = [];
    this.container.classList.add("pdfe-host");

    const mk = (tag, cls) => {
      const el = this._doc.createElement(tag);
      el.className = cls;
      return el;
    };
    this.root = mk("div", "pdfe-scroll");
    this.scroller = this.root;
    // Drive the CSS custom property rather than the element's own
    // background, so a host that would rather theme it in its own
    // stylesheet (--pdfe-bg on any ancestor) still wins for the editors it
    // did not pass the option to.
    this.root.style.setProperty("--pdfe-bg", this._backgroundColor);
    this.strip = mk("div", "pdfe-strip");
    this.boxesEl = mk("div", "pdfe-layer pdfe-boxes");
    this.selEl = mk("div", "pdfe-layer pdfe-sel");
    this.caretEl = mk("div", "pdfe-caret");
    this.editBoxEl = mk("div", "pdfe-editbox");
    this.moveGhostEl = mk("div", "pdfe-moveghost");   // block-drag preview
    this.handleEls = [mk("div", "pdfe-handle"), mk("div", "pdfe-handle")];
    this.caretHandleEl = mk("div", "pdfe-carethandle");
    this.actionsEl = mk("div", "pdfe-actions");
    // THE ROTATE HANDLE — the second piece of chrome the SDK owns, and it earns
    // that the same way the action bar does: it is ANCHORED TO AN OBJECT. A host
    // cannot place a control on a picture's corner without asking for geometry
    // every frame and re-asking after every turn, drag, scroll and zoom.
    // rotateSelection() stays public for a host that wants its own button too.
    this.rotateBtn = mk("button", "pdfe-rotate");
    this.rotateBtn.type = "button";
    this.rotateBtn.title = "Rotate 90°";
    this.rotateBtn.setAttribute("aria-label", "Rotate 90 degrees");
    // An inline SVG, not a glyph: the emoji rotate arrows render as a different
    // shape on every platform and several are coloured.
    this.rotateBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" ' +
      'd="M20 11a8 8 0 1 0-2.3 5.7"/>' +
      '<path fill="currentColor" d="M20 4.5v6h-6z"/></svg>';
    this.editBtn = mk("button", "pdfe-act-edit");
    this.deleteBtn = mk("button", "pdfe-act-del");
    this.editBtn.type = "button";
    this.deleteBtn.type = "button";
    this.editBtn.textContent = "✎ Edit";
    this.deleteBtn.textContent = "🗑 Delete";
    this.actionsEl.append(this.editBtn, this.deleteBtn);
    this.sink = mk("textarea", "pdfe-sink");
    for (const [k, v] of Object.entries({
      autocapitalize: "off", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", "aria-hidden": "true", tabindex: "-1",
    })) this.sink.setAttribute(k, v);

    this.strip.append(this.boxesEl, this.editBoxEl, this.moveGhostEl, this.selEl,
      this.caretEl, ...this.handleEls, this.caretHandleEl, this.actionsEl,
      this.rotateBtn, this.sink);
    this.root.appendChild(this.strip);
    this.container.appendChild(this.root);

    this._wireSink();
    this._wireHandles();
    this._wireCaretHandle();
    this._wireActions();
    this._wireViewportGestures();
    this._wireHistoryKeys();

    // Live page number. Safe to do synchronously: the browser already coalesces
    // scroll events to one per frame per element, and the work reads only CACHED
    // page offsets (a per-page getBoundingClientRect here would be a forced
    // layout per page per frame). Passive, so it never blocks scrolling.
    // The scroll also arms the (throttled) far-page eviction sweep.
    this._listen(this.scroller, "scroll", () => {
      this._updateCurrentPage();
      this._scheduleEvictSweep();
    }, { passive: true });

    // Lazy paint/group as pages scroll into view — rooted at OUR scroller, not
    // the window, so the editor works inside any host layout.
    this._io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const page = Number(en.target.dataset.page);
        // Groups (edit-mode boxes) are requested AFTER the page's paint lands
        // (the `painted` message) so text pixels always precede their boxes —
        // and so pages flung past before painting never get grouped at all.
        const wasPainted = this._painted.has(page);
        this._requestPaint(page);
        if (wasPainted) this._requestGroups(page);   // no-op outside edit mode / cached
      }
    }, { root: this.scroller, rootMargin: "300px" });

    // Container resize (host layout change, device rotation, keyboard show):
    // re-fit so pages never stay at a stale fit width. Debounced — a rotation
    // fires many times. Overlays follow because their geometry is page points.
    this._resizeObs = new ResizeObserver(() => {
      clearTimeout(this._refitTimer);
      this._refitTimer = setTimeout(() => this._refit(), 120);
    });
    this._resizeObs.observe(this.container);
  }

  _startWorker(opts) {
    const workerUrl = new URL(opts.workerUrl || "./pdfe-worker.js",
      opts.workerUrl ? this._doc.baseURI : import.meta.url);
    const engineUrl = new URL(opts.engineUrl || "./editor.js",
      opts.engineUrl ? this._doc.baseURI : workerUrl);
    if (opts.version) {
      workerUrl.searchParams.set("v", opts.version);
      engineUrl.searchParams.set("v", opts.version);
    }
    // The worker imports the engine glue from ?engine=… (see pdfe-worker.js).
    workerUrl.searchParams.set("engine", engineUrl.href);
    this._worker = new Worker(workerUrl.href);   // classic worker (importScripts glue)
    this._worker.onmessage = (e) => this._onWorkerMessage(e.data);
    this._worker.onerror = (e) => {
      const err = new PdfeError("engine-error", e.message || "worker error");
      this._settle("open", false, err);
      this._settle("save", false, err);
      this._emit("error", { code: err.code, detail: err.message });
    };
    this._readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });
    // The worker owns the caret sites, so it owns the flag. Posted rather than
    // read from a constructor argument because a host may flip it at runtime.
    this._post({ type: "setTypingColorFollowsCaret", on: this._typingColorFollowsCaret });
    this._post({ type: "setTypingFontFollowsCaret", on: this._typingFontFollowsCaret });
    // WHERE THE BUNDLED FONT SET LIVES. Default is `./fonts/` relative to the worker,
    // which is the npm layout by construction (the worker ships at
    // dist/assets/pdfe-worker.js, so the set is at dist/assets/fonts/). A host serving a
    // different layout — the dev page in this repo, for one — passes `fontsUrl`. It is a
    // constructor option like workerUrl/engineUrl rather than an open() option, because it
    // describes the INSTALL, not the document.
    if (opts.fontsUrl) {
      this._post({
        type: "prepareFonts",
        fontsUrl: new URL(opts.fontsUrl, this._doc.baseURI).href,
      });
    }
  }

  _onWorkerMessage(msg) {
    if (this._destroyed) return;
    switch (msg.type) {
      case "ready": {
        // The worker probed its save sink before saying ready (WEB_IO.md §7):
        // no OPFS sync handle means saves cannot stream, which the HOST must
        // know before it offers one.
        this._caps = {
          canStreamSave: !!msg.opfs && !this._simulateNoOpfs,
          inHeapMaxMB: msg.inHeapMaxMB || 0,
        };
        this._resolveReady(this.capabilities);
        this._emit("ready", this.capabilities);
        break;
      }
      case "opened": {
        this._pages = msg.pages;
        this._buildStrip();
        const info = {
          pages: msg.pages.length, pageSizes: this.pages, bytes: msg.bytes,
          tier: msg.tier, openMs: msg.openMs, heapMB: msg.heapMB, io: msg.io,
          name: this._docName,
        };
        this._settle("open", true, info);
        this._emit("opened", info);
        break;
      }
      case "painted":
        // Text pixels just landed: NOW the page may grow its faint boxes
        // (no-op outside edit mode / already cached / already pending).
        this._requestGroups(msg.page);
        this._emit("painted", { page: msg.page, baseMs: msg.baseMs, tiles: msg.tiles });
        break;
      case "tile":
        this._emit("tile", { page: msg.page, ms: msg.ms, left: msg.left });
        break;
      case "paraSelected":
        this._selected = { page: msg.page, index: msg.index, bounds: msg.bounds,
                           blockIndex: msg.blockIndex ?? -1 };
        this._renderBoxes();
        // BOUNDS TRAVEL WITH THE EVENT (2026-08-13): a host that hides our
        // Edit/Delete bar has to place its own, and asking for geometry after
        // the fact is a round trip that lands a frame late — Android's
        // onSelectionChanged has carried the rect from the start, so this is
        // also event parity, not just convenience. PDF points, [l,b,r,t].
        this._emit("select", { selection: { kind: "text",
                                           page: msg.page, index: msg.index,
                                           blockIndex: msg.blockIndex ?? -1,
                                           bounds: msg.bounds || null } });
        break;
      case "paraDeselected":
        if (!this._selected) break;
        this._selected = null;
        this._renderBoxes();
        if (!this._selectedImage) this._emit("select", { selection: null });
        break;
      // ---- IMAGE EDIT (docs/IMAGE_EDIT.md) ----
      case "imageSelected":
        this._selectedImage = { page: msg.page, index: msg.index, bounds: msg.bounds,
                                quad: msg.quad, turns: msg.turns, flags: msg.flags };
        this._renderBoxes();
        // ONE event for both kinds, carrying `kind`. A host that only handles
        // text reads `kind === "text"` and ignores the rest; one that handles
        // pictures branches. Two separate events would have let a host wire the
        // first and silently miss the second — the shape of every parity gap in
        // CLAUDE.md's list.
        this._emit("select", { selection: {
          kind: "image", page: msg.page, index: msg.index, bounds: msg.bounds || null,
          quad: msg.quad || null, quarterTurns: msg.turns ?? 0,
          clipped: !!(msg.flags & 1),
        } });
        break;
      case "imageDeselected":
        if (!this._selectedImage) break;
        this._selectedImage = null;
        this._renderBoxes();
        if (!this._selected) this._emit("select", { selection: null });
        break;
      case "imageMoved":
      case "imageRotated": {
        this._hideMoveGhost();
        // Adopt the fresh page list BEFORE re-rendering, or the faint outline of
        // the picture that just moved is drawn from stale geometry — visibly, at
        // its old position, as soon as it is deselected.
        if (msg.images) this._pageImages.set(msg.page, msg.images);
        // Same dirty rule the other mutations follow: with history recording on,
        // `dirty` is derived from the journal, so setting it here too would make
        // it impossible to return to false by undoing (I80's neighbourhood).
        if (msg.ok && !this._history.recording) this._setDirty(true);
        // TWO LITERAL EMITS, NOT ONE COMPUTED ONE. The obvious
        // `_emit(cond ? "moved" : "rotated", …)` works perfectly and is
        // INVISIBLE to the parity gate, which reads `_emit("name"` statically —
        // so a brand-new event would have reached web and no other platform with
        // every check green. The gate says so about itself: "a gate that
        // silently skips what it cannot parse is worse than one that fails."
        const detail = { page: msg.page, ok: !!msg.ok, kind: "image",
                         bounds: msg.bounds || null, quarterTurns: msg.turns ?? null };
        if (msg.type === "imageMoved") this._emit("moved", detail);
        else this._emit("rotated", detail);
        break;
      }
      case "paraDeleted": {
        // The paragraph is gone from the text layer and the vacated strip has
        // already been repainted by the worker — all that is left is to forget
        // the stale grouping and re-ask for this page's boxes.
        this._selected = null;
        this._pageGroups.delete(msg.page);
        this._groupsPending.delete(msg.page);
        this._renderBoxes();
        this._requestGroups(msg.page);
        if (msg.ok) this._setDirty(true);
        this._emit("deleted", { page: msg.page, ok: !!msg.ok });
        break;
      }
      case "history":
        this._history = {
          canUndo: !!msg.canUndo, canRedo: !!msg.canRedo,
          undoPage: msg.undoPage ?? -1, redoPage: msg.redoPage ?? -1,
          recording: !!msg.recording,
        };
        // THE UNDO STACK IS THE AUTHORITY ON "IS THIS DOCUMENT MODIFIED?" — it
        // is the same set of facts `dirty` was tracking separately, and two
        // flags for one question drift. They drifted here: undoing every edit
        // emptied the stack and still left the Save dot lit.
        //
        // While recording, a non-empty stack IS "modified" and an empty one IS
        // "unmodified" — both directions, or REDO leaves a modified document
        // looking saved (measured: the mutation sites never fire for a step, so
        // a clear-only rule is one-way and never sets it back).
        //
        // The mutation sites still call _setDirty(true) as well, and that is not
        // redundant: they are synchronous with the keystroke, so the flag can
        // never lag the engine, and they are what keeps `dirty` working when
        // recording is off.
        if (this._history.recording) {
          this._setDirty(this._history.canUndo || this._dirtyUntracked);
        }
        this._emit("history", { ...this._history });
        break;
      case "historyDump":
        // Diagnostic pull (historyDump()); resolves whatever the core said.
        this._settle("historyDump", true, msg.dump ?? null);
        break;
      case "historyApplied": {
        if (!msg.ok) {
          // -3 TRUNCATES the stack (pdfe.h): it empties without reverting
          // anything, so from now on an empty stack no longer proves the
          // document is unmodified. Latch, or the next `history` event would
          // report these very edits as saved.
          if (msg.code === -3) this._dirtyUntracked = true;
          this._emit("error", new PdfeError(
            msg.error || "history-unavailable",
            msg.code === -3
              ? "That change can no longer be undone — the text it belongs to has moved on."
              : "Undo failed."));
          this._emit(msg.kind, { page: msg.page, ok: false, live: false });
          break;
        }
        // The worker already applied it and repainted the strip; the main
        // thread's half is the overlays, the selection and the flags
        // (docs/UNDO_REDO.md §1 S8/S12/S14).
        if (msg.blocks) {
          this._pageGroups.set(msg.page, msg.blocks);
          if (msg.images) this._pageImages.set(msg.page, msg.images);
          this._groupsPending.delete(msg.page);
        }
        if (msg.live) {
          // Applied INTO the open run: re-seed the sink from the ENGINE. A
          // programmatic `.value =` fires no `input`, so this cannot echo back
          // as a keystroke — the same no-echo path editOpened uses.
          this._editingChars = msg.text.length;
          this.sink.value = msg.text;
          const ci = Math.max(0, Math.min(msg.caretIndex ?? msg.text.length, msg.text.length));
          this.sink.setSelectionRange(ci, ci);
          this.sink.focus({ preventScroll: true });
          if (msg.runBounds) this._drawEditBox(msg.runBounds);
          if (msg.caret) this._drawCaret(msg.caret);
          this._drawSelection([]);
          this._drawHandles(null, null);
          this.scrollCaretIntoView();
        } else {
          // The run was reopened and committed inside the core, so any session
          // the shell thought it had on that page is gone.
          if (this._editingPage === msg.page) this._closeEditUiState();
          this._selected = msg.selection
            ? { page: msg.page, index: msg.selection.index,
                bounds: msg.selection.bounds,
                blockIndex: msg.selection.blockIndex ?? -1 }
            : null;
          // Bring the change into view if it happened off-screen — but only
          // then: jumping the page on every undo of a keystroke is jarring.
          this._scrollRectIntoViewIfOffscreen(msg.page, msg.focus || msg.dirty);
        }
        this._renderBoxes();
        if (!msg.blocks) this._requestGroups(msg.page);
        // Deliberately NOT _setDirty(true): a step is the one mutation whose
        // direction is unknown here. Undoing the last edit leaves an unmodified
        // document, so the `history` event that follows decides — setting the
        // flag here first would light the Save dot for a frame and then clear it.
        this._emit(msg.kind, { page: msg.page, ok: true, live: !!msg.live });
        break;
      }
      case "moveLimits":
        // The clamp range for the drag in flight. A null answer (no selection, or
        // the block could not be re-found) simply leaves the ghost unclamped.
        this._moveLimits = Array.isArray(msg.limits) && msg.limits.length === 4
          ? msg.limits : null;
        break;
      case "blockMoved": {
        // EXPERIMENTAL (feature/web-block-move). The worker already translated
        // the objects and repainted the strip covering BOTH the vacated area and
        // the destination, and it sends the fresh boxes with the result — a move
        // re-partitions the grouping (it is purely geometric), so the old block
        // indices are meaningless and must be replaced wholesale.
        this._hideMoveGhost();
        if (msg.blocks) {
          this._pageGroups.set(msg.page, msg.blocks);
          this._groupsPending.delete(msg.page);
        } else {
          this._pageGroups.delete(msg.page);
          this._groupsPending.delete(msg.page);
        }
        // The worker re-selected the block at the DROP point (by position, never
        // by index), so it stays selected and can be nudged again.
        this._selected = msg.selection
          ? { page: msg.page, index: msg.selection.index,
              bounds: msg.selection.bounds,
              blockIndex: msg.selection.blockIndex ?? -1 }
          : null;
        this._renderBoxes();
        if (!msg.blocks) this._requestGroups(msg.page);
        if (msg.ok) this._setDirty(true);
        this._emit("moved", { page: msg.page, ok: !!msg.ok });
        break;
      }
      case "addTextArmed":
        // AN ARM REPORTS ITSELF, BOTH WAYS (parity rule 14). The host paints its
        // button from this — including the DISARM that the placing tap performs, so a
        // spent arm cannot leave the button lit.
        this._addingText = !!msg.armed;
        this._emit("addtextarmed", { armed: this._addingText });
        break;
      case "editOpened": {
        // Prime the sink with the run's logical text (a programmatic set fires
        // no 'input', so this cannot echo back as a keystroke).
        this._selected = null;      // editing supersedes selection
        this._editingPage = msg.page;
        this._editingParaIndex = msg.paraIndex ?? -1;
        this._editingBlockIndex = msg.blockIndex ?? -1;
        this._editingIsParagraph = !!msg.isParagraph;
        this._editingLinePreserve = !!msg.linePreserve;
        this._editingChars = msg.text.length;
        this._renderBoxes();                 // hide the open run's faint box
        this.sink.value = msg.text;
        this.sink.setSelectionRange(msg.caretIndex, msg.caretIndex);
        this.sink.focus({ preventScroll: true });
        this._drawEditBox(msg.runBounds);    // the blue "you are typing here" box
        this._drawCaret(msg.caret);
        this._drawSelection([]);
        this._drawHandles(null, null);
        this.scrollCaretIntoView();
        // `created` distinguishes "a NEW box was just placed" from an ordinary open.
        // Deliberately a flag on this event rather than a second event firing at the
        // same instant with nothing extra to say (docs/ADD_TEXT.md).
        this._emit("editopen", { ...this.editing, created: !!msg.created });
        // Opening a run places a cursor, so it reports the style there exactly as
        // a move does — one event for hosts to drive a swatch from, and no reason
        // for a host to ask separately (asking meant guessing an index, and the
        // guess was 0: the first word's colour, not the caret's).
        this._textStyle = msg.style || null;
        this._emit("styled", {
          what: "caret", page: msg.page, style: msg.style || null,
          caretIndex: msg.caretIndex, following: this._typingColorFollowsCaret,
        });
        break;
      }
      case "caretStyle":
        // AN ARM REPORTED ITSELF (I76). A collapsed colour or size pick changes nothing
        // on the page, so it used to post nothing at all — and a host that paints its
        // controls from `styled` kept showing the value under the cursor while the SDK
        // typed the picked one. Reported on the same event a caret move uses, so a host
        // needs no new binding.
        //
        // ⚠️ DELIBERATELY NOT `caretMoved`, and do not "simplify" it into that case: the
        // caret branch below re-focuses the sink, and focusing right after a picker stole
        // focus pops the keyboard mid-pick on iOS (S39) — the same reason applyFontSize
        // and applyTextColor do not call sink.focus() themselves. This case touches
        // nothing but the reported style.
        this._textStyle = msg.style || null;
        this._emit("styled", {
          what: "caret", page: this._editingPage, style: msg.style || null,
          caretIndex: msg.index, following: !!msg.following,
        });
        break;
      case "caretMoved":
        this.sink.setSelectionRange(msg.index, msg.index);
        // THE CURSOR MOVED, SO THE STYLE UNDER IT IS THE ONE THAT MATTERS NOW.
        // Reported on every caret move, whichever lifetime mode is on: a host
        // must be able to show the colour the next keystroke will take. With
        // `typingColorFollowsCaret` on, the worker has already dropped any
        // picked override, so this IS that colour; with it off, the pick still
        // wins and `following: false` says so.
        this._textStyle = msg.style || null;
        this._emit("styled", {
          what: "caret", page: this._editingPage, style: msg.style || null,
          caretIndex: msg.index, following: !!msg.following,
        });
        // I9 belt-and-braces: the reposition path must refocus too, or any
        // focus loss preventDefault didn't cover becomes permanent.
        this.sink.focus({ preventScroll: true });
        this._drawCaret(msg.caret);
        this._drawSelection([]);
        this._drawHandles(null, null);
        // Only KEYBOARD-driven moves scroll (arrows/Home/End): a caret move that
        // came from a finger must never scroll under that finger mid-gesture.
        if (this._wantCaretScroll) { this._wantCaretScroll = false; this.scrollCaretIntoView(); }
        break;
      case "selectionChanged":
        // Mirror the range into the sink (typing/Backspace then replaces it
        // natively) and draw OUR highlight + knobs from CORE geometry — never
        // the OS selection.
        this._selRange = [msg.start, msg.end];
        // Direction matters: the next Shift+arrow must keep moving the same HEAD.
        this.sink.setSelectionRange(msg.start, msg.end, msg.headAtStart ? "backward" : "forward");
        this.sink.focus({ preventScroll: true });
        this._drawCaret(null);
        this._drawSelection(msg.rects || []);
        this._drawHandles(msg.h0, msg.h1);
        this._textStyle = msg.style || null;
        this._emit("selection", { start: msg.start, end: msg.end, style: msg.style || null });
        break;
      case "styleRead":
        this._textStyle = msg.style || null;
        this._emit("styled", { what: "read", page: msg.page, style: msg.style || null });
        break;
      case "fontsReady": {
        this._bundledFamilies = msg.families || [];
        const waits = this._fontsWaits.splice(0);
        for (const w of waits) {
          w({ ok: !(msg.failed || []).length, families: this._bundledFamilies,
              failed: msg.failed || [] });
        }
        this._emit("fontsReady", { families: this._bundledFamilies, failed: msg.failed || [] });
        // The faces that just landed change which B/I buttons are AVAILABLE, and the host
        // was told the old answer while the fetch was in flight. Re-read at the current
        // selection so a Calibri document's Bold button corrects itself instead of staying
        // wrong until the next caret move. Only the main thread can do this: the worker
        // does not track the selection, which lives in this side's sink.
        if (this._editingPage >= 0 && this.sink) {
          this.requestTextStyle(this.sink.selectionStart, this.sink.selectionEnd);
        }
        break;
      }
      case "fontLoaded": {
        // Resolve loadFont()'s promise, and surface a failure as an event too: a host
        // that fired-and-forgot still needs to hear that its face never arrived.
        const waits = this._fontWaits.get(msg.name);
        if (waits) {
          this._fontWaits.delete(msg.name);
          for (const w of waits) w({ ok: !!msg.ok, name: msg.name, reason: msg.reason });
        }
        if (!msg.ok) {
          this._emit("error", { code: msg.reason || "font-failed",
                                detail: `could not load the font "${msg.name}"` });
        }
        break;
      }
      case "styleApplied":
        if (!msg.ok) {
          // A REFUSED FACE IS A PRODUCT OUTCOME, not an engine failure, and it needs
          // its own code: "this family has no bold face" is something the host has to
          // be able to tell the user, and reporting it as color-failed would be both
          // wrong and unactionable (docs/FONTS.md §3).
          const code = msg.reason || (msg.what === "color" ? "color-failed" : "font-failed");
          this._emit("error", { code, page: msg.page, what: msg.what,
                                detail: code === "no-such-face"
                                  ? "the font family has no such face — load the variant with loadFont()"
                                  : `the engine refused the ${msg.what} change` });
          break;
        }
        // ARMING THE TYPING FONT paints nothing: there is no range, so there is no
        // selection, no handles and no strip. It is still surface the host listens to,
        // because its picker must show the face the next keystroke will take.
        if (msg.what === "typingFont") {
          this._emit("styled", { what: "typingFont", page: msg.page,
                                 fontName: msg.fontName, style: this._textStyle });
          break;
        }
        // ARMING A FACE AT A BARE CARET paints nothing either, for the same reason as a
        // typing font: there is no range, so no selection, no handles and no strip. It
        // must also NOT mark the document dirty — nothing on the page changed — which is
        // the whole reason it is a separate branch from the apply below.
        if (msg.armed) {
          this._textStyle = msg.style || null;
          this._emit("styled", { what: "typingFace", page: msg.page,
                                 style: msg.style || null });
          break;
        }
        if (msg.runBounds) this._drawEditBox(msg.runBounds);
        // NO CARET. A style apply that gets here always had a RANGE selected (a bare
        // caret took the `armed` branch above), and a range has no caret —
        // `selectionChanged` draws none for exactly this reason. Drawing one put a
        // blinking bar at the START of the run while the selection was still
        // highlighted mid-run, which read as "the cursor jumped to the beginning".
        this._drawCaret(null);
        this._drawSelection(msg.selection || []);
        if (msg.selEnd > msg.selStart) {
          // Keep BOTH the range and its handles. An earlier version hid the handles,
          // on the theory that these 18px circles were covering the recoloured text —
          // they are bigger than a small word at low zoom, so it looked plausible.
          // It was wrong: the colour was invisible because the demo listened for
          // `change`, which the native picker only fires when it CLOSES, and clicking
          // inside the box is what closed it. Live `input` is the real fix, and the
          // handles must stay so the selection can still be adjusted.
          this._selRange = [msg.selStart, msg.selEnd];
          this._drawHandles(msg.h0, msg.h1);
        }
        this._textStyle = msg.style || null;
        this._setDirty(true);
        // Deliberately NOT latencySamples and NOT the `edit` event: a style pick is
        // not a keystroke, and folding it in would pollute the keystroke->blit p95
        // the demo and the perf gate read.
        // `partial` rides along on a face apply that reached only part of the range
        // (some characters' fonts have no such face). It is a real edit either way —
        // the dirty flag above is set for both — so this is disclosure, not a failure.
        this._emit("styled", { what: msg.what, page: msg.page, style: msg.style || null,
                               ...(msg.partial ? { partial: true } : {}) });
        break;
      case "editApplied": {
        // Keep the blue box on the run as typing reflows/grows it.
        //
        // PASSED THROUGH EVEN WHEN NULL (I68). This was `if (msg.runBounds)`, whose
        // intent was "don't clobber a good box with nothing" and whose effect was
        // "never take a stale box down": an emptied run reported no bounds, the
        // redraw was skipped, and the rectangle from the last character stayed on the
        // canvas. The worker now always sends the caret's own box for an empty run,
        // so this is belt and braces — and the honest polarity either way, because a
        // run with no bounds has no box.
        this._drawEditBox(msg.runBounds || null);
        this._drawCaret(msg.caret);
        this._drawSelection(msg.selection || []);
        if (!msg.selection || !msg.selection.length) {
          this._selRange = null;
          this._drawHandles(null, null);
        } else {
          // A KEYBOARD-EXTENDED selection arrives here, not through
          // selectionChanged: Shift+arrow moves the sink's own range and we
          // mirror it as a plain edit. So the knobs must be redrawn on this
          // path too — otherwise the highlight grows and they stay behind at
          // the double-tap's boundaries (QA 2026-08-07). _selRange is re-armed
          // with it so grabbing a knob afterwards drags from the range the user
          // can actually see.
          this._selRange = [msg.selStart, msg.selEnd];
          this._drawHandles(msg.h0, msg.h1);
        }
        // I69 — THE ENGINE REFUSED SOME OF WHAT WE SENT. Anything no font in reach
        // can draw is dropped instead of written, because writing it produces a
        // different character (an emoji came back as U+00FF and SAVED that way).
        //
        // Re-seeding the sink is what makes the refusal stick: the textarea still
        // holds the emoji, so without this the next keystroke re-sends it, the
        // shell's char count disagrees with the engine's, and the user sees a
        // character in their IME buffer that is not in the document. Programmatic
        // `.value =` fires no `input`, so this cannot echo back as a keystroke —
        // the same no-echo path editOpened uses.
        if (msg.rejected) {
          this.sink.value = msg.text;
          // NOTHING HAPPENED, so the selection must come back too (I69b,
          // user-reported on Android 2026-08-19: tapping an emoji with a word selected
          // DELETED the word). The core refuses the whole gesture when every character
          // it inserted is undrawable, so the text is already unchanged — but the sink
          // had destroyed its own selection to make room, and a collapsed caret where
          // a selected word used to be is still "something happened".
          const pre = this._preEditSel;
          const lim = msg.text.length;
          if (pre && pre[1] <= lim) {
            this.sink.setSelectionRange(pre[0], pre[1]);
          } else {
            const ci = Math.max(0, Math.min(msg.caretIndex ?? lim, lim));
            this.sink.setSelectionRange(ci, ci);
          }
          this._emit("inputRejected", { page: msg.page, chars: msg.rejected,
                                        reason: "unsupported-glyph" });
        }
        this._preEditSel = null;    // consumed: the next gesture captures its own
        this._editingChars = this.sink.value.length;
        this._setDirty(true);
        this.scrollCaretIntoView();   // typing must never push the caret off-screen
        const total = performance.now() - msg.postedAt;   // closed on THIS clock
        this.latencySamples.push(total);
        if (this.latencySamples.length > 200) this.latencySamples.shift();
        this._emit("edit", {
          generation: msg.generation, engineMs: msg.engineMs, blitMs: msg.blitMs,
          totalMs: total, p95: this.latencyP95(), samples: this.latencySamples.length,
        });
        break;
      }
      case "editClosed": {
        const page = msg.page;
        this._closeEditUiState();
        // The commit may have moved/re-split paragraphs: refresh this page.
        if (this._editMode) {
          this._pageGroups.delete(page);
          this._groupsPending.delete(page);
          this._requestGroups(page);
        }
        this._renderBoxes();
        // `ok` means the COMMIT succeeded, not that anything changed — opening a
        // box and leaving it without typing commits fine and changed nothing. So
        // while recording, let the forced `history` post that follows this message
        // decide (same rule as an undo/redo step); setting it here would light the
        // Save dot for every box a user merely looked inside, and only a blink of
        // it even once the stack corrected the flag.
        if (msg.ok && !this._history.recording) this._setDirty(true);
        this._emit("editclose", { page, ok: !!msg.ok });
        break;
      }
      case "groups": {
        this._groupsPending.delete(msg.page);
        const blocks = msg.blocks || [];
        this._pageGroups.set(msg.page, blocks);
        this._pageImages.set(msg.page, msg.images || []);
        this._renderBoxes();
        // `count` stays the PARAGRAPH count (what it always meant, and what a
        // consumer's selection indices are numbered in); `blocks` is additive.
        let paraCount = 0;
        for (const b of blocks) paraCount += b.paras.length;
        this._emit("groups", { page: msg.page, count: paraCount, blocks: blocks.length });
        break;
      }
      case "editEcho":
        this._emit("echo", { chars: msg.chars, rttMs: performance.now() - msg.postedAt });
        break;
      case "saved": {
        this._closeEditUiState();
        this._renderBoxes();
        this._dirtyUntracked = false;   // saved bytes match the document again
        this._setDirty(false);
        const info = {
          file: msg.file, bytes: msg.bytes, ms: msg.ms, flat: !!msg.flat,
          heapMB: msg.heapMB, tier: msg.tier, io: msg.io,
          suggestedName: this.suggestedName(),
        };
        this._settle("save", true, info);
        this._emit("saved", info);
        break;
      }
      case "saveRefused": {
        // The worker's §7 backstop (the API check above normally gets there first).
        const err = new PdfeError("save-too-large",
          "document too large to save without streaming storage",
          { sizeMB: msg.sizeMB, limitMB: msg.limitMB });
        this._settle("save", false, err);
        this._emit("error", { code: err.code, detail: err.message, sizeMB: msg.sizeMB, limitMB: msg.limitMB });
        break;
      }
      case "openFailed": {
        // The engine refused the document, and said why. The worker has already
        // closed whatever was open, so the strip must go too — otherwise the
        // host keeps showing pages the engine no longer has (a failed open used
        // to leave exactly that zombie behind; it became easy to hit once a
        // protected file could fail on purpose).
        this._pages = [];
        this._docBytes = 0;
        this._buildStrip();
        const messages = {
          "password-required": "this document is password-protected",
          "password-wrong": "the password was not accepted",
        };
        const err = new PdfeError(msg.code, messages[msg.code] || "could not open this document",
          { name: this._docName });
        this._settle("open", false, err);
        this._emit("error", { code: err.code, detail: err.message });
        break;
      }
      case "error": {
        const err = new PdfeError("engine-error", msg.detail);
        this._settle("open", false, err);
        this._settle("save", false, err);
        this._emit("error", { code: err.code, detail: msg.detail });
        break;
      }
    }
  }

  /**
   * Tell the editor the current document has been persisted by the host: clears
   * the undo/redo history and the dirty flag, exactly as a successful `save()`
   * does. Emits `history` and (if it changed) `dirty`.
   *
   * `save()` already does this, so you only need `markSaved()` when YOU wrote the
   * document somewhere the SDK cannot see — you uploaded the `File` from `save()`,
   * or you persisted it through your own storage layer.
   *
   * Call it AFTER the write succeeds. Calling it first is the bug it exists to
   * prevent: if the upload then fails, the undo stack is gone and the document
   * claims to be saved.
   *
   * @since 2.1.0
   */
  markSaved() {
    this._dirtyUntracked = false;
    this._setDirty(false);
    this._post({ type: "markSaved" });
  }

  /** Default file name for a save, derived from the opened document. */
  suggestedName() {
    return (this._docName || "document.pdf").replace(/\.pdf$/i, "") + "-edited.pdf";
  }

  _setDirty(v) {
    if (this._dirty === v) return;
    this._dirty = v;
    this._emit("dirty", { dirty: v });
  }

  _closeEditUiState() {
    this._editingPage = -1;
    this._editingParaIndex = -1;
    this._editingBlockIndex = -1;
    this._editingIsParagraph = false;
    this._editingLinePreserve = false;
    this._editingChars = 0;
    this._selRange = null;
    this.sink.value = "";
    this._drawEditBox(null);
    this._drawCaret(null);
    this._drawSelection([]);
    this._drawHandles(null, null);
  }

  // ---- page strip / paint --------------------------------------------------

  _requestPaint(page) {
    if (this._painted.has(page)) return;
    const canvas = this._pageCanvases[page];
    if (!canvas) return;
    this._painted.add(page);
    this._livePages.add(page);
    this._post({
      type: "paint", page,
      w: Number(canvas.dataset.w),
      h: Number(canvas.dataset.h),
      scale: Number(canvas.dataset.scale),   // device px per PDF point
    });
  }

  // ---- far-page eviction (the bitmap/handle LRU's shell half) ---------------
  // A painted page keeps a full-resolution RGBA canvas alive (megabytes each).
  // Pages that scroll far outside the keep window hand those megabytes back:
  // the worker frees the bitmap and closes the page's engine handles; the
  // canvas keeps its CSS size so the scroll geometry never moves. Throttled —
  // a fling fires hundreds of scroll events.
  _scheduleEvictSweep() {
    if (this._evictTimer) return;
    this._evictTimer = setTimeout(() => {
      this._evictTimer = 0;
      this._evictFarPages();
    }, 250);
  }

  _evictFarPages() {
    if (this._destroyed || !this._pageOffsets.length) return;
    const keep = Math.max(2400, this.scroller.clientHeight * 3);
    const top = this.scroller.scrollTop - keep;
    const bot = this.scroller.scrollTop + this.scroller.clientHeight + keep;
    let boxesStale = false;
    for (const page of [...this._livePages]) {
      if (page === this._editingPage) continue;   // never evict the open run's page
      const off = this._pageOffsets[page];
      if (!off) continue;
      if (off[0] + off[1] > top && off[0] < bot) continue;   // inside the window
      this._livePages.delete(page);
      this._painted.delete(page);
      this._post({ type: "evict", page });
      if (this._pageGroups.delete(page)) boxesStale = true;
      this._groupsPending.delete(page);
    }
    if (boxesStale) this._renderBoxes();
  }

  _requestGroups(page) {
    if (!this._editMode || this._pageGroups.has(page) || this._groupsPending.has(page)) return;
    this._groupsPending.add(page);
    this._post({ type: "groups", page });
  }

  _buildStrip() {
    // Keep the overlay layers; replace only the canvases.
    for (const c of this._pageCanvases) c.remove();
    this._io.disconnect();
    this._pageCanvases = [];
    this._pageOffsets = [];
    this._livePages.clear();     // the worker dropped the old canvases at open
    this._currentPage = 0;
    this._reportedPage = -1;     // a new document re-announces its page 1
    this._pageGroups.clear();
    this._pageImages.clear();
    this._groupsPending.clear();
    this._selected = null;
    this._selectedImage = null;
    this._editingParaIndex = -1;
    this._editingBlockIndex = -1;
    this._computeFitScale();
    this._pages.forEach((p, i) => {
      const canvas = this._doc.createElement("canvas");
      canvas.dataset.page = i;
      // Canvases go BEFORE the overlay layers so overlays paint on top.
      this.strip.insertBefore(canvas, this.boxesEl);
      this._pageCanvases[i] = canvas;
      // One-time ownership transfer; from here the WORKER draws (§2).
      const off = canvas.transferControlToOffscreen();
      this._post({ type: "attach", page: i, canvas: off }, [off]);
      this._io.observe(canvas);
      this._wireCanvas(canvas);
    });
    this._applyZoom();
    // Explicit first sweep — do NOT wait for the IntersectionObserver: the
    // canvases are observed while still 0x0 (they are sized in _applyZoom just
    // above), and Chrome's first delivery for a freshly observed zero-size
    // element reports "not intersecting" and never fires again without a
    // scroll. Verified 2026-07-28: re-opening a document while edit mode was ON
    // left every faint box missing until the user scrolled.
    this._sweepVisible();
  }

  // ---- live page number ----------------------------------------------------
  //
  // Hosts show "Page 3 of 12", so the SDK has to say which page is being read.
  // The measurement is cached per zoom because the offsets only move when the
  // strip is re-laid-out; scrolling then costs one arithmetic pass.

  _measurePageOffsets() {
    // offsetTop is relative to the strip (the canvases' offsetParent); the strip
    // itself may sit a few px into the scroller. ONE batched layout pass caching
    // [topInScroller, height, leftInStrip, width] per page — every overlay
    // (boxes, caret, edit box, action bar) draws from THIS cache and never reads
    // canvas.offset* itself. Interleaving those reads with style writes forced a
    // synchronous relayout of the whole strip per box — ~3-6 ms EACH on a
    // 7000-page strip, which turned every tap and groups reply into 100-200 ms
    // of main-thread stall (the "clicking a box lags" symptom on large PDFs).
    const base = this.strip.offsetTop;
    this._stripTop = base;
    this._stripLeft = this.strip.offsetLeft;
    this._pageOffsets = this._pageCanvases.map(
      (c) => [base + c.offsetTop, c.offsetHeight, c.offsetLeft, c.offsetWidth]);
  }

  /** Cached [top, height, left, width] for a page, STRIP-relative top. */
  _pageRect(page) {
    if (!this._pageOffsets.length) this._measurePageOffsets();
    const o = this._pageOffsets[page];
    if (!o) return null;
    return { top: o[0] - this._stripTop, height: o[1], left: o[2], width: o[3] };
  }

  /** Recompute the dominant visible page and emit `page` when it changes. */
  _updateCurrentPage() {
    if (this._destroyed) return;
    if (!this._pageOffsets.length) {
      // Nothing open (or the strip is not laid out yet): stay at page 0 and arm the
      // next real measurement to be announced. No event — there is no page to report.
      this._currentPage = 0;
      this._reportedPage = -1;
      return;
    }
    const top = this.scroller.scrollTop;
    const bot = top + this.scroller.clientHeight;
    let best = 0, bestCover = -1;
    for (let i = 0; i < this._pageOffsets.length; i++) {
      const [t, h] = this._pageOffsets[i];
      if (t > bot) break;                       // offsets ascend: nothing later overlaps
      const cover = Math.min(t + h, bot) - Math.max(t, top);
      // Strictly greater keeps ties on the LOWER page (no flicker at a boundary).
      if (cover > bestCover + 0.5) { bestCover = cover; best = i; }
    }
    this._currentPage = best;
    if (best === this._reportedPage) return;
    this._reportedPage = best;
    this._emit("page", { page: best, pageCount: this._pages.length });
  }

  /** Paint (and, in edit mode, group) every page near the viewport, now.
   *  Walks the CACHED page offsets — a getBoundingClientRect per canvas costs
   *  ~12 ms of forced layout on a 7000-page strip, this costs microseconds. */
  _sweepVisible() {
    if (!this._pageCanvases.length) return;
    if (!this._pageOffsets.length) this._measurePageOffsets();
    const margin = 300;
    const top = this.scroller.scrollTop - margin;
    const bot = this.scroller.scrollTop + this.scroller.clientHeight + margin;
    for (let i = 0; i < this._pageOffsets.length; i++) {
      const [t, h] = this._pageOffsets[i];
      if (t > bot) break;                    // offsets ascend
      if (t + h < top) continue;
      const wasPainted = this._painted.has(i);
      this._requestPaint(i);
      if (wasPainted) this._requestGroups(i);   // fresh paints group on `painted`
    }
  }

  _computeFitScale() {
    if (!this._pages.length) return;
    const maxWpt = Math.max(...this._pages.map((p) => p.w));
    let avail = this.scroller.clientWidth - 24;
    if (avail <= 0) avail = 600;                       // container not laid out yet
    if (this.maxPageWidthCss) avail = Math.min(avail, this.maxPageWidthCss);
    this._fitScale = avail / maxWpt;
  }

  /** Re-measure the container and repaint at the new fit width (keeps zoom). */
  _refit() {
    if (this._destroyed || !this._pages.length) return;
    const before = this._fitScale;
    this._computeFitScale();
    if (Math.abs(before - this._fitScale) < 1e-6) {
      this._measurePageOffsets();  // the container may have re-centered the strip
      this._repositionOverlays();
      this._updateCurrentPage();   // the visible band may have shrunk (keyboard)
      return;
    }
    this._applyZoom();
    this._repositionOverlays();
  }

  // Zoom (§5): CSS rescales instantly; sharp tiles refill async.
  _applyZoom() {
    const scaleCss = this._fitScale * this._zoom;   // CSS px per point
    const scaleDev = scaleCss * this._dpr;          // device px per point
    for (const canvas of this._pageCanvases) {
      const p = this._pages[Number(canvas.dataset.page)];
      canvas.style.width = Math.round(p.w * scaleCss) + "px";
      canvas.style.height = Math.round(p.h * scaleCss) + "px";
      canvas.dataset.w = Math.round(p.w * scaleDev);
      canvas.dataset.h = Math.round(p.h * scaleDev);
      canvas.dataset.scale = scaleDev;
    }
    // Page geometry just changed: re-cache the offsets the page counter reads and
    // re-evaluate which page is showing (a zoom can change the answer).
    this._measurePageOffsets();
    this._updateCurrentPage();
    this._renderBoxes();   // faint boxes track the new scale immediately
    // Old pixels keep showing, CSS-scaled (instant, maybe blurry); repaint at
    // the new resolution after a short settle.
    this._painted = new Set();
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => this._sweepVisible(), 180);
  }

  // Faint paragraph boxes (edit mode) — the Android overlay's analog. They live
  // inside the strip so they scroll and pinch with the pages for free; the open
  // run's box is omitted while it is being edited.
  _renderBoxes() {
    this.boxesEl.innerHTML = "";
    this.actionsEl.style.display = "none";
    this.rotateBtn.style.display = "none";
    if (!this._editMode) return;
    const scaleCss = this._fitScale * this._zoom;
    const sel = this._selected;
    // All geometry comes from the CACHED page rects: zero layout reads in this
    // loop (a read after each append re-laid-out the whole strip per box).
    const boxEl = (page, b, cls) => {
      const rect = this._pageRect(page);
      if (!rect) return null;
      const div = this._doc.createElement("div");
      div.className = cls;
      div.style.left = `${rect.left + b[0] * scaleCss}px`;
      div.style.top = `${rect.top + (this._pages[page].h - b[3]) * scaleCss}px`;
      div.style.width = `${(b[2] - b[0]) * scaleCss}px`;
      div.style.height = `${(b[3] - b[1]) * scaleCss}px`;
      this.boxesEl.appendChild(div);
      return div;
    };
    // One faint box per BLOCK (the visual unit). The selection highlight is the
    // BLOCK too (Android parity: the box is what Edit opens and Delete removes;
    // the worker posts the block's bounds as the selection).
    for (const [page, blocks] of this._pageGroups) {
      if (!this._pageCanvases[page]) continue;
      for (const block of blocks) {
        // Editing inside this block hides its whole box — the live blue run box
        // shows where the caret actually is.
        if (page === this._editingPage && block.index === this._editingBlockIndex) continue;
        boxEl(page, block.bounds, "pdfe-parabox");
      }
    }
    // The selected box is drawn from the WORKER's bounds, not from the cached
    // grouping: a selection is always valid even on a page whose boxes have not
    // been fetched yet (or were just invalidated by a commit).
    // ...but NOT its action bar while the box is being dragged: any re-render
    // during a drag (a scroll, a zoom) would otherwise put it back on the old rect.
    if (sel && boxEl(sel.page, sel.bounds, "pdfe-parabox pdfe-selected")
        && !this._draggingBox) {
      this._placeActions(sel.page, sel.bounds, scaleCss);
    }
    // PICTURES. One faint outline EACH, exactly as every text block gets one:
    // without it a picture is invisible as an interactive thing until the user
    // happens to tap it, which is what a first look at this feature reported.
    //
    // Drawn from the ROTATED QUAD, not the axis-aligned box — a turned picture
    // given a rectangle outline gets one that does not fit it. For a quarter
    // turn the quad IS a rectangle (just a different one), so a polygon is
    // correct in every case and special-cases none.
    const selImg = this._selectedImage;
    const imgSvg = (page, quad, cls) => {
      const rect = this._pageRect(page);
      if (!rect || !this._pageCanvases[page] || !quad) return;
      const pw = this._pages[page].w * scaleCss;
      const ph = this._pages[page].h * scaleCss;
      const pts = [];
      for (let i = 0; i < 8; i += 2) {
        pts.push(`${quad[i] * scaleCss},${(this._pages[page].h - quad[i + 1]) * scaleCss}`);
      }
      const svg = this._doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", cls);
      svg.style.left = `${rect.left}px`;
      svg.style.top = `${rect.top}px`;
      svg.style.width = `${pw}px`;
      svg.style.height = `${ph}px`;
      svg.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
      const poly = this._doc.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts.join(" "));
      svg.appendChild(poly);
      this.boxesEl.appendChild(svg);
    };
    for (const [page, imgs] of this._pageImages) {
      if (!this._pageCanvases[page]) continue;
      for (const im of imgs) {
        // The selected one is drawn last, on top, in its own style.
        if (selImg && selImg.page === page && selImg.index === im.index) continue;
        imgSvg(page, im.quad, "pdfe-imagebox");
      }
    }
    if (selImg) {
      imgSvg(selImg.page, selImg.quad, "pdfe-imagebox pdfe-imagebox-selected");
      // …and the rotate handle on it. Hidden during a drag for the same reason
      // the action bar is: any re-render mid-drag would strand it on the old rect.
      if (!this._draggingBox) this._placeRotate(selImg, scaleCss);
      // NO ACTION BAR. The bar's two actions are Edit and Delete, and neither
      // exists for a picture: there is nothing to open for typing, and image
      // deletion is deliberately out of scope. Showing it offered a user two
      // buttons that could only disappoint. Turning a picture is HOST chrome
      // (rotateSelection), like every other control except this one bar.
    }
  }

  // ---- block move preview (EXPERIMENTAL, feature/web-block-move) -----------

  /** Is page point |pt| inside PDF-point bounds [l, b, r, t]? */
  _inBounds(b, pt) {
    return !!b && pt.xPt >= b[0] && pt.xPt <= b[2] && pt.yPt >= b[1] && pt.yPt <= b[3];
  }

  /**
   * Does this tap OPEN or CONTINUE an edit — and therefore legitimately want a
   * keyboard?
   *
   * WHY THE SHELL HAS TO DECIDE THIS, duplicating a rule the worker owns: iOS
   * raises the keyboard ONLY for a focus() that happens synchronously inside the
   * user gesture, and the worker's routing reply arrives long after the gesture
   * is over. So the choice must be made here, before the message is posted.
   * Keep this in step with the worker's tap routing (`msg.type === "tap"`).
   *
   * Editing already: only a tap INSIDE the open run continues it (the worker
   * moves the caret); anywhere else commits, which ends the edit.
   * Not editing: the FIRST tap only SELECTS a paragraph — no keyboard — and the
   * SECOND tap on that same selected paragraph is the shortcut into editing.
   */
  _tapWantsKeyboard(page, pt) {
    // ADD TEXT: an ARMED tap creates a box and puts the caret in it, wherever it
    // lands — so it always opens an edit and always wants the keyboard. Checked
    // FIRST because it outranks both branches below: while armed, a tap neither
    // selects nor merely repositions a caret.
    //
    // Only the SHELL can do this. The decision has to be made synchronously inside
    // the gesture (browsers, iOS strictly, raise a keyboard only for a focus() made
    // there), and the worker's reply lands long after the gesture is over. Miss it
    // and placing a box on a phone gives a caret and no keyboard — S39, one gesture
    // over. Guarded by web/sdk/keyboard_gate_test.mjs.
    if (this._addingText) return true;
    if (this._editingPage >= 0)
      return this._editingPage === page && this._inBounds(this._lastEditBounds, pt);
    return !!this._selected && this._selected.page === page &&
           this._inBounds(this._selected.bounds, pt);
  }

  /**
   * Raise or dismiss the soft keyboard, by focusing or blurring the sink. MUST be
   * called synchronously inside a user gesture to raise it on iOS.
   *
   * Blurring is the half desktop never needed: there, focus is invisible, so the
   * SDK simply focused on every tap. On iOS "focused" and "keyboard visible" are
   * the same thing, which made a plain select-tap pop the keyboard (S39).
   */
  _setSinkFocus(on) {
    if (on) this.sink.focus({ preventScroll: true });
    else if (document.activeElement === this.sink) this.sink.blur();
  }

  /** Draw the drag outline at |bounds| shifted by (dx, dy) PDF points. Only the
   *  ghost moves during a drag — the text is translated once, on drop. */
  _showMoveGhost(page, bounds, dx, dy) {
    const rect = this._pageRect(page);
    if (!rect) return;
    const scaleCss = this._fitScale * this._zoom;
    // Clamp to what the DROP will actually do. The core keeps a moved box on the
    // page, so an unclamped ghost would promise a position the move then refuses —
    // the outline has to tell the truth. |_moveLimits| arrives async from the
    // engine; until it does the ghost is unclamped, and the drop clamps anyway.
    const lim = this._moveLimits;
    if (lim) {
      dx = Math.min(Math.max(dx, lim[0]), lim[2]);
      dy = Math.min(Math.max(dy, lim[1]), lim[3]);
    }
    this._ghostDelta = [dx, dy];
    const el = this.moveGhostEl;
    el.style.display = "block";
    el.style.left = `${rect.left + (bounds[0] + dx) * scaleCss}px`;
    el.style.top = `${rect.top + (this._pages[page].h - (bounds[3] + dy)) * scaleCss}px`;
    el.style.width = `${(bounds[2] - bounds[0]) * scaleCss}px`;
    el.style.height = `${(bounds[3] - bounds[1]) * scaleCss}px`;
  }

  _hideMoveGhost() {
    this.moveGhostEl.style.display = "none";
    this._moveLimits = null;
    this._ghostDelta = null;
  }

  /** Park the Edit/Delete bar just above the selected box (below it when the
   *  box is at the page top), clamped to the page's own width. */
  _placeActions(page, b, scaleCss) {
    const rect = this._pageRect(page);
    if (!rect) return;
    const bar = this.actionsEl;
    bar.style.display = "flex";
    const boxLeft = rect.left + b[0] * scaleCss;
    const boxTop = rect.top + (this._pages[page].h - b[3]) * scaleCss;
    const boxBot = rect.top + (this._pages[page].h - b[1]) * scaleCss;
    // The bar's own size is content-static: measure it once (ONE layout flush),
    // then reuse — re-reading it after the writes above would flush again.
    if (!this._actionsSize) this._actionsSize = [bar.offsetWidth, bar.offsetHeight];
    const [bw, bh] = this._actionsSize;
    let top = boxTop - bh - 6;
    if (top < rect.top) top = boxBot + 6;
    const maxLeft = rect.left + rect.width - bw;
    bar.style.left = `${Math.max(rect.left, Math.min(boxLeft, maxLeft))}px`;
    bar.style.top = `${top}px`;
  }

  // The rotate handle sits just outside the picture's TOP-RIGHT corner, clamped
  // into the page so a picture at the very edge (monetary.pdf has one starting at
  // x = -2) still shows it. The corner comes from the QUAD, not the axis-aligned
  // box: on a turned picture those differ, and anchoring to the box would leave
  // the handle floating away from the corner it belongs to.
  _placeRotate(sel, scaleCss) {
    const rect = this._pageRect(sel.page);
    if (!rect || !sel.quad) return;
    const h = this._pages[sel.page].h;
    let bestX = -Infinity, bestY = Infinity;
    for (let i = 0; i < 8; i += 2) {
      const x = sel.quad[i] * scaleCss;
      const y = (h - sel.quad[i + 1]) * scaleCss;
      // "top-right" in SCREEN terms: largest x, smallest y, decided together so
      // a turned picture's handle lands on the corner the user sees as top-right.
      if (x - y > bestX - bestY) { bestX = x; bestY = y; }
    }
    const SIZE = 28, GAP = 6;
    const btn = this.rotateBtn;
    btn.style.display = "flex";
    const left = rect.left + bestX - SIZE / 2 + GAP;
    const top = rect.top + bestY - SIZE / 2 - GAP;
    btn.style.left = `${Math.max(rect.left, Math.min(left, rect.left + rect.width - SIZE))}px`;
    btn.style.top = `${Math.max(rect.top, Math.min(top, rect.top + rect.height - SIZE))}px`;
  }

  // The bar is the one overlay the user can press, so it must swallow its own
  // pointer events: the scroller's commit-on-tap-outside handler and the canvas
  // tap router both sit above it in the tree.
  _wireActions() {
    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    this._listen(this.actionsEl, "pointerdown", swallow);
    // ONE DIRECTION, PRESSED REPEATEDLY (user decision 2026-08-25): each press is
    // a quarter turn clockwise, and four presses return the picture exactly to
    // where it started — the engine's rotation is exact, so this cannot drift.
    // The pointerdown must be swallowed or the canvas tap router underneath
    // treats the press as a tap on the page and deselects the picture first.
    this._listen(this.rotateBtn, "pointerdown", swallow);
    this._listen(this.rotateBtn, "click", (ev) => { swallow(ev); this.rotateSelection(1); });
    this._listen(this.editBtn, "click", (ev) => { swallow(ev); this.editSelection(); });
    this._listen(this.deleteBtn, "click", (ev) => { swallow(ev); this.deleteSelection(); });
  }

  // ---- caret / selection overlays (§6): CORE page geometry -> CSS ----------
  // STRIP-SPACE, not viewport-space (I16, iPhone pinch 2026-07-28): iOS pinch is
  // a visual-viewport camera move that fires no scroll/resize and slides content
  // under position:fixed elements — a fixed caret visibly detached from its
  // text. Absolute coordinates inside the strip move with the content under ANY
  // camera transform (and under our own scroller), by construction.
  // Reads the CACHED page rect, never canvas.offset* — this runs per keystroke
  // (caret + edit box + selection), and a layout read here after the style
  // writes below re-laid-out the whole strip (expensive at 7000 pages).
  // |page| defaults to the run being edited (every caret/selection overlay
  // wants that); undo passes an explicit page, because the change it is
  // scrolling to need not be the one under the caret.
  _pageToCss(xPt, yPt, page = this._editingPage) {
    if (page < 0 || !this._pageCanvases[page] || !this._pages[page]) return null;
    const rect = this._pageRect(page);
    if (!rect) return null;
    const scaleCss = this._fitScale * this._zoom;
    return {
      x: rect.left + xPt * scaleCss,
      y: rect.top + (this._pages[page].h - yPt) * scaleCss,
    };
  }

  _drawCaret(geom) {
    this._lastCaretGeom = geom;
    if (!geom || this._editingPage < 0) {
      this.caretEl.style.display = "none";
      this.caretHandleEl.style.display = "none";
      return;
    }
    const top = this._pageToCss(geom[0], geom[1]);
    const bot = this._pageToCss(geom[0], geom[2]);
    if (!top) {
      this.caretEl.style.display = "none";
      this.caretHandleEl.style.display = "none";
      return;
    }
    this.caretEl.style.display = "block";
    this.caretEl.style.left = `${top.x - 1}px`;
    this.caretEl.style.top = `${top.y}px`;
    this.caretEl.style.height = `${Math.max(2, bot.y - top.y)}px`;
    // Keep the sink under the caret so an IME candidate window follows (§7).
    this.sink.style.left = `${Math.round(top.x)}px`;
    this.sink.style.top = `${Math.round(top.y)}px`;
    // The thumb rides the caret. Mutual exclusion with the two selection
    // handles is free: every message that draws a RANGE calls _drawCaret(null),
    // and every collapsed-caret message calls _drawHandles(null, null).
    this._drawCaretHandle(bot);
  }

  /** The insertion grip under a collapsed caret — touch only. |bot| is the
   *  caret's bottom in strip CSS px (the same anchor the selection knobs hang
   *  from, so all three line up). */
  _drawCaretHandle(bot) {
    const el = this.caretHandleEl;
    const touch = this._lastPointerType === "touch" || this._lastPointerType === "pen";
    if (!touch || !bot || this._editingPage < 0) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.left = `${bot.x - 9}px`;
    el.style.top = `${bot.y}px`;
  }

  /** The blue box around the run being edited. |b| is [l,b,r,t] page points (the
   *  core's LIVE run bounds); null hides it. Inset outward by 2px so the rule
   *  sits just OFF the glyphs, matching the Android overlay. */
  _drawEditBox(b) {
    this._lastEditBounds = b || null;
    const el = this.editBoxEl;
    if (!b || this._editingPage < 0) { el.style.display = "none"; return; }
    const tl = this._pageToCss(b[0], b[3]);
    const br = this._pageToCss(b[2], b[1]);
    if (!tl) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.left = `${tl.x - 2}px`;
    el.style.top = `${tl.y - 2}px`;
    el.style.width = `${Math.max(1, br.x - tl.x + 4)}px`;
    el.style.height = `${Math.max(1, br.y - tl.y + 4)}px`;
  }

  _drawSelection(rects) {
    this._lastSelection = rects;
    this.selEl.innerHTML = "";
    if (this._editingPage < 0) return;
    for (const r of rects) {
      const tl = this._pageToCss(r[0], r[3]);
      const br = this._pageToCss(r[2], r[1]);
      if (!tl) continue;
      const div = this._doc.createElement("div");
      div.className = "pdfe-selrect";
      div.style.left = `${tl.x}px`;
      div.style.top = `${tl.y}px`;
      div.style.width = `${br.x - tl.x}px`;
      div.style.height = `${br.y - tl.y}px`;
      this.selEl.appendChild(div);
    }
  }

  _drawHandles(h0, h1) {
    this._lastHandles = [h0, h1];
    [h0, h1].forEach((h, i) => {
      const el = this.handleEls[i];
      if (!h || this._editingPage < 0) { el.style.display = "none"; return; }
      const bot = this._pageToCss(h[0], h[2]);   // knob hangs below the caret bottom
      if (!bot) { el.style.display = "none"; return; }
      el.style.display = "block";
      el.style.left = `${bot.x - 9}px`;
      el.style.top = `${bot.y}px`;
    });
  }

  _repositionOverlays() {
    this._drawEditBox(this._lastEditBounds);
    this._drawCaret(this._lastCaretGeom);
    this._drawSelection(this._lastSelection);
    this._drawHandles(this._lastHandles[0], this._lastHandles[1]);
  }

  // ---- selection handles (the Android round-knob analog) -------------------
  _wireHandles() {
    this.handleEls.forEach((el, which) => {
      this._listen(el, "pointerdown", (ev) => {
        if (!this._selRange || this._editingPage < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic/stale pointer */ }
        const move = (mv) => {
          const canvas = this._pageCanvases[this._editingPage];
          if (!canvas || !this._selRange) return;
          const rect = canvas.getBoundingClientRect();
          const scaleCss = this._fitScale * this._zoom;
          // The finger is on the knob BELOW the line — sample ~a knob height
          // above it so the boundary lookup lands on the dragged line.
          const xPt = (mv.clientX - rect.left) / scaleCss;
          const yPt = this._pages[this._editingPage].h -
            (mv.clientY - HANDLE_TOUCH_LIFT - rect.top) / scaleCss;
          this._post({
            type: "dragHandle", which,
            start: this._selRange[0], end: this._selRange[1], xPt, yPt,
          });
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          this.sink.focus({ preventScroll: true });   // the drag must not kill the keyboard
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up, { once: true });
        el.addEventListener("pointercancel", up, { once: true });
      });
    });
  }

  // ---- the caret thumb (the Android insertion-handle analog) ---------------
  //
  // Dragging it moves the CARET, so the reply is `caretMoved`, not
  // `selectionChanged`. It deliberately does NOT post `tap`: `tap` commits the
  // run when the point falls outside its bounds, and a fingertip dragging along
  // a line will do exactly that.
  _wireCaretHandle() {
    const el = this.caretHandleEl;
    this._listen(el, "pointerdown", (ev) => {
      if (this._editingPage < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this._draggingCaret = true;
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic/stale pointer */ }
      const move = (mv) => {
        const canvas = this._pageCanvases[this._editingPage];
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleCss = this._fitScale * this._zoom;
        const xPt = (mv.clientX - rect.left) / scaleCss;
        const yPt = this._pages[this._editingPage].h -
          (mv.clientY - HANDLE_TOUCH_LIFT - rect.top) / scaleCss;
        this._post({ type: "dragCaret", page: this._editingPage, xPt, yPt });
      };
      const up = () => {
        this._draggingCaret = false;
        el.removeEventListener("pointermove", move);
        this.sink.focus({ preventScroll: true });   // the drag must not kill the keyboard
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up, { once: true });
      el.addEventListener("pointercancel", up, { once: true });
    });
  }

  // ---- canvas gestures: tap / long-press / drag-select --------------------
  _wireCanvas(canvas) {
    this._listen(canvas, "pointerdown", (ev) => {
      // Recorded before the edit-mode gate: the caret thumb is touch-only, and
      // the input type is a property of the DEVICE, not of the mode.
      this._lastPointerType = ev.pointerType || "mouse";
      if (!this._editMode) return;
      // I9: killing the default action stops the browser from moving focus to
      // <body> after this handler (a mousedown on a non-focusable canvas blurs
      // the sink). Without it every caret-reposition tap silently disconnected
      // the keyboard.
      ev.preventDefault();
      const page = Number(canvas.dataset.page);
      const startX = ev.clientX, startY = ev.clientY;
      const toPt = (cx, cy) => {
        const rect = canvas.getBoundingClientRect();
        const scaleCss = this._fitScale * this._zoom;
        return {
          xPt: (cx - rect.left) / scaleCss,
          yPt: this._pages[page].h - (cy - rect.top) / scaleCss,
        };
      };
      // EXPERIMENTAL (feature/web-block-move): a drag that STARTS inside the
      // already-selected box moves it. Decided here, on DOWN, because it
      // changes what the subsequent moves mean — a pan, a text drag-select, or
      // a box move. Gated on there being no open run on this page: inside an
      // open run a drag is still a text selection.
      const down = toPt(startX, startY);
      // `_blockMove` first: the feature is EXPERIMENTAL and off by default, and a
      // disabled feature must not even arm the gesture — otherwise a drag would
      // still swallow the pan it is standing in front of.
      const movableText = this._blockMove &&
        !!this._selected && this._selected.page === page &&
        this._editingPage !== page && this._inBounds(this._selected.bounds, down);
      // A SELECTED PICTURE DRAGS THE SAME WAY (docs/IMAGE_EDIT.md), and is NOT
      // gated on `blockMove`: that flag is documented as "box dragging" and a
      // host that turned it off did so about text boxes. Nothing existing can be
      // surprised by this — without this build there is no way to select a
      // picture at all.
      const movableImage = !!this._selectedImage && this._selectedImage.page === page &&
        this._editingPage !== page && this._inBounds(this._selectedImage.bounds, down);
      const movable = movableText || movableImage;
      const movingBounds = () =>
        (movableImage ? this._selectedImage.bounds : this._selected.bounds);
      let lpFired = false;
      // Long-press (< 8 px movement) selects the word under the finger, inside
      // the OPEN run only — same as Android. A press on a movable box must not
      // fire it: the box is not open, so there is no word to select, and the
      // press is the start of a possible drag.
      const lpTimer = movable ? 0 : setTimeout(() => {
        if (this._pinchActive) return;   // two held fingers are a pinch
        lpFired = true;
        const { xPt, yPt } = toPt(startX, startY);
        this._post({ type: "selectWord", page, xPt, yPt });
        // Only while a run is open: a long-press then means "select this word to
        // work on it", which wants a keyboard (and brings it back if the user
        // hid it — the S37 behaviour, now on iOS too). With nothing open there
        // is no word to select and no reason to raise it (S39).
        this._setSinkFocus(this._editingPage === page);
      }, this.longPressMs);
      let dragging = false;
      let movingBox = false;
      const cleanup = () => {
        clearTimeout(lpTimer);
        if (movingBox) { this._draggingBox = false; this._hideMoveGhost(); }
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", abort);
      };
      // A drag that dies without moving anything (pointercancel, a pinch taking
      // over) has to put the bar back itself. A real DROP deliberately does not:
      // `blockMoved` re-renders it on the NEW rect, so it never flashes on the old.
      const abort = () => { const was = movingBox; cleanup(); if (was) this._renderBoxes(); };
      const move = (mv) => {
        if (this._pinchActive) { abort(); return; }   // a pinch owns both fingers (I17)
        if (!dragging) {
          if (Math.hypot(mv.clientX - startX, mv.clientY - startY) <= 8) return;
          clearTimeout(lpTimer);   // moved: no longer a tap or long-press
          // Past the slop on a movable box: this is a MOVE, not a pan. Nothing
          // is translated yet — only a ghost outline follows the pointer, so a
          // drag costs no engine work per frame.
          if (movable) {
            movingBox = true;
            dragging = true;
            // Park the Edit/Delete bar for the drag (Android parity, see the
            // `_draggingBox` note in the constructor). Hidden directly rather
            // than through a re-render: this runs inside a pointermove.
            this._draggingBox = true;
            this.actionsEl.style.display = "none";
            // One request per drag: the clamp range cannot change while a finger
            // is down, and the ghost is redrawn per pointermove.
            this._moveLimits = null;
            this._post({ type: movableImage ? "imageMoveLimits" : "moveLimits" });
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
          } else {
            if (this._editingPage !== page) { cleanup(); return; }  // no open run: plain pan
            dragging = true;
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
          }
        }
        if (movingBox) {
          const c = toPt(mv.clientX, mv.clientY);
          this._showMoveGhost(page, movingBounds(),
                              c.xPt - down.xPt, c.yPt - down.yPt);
          return;
        }
        // Anchor = press point, head = current point; the core clamps both to
        // the open run (desktop mouse-drag selection).
        const a = toPt(startX, startY);
        const c = toPt(mv.clientX, mv.clientY);
        this._post({ type: "dragSelect", page, ax: a.xPt, ay: a.yPt, xPt: c.xPt, yPt: c.yPt });
      };
      const up = (uv) => {
        const wasMoving = movingBox;
        const drop = wasMoving ? toPt(uv.clientX, uv.clientY) : null;
        cleanup();
        // A finger lifting off a pinch must not read as a tap (I17).
        if (this._pinchActive || performance.now() - this._lastPinchEnd < 350) return;
        // Drop: translate for real, ONCE. The worker re-resolves the block from
        // a fresh grouping, so it can never act on a stale index.
        if (wasMoving) {
          // Send the CLAMPED delta the ghost was showing, so the box lands exactly
          // where the outline was. Falls back to the raw delta if no ghost frame
          // ever ran (a drop within one frame of promotion).
          const raw = [drop.xPt - down.xPt, drop.yPt - down.yPt];
          const [dx, dy] = this._ghostDelta || raw;
          this._hideMoveGhost();          // clears the limits for the next drag
          if (dx || dy) {
            this._post(movableImage ? { type: "moveImage", dx, dy }
                                    : { type: "moveSelected", dx, dy });
          }
          else this._renderBoxes();       // nothing moved: nothing will restore the bar
          return;
        }
        if (lpFired) return;
        // A drag that ended: keep the keyboard only if a run is actually open
        // (a pan with nothing open must not raise one on iOS — S39).
        if (dragging) { this._setSinkFocus(this._editingPage >= 0); return; }
        const { xPt, yPt } = toPt(uv.clientX, uv.clientY);
        // SHIFT+CLICK EXTENDS THE SELECTION, the way it does in every text field
        // on the desktop: the caret's existing anchor stays put and the click
        // becomes the new head. Web-only by nature — it needs a keyboard and a
        // mouse at once, which a phone shell does not have (there, the handles
        // are the equivalent).
        //
        // The ANCHOR is the end that is NOT the head, so repeated shift+clicks
        // keep pivoting on the same character instead of collapsing onto the
        // previous click. `selectionDirection` is what distinguishes them, and
        // the selectionChanged handler already writes it back on every reply.
        //
        // Before the double-tap check: with Shift down this is an extend, not a
        // word-select, and two shift+clicks in the same spot must not become one.
        //
        // Gated on the click being INSIDE the open run, not merely on the same
        // page: editBoundary clamps to the run, so a shift+click out in the
        // margin would silently select all the way to whichever end was nearer
        // instead of doing what an unmodified click there does (commit, and pick
        // the box you actually clicked).
        if (uv.shiftKey && this._editingPage === page &&
            this._lastEditBounds && this._inBounds(this._lastEditBounds, { xPt, yPt })) {
          const s0 = this.sink.selectionStart, e0 = this.sink.selectionEnd;
          const anchor = (s0 !== e0 && this.sink.selectionDirection === "backward")
            ? e0 : s0;
          this._post({ type: "selectToPoint", page, xPt, yPt, anchor });
          this._setSinkFocus(true);   // a run is open, so the keyboard belongs to us
          return;
        }
        // Double-tap / double-click selects the word — the mouse-and-touch
        // sibling of long-press, reusing the SAME `selectWord` message so the
        // word-expansion rule lives in exactly one place (the worker). Detected
        // by hand rather than via `dblclick`, which never fires for touch here
        // (touch-action: pan-x pan-y suppresses the browser's double-tap).
        // Gated on the open run: before one is open there is no word to select,
        // so a double tap stays two plain taps and the select-then-open flow
        // (first tap picks the box, second opens it) is untouched.
        const dbl = this._editingPage === page &&
          this._lastTapPage === page &&
          performance.now() - this._lastTapAt < DOUBLE_TAP_MS &&
          Math.hypot(uv.clientX - this._lastTapX, uv.clientY - this._lastTapY) <= DOUBLE_TAP_SLOP;
        this._lastTapAt = dbl ? 0 : performance.now();   // a third tap starts over
        this._lastTapX = uv.clientX;
        this._lastTapY = uv.clientY;
        this._lastTapPage = page;
        this._post(dbl ? { type: "selectWord", page, xPt, yPt }
                       : { type: "tap", page, xPt, yPt });
        // Focus inside the user gesture — browsers only show a keyboard then —
        // but ONLY when this tap opens or continues an edit. Focusing on every
        // tap made a plain select-tap raise the keyboard on iOS, where focus and
        // keyboard are the same thing (S39). A double tap is a word-select and
        // only fires inside an open run, so it always wants one.
        this._setSinkFocus(dbl || this._tapWantsKeyboard(page, { xPt, yPt }));
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", abort);
    });
  }

  // ---- viewport gestures: tap-outside commit, pinch zoom, ctrl+wheel ------
  _wireViewportGestures() {
    this._pinchActive = false;
    this._lastPinchEnd = 0;
    this._pinch = null;

    // I9: taps that miss every canvas (the gray gutter) used to do NOTHING
    // except let the browser blur the sink — the edit stayed open but the
    // keyboard was silently dead. Route them as an explicit commit (the Android
    // tap-outside behavior). Host chrome lives OUTSIDE this element, so its
    // buttons can never double as a commit gesture; a host that wants
    // commit-on-its-own-button calls commit().
    this._listen(this.scroller, "pointerdown", (ev) => {
      if (this._editingPage < 0) return;
      if (ev.target.tagName === "CANVAS") return;          // canvas handler owns these
      if (ev.target.classList.contains("pdfe-handle")) return;
      // The caret thumb lives in the strip too — without this, grabbing it would
      // COMMIT the run instead of dragging the caret.
      if (ev.target.classList.contains("pdfe-carethandle")) return;
      // preventDefault so WE decide what happens to focus, not the browser (I9:
      // an uncontrolled blur left the edit open with a silently dead keyboard).
      ev.preventDefault();
      this._post({ type: "commit" });
      // Tapping outside ENDS the edit, so the keyboard must go with it. On iOS
      // that needs an explicit blur inside this gesture; on desktop it is
      // invisible either way (S39). The buffer is already mirrored to the worker
      // on every keystroke, so dropping focus here cannot lose text.
      this._setSinkFocus(false);
    });

    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const touchMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2,
                               y: (t[0].clientY + t[1].clientY) / 2 });

    // Native mobile pinch is a visual-viewport camera zoom: it STRETCHES the
    // rendered canvas bitmap and the text goes blurry (I17). So we suppress the
    // browser's pinch (touch-action above; the cancelable iOS gesture events
    // below, which Safari honors where touch-action is ignored) and drive the
    // APP's zoom instead, repainting sharp tiles. The page point between the
    // fingers is PINNED under the pinch midpoint.
    this._listen(this.scroller, "touchstart", (ev) => {
      if (ev.touches.length !== 2 || !this._pages.length) return;
      ev.preventDefault();
      const mid = touchMid(ev.touches);
      this._pinchActive = true;
      let anchor = this._pagePointAt(mid.x, mid.y);
      if (!anchor) anchor = this._nearestPagePoint(mid.x, mid.y);
      this._pinch = { dist0: touchDist(ev.touches), zoom0: this._zoom, anchor };
    }, { passive: false });

    this._listen(this.scroller, "touchmove", (ev) => {
      if (!this._pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      const mid = touchMid(ev.touches);
      this.setZoom(this._pinch.zoom0 * (touchDist(ev.touches) / this._pinch.dist0));
      if (this._pinch.anchor) this._scrollPagePointTo(this._pinch.anchor, mid.x, mid.y);
    }, { passive: false });

    const endPinch = (ev) => {
      if (!this._pinchActive) return;
      if (ev.touches && ev.touches.length >= 2) return;   // still pinching
      this._pinchActive = false;
      this._pinch = null;
      this._lastPinchEnd = performance.now();
    };
    this._listen(this.scroller, "touchend", endPinch);
    this._listen(this.scroller, "touchcancel", endPinch);

    // iOS Safari/WKWebView ignore touch-action and the viewport meta for their
    // page zoom, but these proprietary gesture events are cancelable and DO
    // block it.
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
      this._listen(this.scroller, t, (ev) => ev.preventDefault(), { passive: false });
    }

    this._listen(this.scroller, "wheel", (ev) => {
      if (!ev.ctrlKey) return;                 // trackpad pinch / ctrl+wheel
      ev.preventDefault();
      this.setZoom(this._zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
  }

  /** The page + (top-origin) page point under a client point, if any. */
  _pagePointAt(clientX, clientY) {
    const el = this._doc.elementsFromPoint(clientX, clientY)
      .find((e) => e.tagName === "CANVAS" && this._pageCanvases.includes(e));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const scaleCss = this._fitScale * this._zoom;
    return { page: Number(el.dataset.page),
             xPt: (clientX - r.left) / scaleCss,
             yPt: (clientY - r.top) / scaleCss };
  }

  // A pinch midpoint over the gray gutter has no canvas under it; with no
  // anchor at all the browser keeps a clamped scroll and the view lurches
  // toward the page end (iPhone report, I17 follow-up) — so anchor on the
  // NEAREST page instead.
  _nearestPagePoint(clientX, clientY) {
    let best = null, bestD = Infinity;
    for (const canvas of this._pageCanvases) {
      const r = canvas.getBoundingClientRect();
      const dx = Math.max(r.left - clientX, 0, clientX - r.right);
      const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = { canvas, r }; }
    }
    if (!best) return null;
    const scaleCss = this._fitScale * this._zoom;
    return {
      page: Number(best.canvas.dataset.page),
      xPt: (Math.min(Math.max(clientX, best.r.left), best.r.right) - best.r.left) / scaleCss,
      yPt: (Math.min(Math.max(clientY, best.r.top), best.r.bottom) - best.r.top) / scaleCss,
    };
  }

  /** Scroll so |pt| (top-origin page point) lands under a client position.
   *  Cached rects only — this runs per pinch move, right after setZoom's style
   *  writes, where a canvas.offset* read would relayout the whole strip. */
  _scrollPagePointTo(pt, clientX, clientY) {
    const rect = this._pageRect(pt.page);
    if (!rect) return;
    const scaleCss = this._fitScale * this._zoom;
    const v = this.scroller.getBoundingClientRect();
    this.scroller.scrollLeft =
      this._stripLeft + rect.left + pt.xPt * scaleCss - (clientX - v.left);
    this.scroller.scrollTop =
      this._stripTop + rect.top + pt.yPt * scaleCss - (clientY - v.top);
  }

  // ---- hidden-input IME sink (§7) -----------------------------------------
  // The direct analog of Android's InputSinkEditText: an off-screen editable
  // whose only job is to summon the keyboard, receive keystrokes AND
  // composition, and mirror the full buffer + caret to the worker. NEVER a
  // visible editor. WebKit has no EditContext, so this path is permanent.
  _wireSink() {
    const push = () => {
      this._post({
        type: "edit",
        fullText: this.sink.value,
        caretIndex: this.sink.selectionStart,
        selStart: this.sink.selectionStart,
        selEnd: this.sink.selectionEnd,
        generation: ++this._editGeneration,
        postedAt: performance.now(),
      });
    };
    this._pushEdit = push;

    // Full composition handling from day one (§7): every intermediate buffer
    // state is mirrored (the worker's newest-wins latch coalesces).
    // THE SELECTION THIS GESTURE IS ABOUT TO REPLACE (I69b). A sink mutation is
    // destructive: by the time `input` fires, a selected word is already gone and the
    // caret already collapsed. If the core then REFUSES the gesture (an emoji, which
    // no font can draw), we have to put the selection back — and this is the last
    // moment it exists. Captured only when there is no unsent change, so it names the
    // state before the FIRST edit of a coalesced burst rather than the middle of one.
    this._listen(this.sink, "beforeinput", () => {
      if (this._preEditSel) return;
      this._preEditSel = [this.sink.selectionStart, this.sink.selectionEnd];
    });
    this._listen(this.sink, "compositionstart", () => { this._composing = true; });
    this._listen(this.sink, "compositionupdate", () => push());
    this._listen(this.sink, "compositionend", () => { this._composing = false; push(); });
    this._listen(this.sink, "input", () => {
      if (this._composing) return;
      push();
      // Phase 5 (word-level undo): a ~300 ms typing pause finishes the word —
      // the next keystroke starts a fresh undo entry. The core is clockless;
      // this debounce is the shell's half of pdfe_history_seal. Whitespace,
      // leaving the box and caret moves seal on their own paths.
      clearTimeout(this._sealTimer);
      this._sealTimer = setTimeout(() => this._post({ type: "sealHistory" }), 300);
    });
    this._listen(this.sink, "blur", () => this._post({ type: "sealHistory" }));
    this._listen(this.sink, "keydown", (e) => {
      // Undo/redo FIRST — before every other binding. See _handleHistoryKey for
      // why its preventDefault is load-bearing.
      if (this._handleHistoryKey(e)) return;
      // Ctrl/Cmd+A selects the whole open run. The sink's own select-all would
      // "work" invisibly — the range lands in the textarea, but nothing posts it
      // to the worker, so no highlight and no handles ever appear (and the next
      // keystroke silently replaces the run). preventDefault, then drive the same
      // selectionChanged path every other selection gesture uses.
      if ((e.ctrlKey || e.metaKey) && !e.altKey &&
          (e.key === "a" || e.key === "A") && this._editingPage >= 0) {
        e.preventDefault();
        const len = this.sink.value.length;
        if (!len) return;                     // empty run: stay a collapsed caret
        this.sink.setSelectionRange(0, len);
        this._post({ type: "selectRange", start: 0, end: len });
        return;
      }
      // Up/Down/Home/End must move by the PDF wrap, not the sink textarea's own
      // layout — the 1×1 sink wraps at every char, so its native motion
      // degenerates. Route through the core: caret/head geometry, one line up or
      // down (or an extreme x for Home/End), boundaryAt picks the char. Shift
      // extends (the moved end is the HEAD, the anchor stays); unshifted with a
      // selection collapses to the edge in the travel direction first.
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) && this._editingPage >= 0) {
        e.preventDefault();
        const dir = e.key === "ArrowUp" || e.key === "Home" ? -1 : 1;
        const edge = e.key === "Home" ? -1 : e.key === "End" ? 1 : 0;
        const s = this.sink.selectionStart, en = this.sink.selectionEnd;
        this._wantCaretScroll = true;   // keyboard motion may leave the viewport
        if (e.shiftKey) {
          const headAtStart = s !== en && this.sink.selectionDirection === "backward";
          this._post({
            type: "caretLine", dir, edge, extend: true,
            index: headAtStart ? s : en,
            anchor: headAtStart ? en : s,
          });
        } else {
          this._post({ type: "caretLine", dir, edge, index: s !== en ? (dir < 0 ? s : en) : s });
        }
        return;
      }
      // Left/Right move the caret (or extend with Shift) without firing an
      // input event — mirror those so the overlays track.
      if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
        setTimeout(push, 0);
        // AND REPORT THE STYLE AT THE NEW CARET. An arrow key is an explicit
        // cursor move, exactly like a click, so it owes the host the same answer
        // — but Left/Right are the only caret motion the sink handles ENTIRELY on
        // its own: Up/Down/Home/End go through `caretLine` and taps through
        // `tap`, both of which reach postCaretMoved in the worker, while these
        // reached nothing. The swatch therefore kept the colour of wherever the
        // caret had last been PUT BY MOUSE (reported: colour a word red, then
        // arrow back over black text and the toolbar stays red).
        //
        // A collapsed `selectRange` is deliberately the vehicle: the worker
        // degrades it to postCaretMoved, so the style read and the typing-colour
        // clear are the same code every other cursor move already runs.
        setTimeout(() => {
          if (this._editingPage < 0) return;
          const s = this.sink.selectionStart, en = this.sink.selectionEnd;
          // Shift+arrow is left alone: its reply carries no `headAtStart`, so
          // driving it through here would reset the sink's selectionDirection and
          // the NEXT Shift+arrow would extend the wrong end. The edit pass above
          // already carries that case's handles.
          if (s !== en) return;
          this._post({ type: "selectRange", start: s, end: s });
        }, 0);
      }
    });
  }
}

export default PdfeEditor;
