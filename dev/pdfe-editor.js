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

// imageRotateControl's vocabulary (docs/IMAGE_EDIT.md). The SAME four words on web,
// Android (PdfeEditorView.ROTATE_CONTROL_*) and the iOS bridge — one behaviour, one
// spelling, so a cross-platform product configures it once.
const PDFE_ROTATE_CONTROLS = ["both", "handle", "bar", "none"];

// THE THREE MODES (docs/annotations/12-VOCABULARY.md). Peers, never combinable --
// two booleans can express "annotate && !annotate", three named values cannot (D9).
// The SAME three words on web, Android (PdfeMode.wire) and the iOS bridge; the parity
// gate asserts the three spellings are identical.
const PDFE_MODES = ["view", "text", "annotate"];

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
  display: flex; flex-direction: column; align-items: center; gap: var(--pdfe-gap, 8px);
  /* min-width: max-content: when a zoomed canvas grows wider than the viewport
     a centered flex child overflows BOTH sides and the left half is
     unreachable by scrolling (I17 follow-up). Sizing the strip to its content
     makes the scroll range cover everything. */
  min-width: max-content;
}
.pdfe-strip canvas { background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.45); display: block; }
/* The live pen / eraser trail is a canvas in the strip too: it must stay see-through, or the page
   under it goes white for the whole stroke (3.16.0 report). */
.pdfe-strip canvas.pdfe-drawlive { background: transparent; box-shadow: none; }
.pdfe-layer { position: absolute; left: 0; top: 0; }
/* W6, the reader: NIGHT MODE inverts the pages as drawn (the document is untouched), and a
   locked scroll keeps the pages still while pinch and taps still work. */
.pdfe-night .pdfe-strip canvas[data-page] { filter: invert(1); }
.pdfe-scroll.pdfe-noscroll { overflow: hidden; }
/* W6b: SIDEWAYS pages (scrollDirection "horizontal") — one row, each page fitted into the view and
   centred on its height. PAGE SNAP — a swipe stops on a whole page, centred; a page bigger than the
   view (zoomed in) still pans freely inside it, which is how scroll-snap treats an oversized area. */
.pdfe-strip.pdfe-h { flex-direction: row; padding: 0 12px; min-height: 100%; box-sizing: border-box; }
.pdfe-scroll.pdfe-snap { scroll-snap-type: y mandatory; }
.pdfe-scroll.pdfe-snap.pdfe-hscroll { scroll-snap-type: x mandatory; }
.pdfe-scroll.pdfe-snap .pdfe-strip canvas[data-page] { scroll-snap-align: center; scroll-snap-stop: always; }
/* Edit-mode paragraph boxes. The hairline stays 1px at every zoom (a thicker
   rule would sit ON the glyphs); visibility comes from ALPHA and a faint fill,
   not from weight (user decision 2026-07-29). Edit mode draws every box as a
   GREY DASHED hairline; the selected box switches to a SOLID SKY-BLUE hairline
   with a blue wash (user decision 2026-07-29), so "which box am I acting on"
   is unmistakable without the overlay ever growing. */
.pdfe-search-hit { position: absolute; pointer-events: none;
                   background: var(--pdfe-search, #ffeb3b66); }
.pdfe-search-hit.pdfe-current { background: var(--pdfe-search-current, #ff980088); }
.pdfe-parabox { position: absolute;
                border: var(--pdfe-line, 1px) var(--pdfe-box-style, dashed) var(--pdfe-box-border, #757575cc);
                background: var(--pdfe-box-fill, #7575751f);
                pointer-events: none; border-radius: var(--pdfe-box-radius, 1px); }
.pdfe-parabox.pdfe-selected { border-style: solid; border-color: var(--pdfe-sel-border, #03a9f4);
                              background: var(--pdfe-sel-fill, #03a9f426); }
/* setAppearance({showBoxOutlines: false}) (3.3.0): only the selected box and picture show. */
.pdfe-nooutlines .pdfe-parabox:not(.pdfe-selected),
.pdfe-nooutlines .pdfe-imagebox:not(.pdfe-imagebox-selected) { display: none; }
/* A SELECTED PICTURE. Same sky blue as a selected text box so "this is
   selected" reads identically, but a POLYGON — a turned picture's outline is
   still a rectangle geometrically and still needs four arbitrary corners, and a
   CSS box cannot express that. pointer-events: none for the same reason the
   paragraph boxes have it: the canvas below owns the tap. */
.pdfe-imagebox { position: absolute; pointer-events: none; overflow: visible; }
/* UNSELECTED: the picture's twin of .pdfe-parabox — a grey dashed hairline that
   says "this is a thing you can grab", drawn for every picture in edit mode. */
.pdfe-imagebox polygon { fill: none; stroke: var(--pdfe-image-border, #9e9e9e); stroke-width: var(--pdfe-line, 1px);
                         stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
/* SELECTED: solid sky blue + the same wash, matching .pdfe-parabox.pdfe-selected
   so "selected" reads identically whichever kind it is. Two pixels, not one: a
   1 px hairline over a busy photograph is genuinely hard to see, which is what
   the first look at this reported. */
.pdfe-imagebox-selected polygon { fill: var(--pdfe-pic-fill, transparent); stroke: var(--pdfe-sel-border, #03a9f4);
                                  stroke-width: calc(2 * var(--pdfe-line, 1px));
                                  stroke-dasharray: none; }
/* The rotate handle. Sky blue to read as part of the selection, circular so it
   is obviously a button and not a resize grip — this feature has no resize, and
   a square corner handle would promise one. 28 px is the smallest comfortable
   touch target that still sits on a small picture. */
.pdfe-rotate { position: absolute; z-index: 5; display: none;
               width: 28px; height: 28px; padding: 0; border-radius: 50%;
               border: 1px solid var(--pdfe-rotate, #03a9f4); background: #fff; color: var(--pdfe-rotate, #03a9f4);
               box-shadow: 0 1px 4px #0003; cursor: pointer;
               align-items: center; justify-content: center; }
.pdfe-rotate:hover { background: var(--pdfe-rotate, #03a9f4); color: #fff; }
.pdfe-rotate:active { transform: scale(0.92); }
/* W5c: the knobs of a selected picture/signature (PdfeHandleConfig), the ↘ button and the ×.
   The element is the finger-sized hit area; the dot inside it is what is drawn. */
.pdfe-knob { position: absolute; z-index: 5; display: flex; align-items: center; justify-content: center;
             pointer-events: auto; touch-action: none; cursor: grab; }
.pdfe-knob-dot { display: flex; align-items: center; justify-content: center; border-radius: 50%; flex: none; }
.pdfe-tfbutton { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
                 border-radius: 50%; box-shadow: 0 0 0 1px #0003, 0 1px 4px #0003; flex: none; }
.pdfe-knob-icon { display: flex; align-items: center; justify-content: center; }
.pdfe-knob-icon img, .pdfe-knob-icon svg { width: 100%; height: 100%; }
.pdfe-stampbox polygon { fill: var(--pdfe-sel-fill, #03a9f426); }
.pdfe-strip canvas.pdfe-live { position: absolute; display: none; z-index: 4; background: transparent;
                               box-shadow: none; pointer-events: none; }
/* EXPERIMENTAL (feature/web-block-move): the drag ghost. A box being dragged is
   previewed as an outline that follows the finger; the real text is translated
   ONCE on drop, so a drag costs no engine work per frame. Dashed and washed so
   it reads as "not there yet", and above the faint boxes it slides over. */
.pdfe-moveghost { position: absolute; border: calc(2 * var(--pdfe-line, 1px)) dashed var(--pdfe-ghost-border, #03a9f4);
                  background: var(--pdfe-ghost-fill, #03a9f41f);
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
.pdfe-editbox { position: absolute; border: var(--pdfe-line, 1px) var(--pdfe-edit-style, solid) var(--pdfe-edit-border, #1976d2);
                background: var(--pdfe-edit-fill, transparent);
                border-radius: var(--pdfe-box-radius, 1px);
                display: none; pointer-events: none; z-index: 1; }
/* The selected box's action bar: the ONLY chrome the SDK owns, because it is
   part of the canvas gesture (it must sit ON the box it acts on). It lives in
   the strip, so it scrolls and zooms with the page for free. */
.pdfe-actions { position: absolute; z-index: 4; display: none; gap: 2px; padding: 3px;
                border-radius: var(--pdfe-bar-radius, 8px); background: var(--pdfe-bar-bg, #fff);
                box-shadow: 0 2px 10px #00000059, 0 0 0 1px var(--pdfe-bar-border, transparent);
                white-space: nowrap; }
.pdfe-actions button { font: var(--pdfe-bar-weight, 600) var(--pdfe-bar-size, 13px)/1 system-ui, -apple-system, sans-serif;
                       color: var(--pdfe-bar-text, #1a237e); background: transparent; border: 0;
                       border-radius: 6px; padding: 8px 12px; cursor: pointer;
                       touch-action: manipulation; }
.pdfe-actions button:hover { background: #3f51b51f; }
.pdfe-actions .pdfe-act-rotate { color: var(--pdfe-bar-text, #1a237e); }
.pdfe-actions .pdfe-act-rotate:hover { background: #1a237e1f; }
.pdfe-actions .pdfe-act-del { color: var(--pdfe-bar-delete, #c62828); }
/* setAppearance (3.3.0): the icon ABOVE the label, and thin lines between buttons. */
/* Only a button carrying an app icon is a flex row, so the SDK's own text buttons keep their look. */
.pdfe-actions button.pdfe-has-icon { display: inline-flex; align-items: center; gap: 4px; }
.pdfe-actions.pdfe-icontop button.pdfe-has-icon { flex-direction: column; }
.pdfe-actions.pdfe-dividers button + button { box-shadow: -1px 0 0 var(--pdfe-bar-border, #00000022); }
.pdfe-actions .pdfe-act-icon { display: inline-flex; width: 20px; height: 20px; }
.pdfe-actions .pdfe-act-icon > * { width: 100%; height: 100%; }
/* The APP's own bar (setActionBarElement): the SDK only places it. */
.pdfe-actions.pdfe-hostbar { padding: 0; background: none; box-shadow: none; border-radius: 0; }
.pdfe-actions .pdfe-act-del:hover { background: #c628281f; }
/* W7b: the bar's POINTER (PdfeAppearance.barPointer) — a small triangle in the bar's colour on the
   edge that faces the item, under the item's middle. */
.pdfe-barptr { position: absolute; width: 0; height: 0; pointer-events: none;
               border-left: 7px solid transparent; border-right: 7px solid transparent; }
.pdfe-barptr.pdfe-down { top: 100%; border-top: 7px solid var(--pdfe-bar-bg, #fff); filter: drop-shadow(0 2px 1px #0003); }
.pdfe-barptr.pdfe-up { bottom: 100%; border-bottom: 7px solid var(--pdfe-bar-bg, #fff); filter: drop-shadow(0 -2px 1px #0003); }
/* W7b: the MAGNIFIER (PdfeAppearance.magnifier*) — a loupe over the page under the finger while
   a finger drags a selection knob, the caret thumb or a drag-selection. Touch only, as on Android. */
.pdfe-loupe { position: absolute; z-index: 6; display: none; pointer-events: none; background: #fff; overflow: hidden; }
.pdfe-loupe > canvas { display: block; width: 100%; height: 100%; }
.pdfe-loupe > div { position: absolute; inset: 0; }
/* W7a: the open box's own look — the words an empty box shows, its decorative corner knobs, and
   the MOVE button above it (PdfeAppearance placeholderColor / editingCornerKnobs / moveHandle*). */
.pdfe-placeholder { position: absolute; left: 2px; white-space: nowrap; pointer-events: none;
                    color: var(--pdfe-placeholder, #9e9e9e); font-family: system-ui, -apple-system, sans-serif; line-height: 1; }
.pdfe-editknob { position: absolute; border-radius: 50%; pointer-events: none; }
.pdfe-movebtn { position: absolute; z-index: 5; display: none; width: 28px; height: 28px; border-radius: 50%;
                background: var(--pdfe-move-bg, #fff); color: var(--pdfe-edit-border, #1976d2);
                box-shadow: 0 0 0 1px var(--pdfe-edit-border, #1976d2), 0 1px 4px #0003;
                align-items: center; justify-content: center; cursor: move; touch-action: none; }
.pdfe-movebtn > * { width: 18px; height: 18px; }
.pdfe-caret { position: absolute; width: 2px; background: #000; z-index: 1;
              display: none; pointer-events: none; animation: pdfe-blink 1s steps(1) infinite; }
@keyframes pdfe-blink { 50% { opacity: 0; } }
.pdfe-selrect { position: absolute; background: var(--pdfe-textsel, #3f51b555); z-index: 1; pointer-events: none; }
.pdfe-handle { position: absolute; width: 18px; height: 18px; border-radius: 50%;
               background: var(--pdfe-handle, #3f51b5); border: 2px solid #fff; box-shadow: 0 1px 4px #0007;
               z-index: 3; display: none; touch-action: none; cursor: grab; }
/* The CARET thumb: the insertion handle under a COLLAPSED caret, so a finger can
   drag the caret instead of having to tap the exact glyph. Its own class (not
   .pdfe-handle) because _drawHandles owns those two and hides them on every
   collapsed-caret message. Deliberately NOT inside .pdfe-caret: the caret blinks,
   and a blinking grip reads as a rendering fault. */
.pdfe-carethandle { position: absolute; width: 18px; height: 18px; border-radius: 50%;
                    background: var(--pdfe-handle, #3f51b5); border: 2px solid #fff; box-shadow: 0 1px 4px #0007;
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

// THE CLIENT'S OWN DESIGN (3.3.0): each setAppearance field -> its CSS variable. The
// names are Android's PdfeAppearance's; the CSS above falls back to today's look.
const PDFE_APPEARANCE_VARS = {
  boxBorderColor: "--pdfe-box-border", boxFillColor: "--pdfe-box-fill",
  selectedBorderColor: "--pdfe-sel-border", selectedFillColor: "--pdfe-sel-fill",
  editingBorderColor: "--pdfe-edit-border", imageBorderColor: "--pdfe-image-border",
  textSelectionColor: "--pdfe-textsel", handleColor: "--pdfe-handle",
  ghostBorderColor: "--pdfe-ghost-border", ghostFillColor: "--pdfe-ghost-fill",
  rotateHandleColor: "--pdfe-rotate", selectedPictureFillColor: "--pdfe-pic-fill",
  editingFillColor: "--pdfe-edit-fill", placeholderColor: "--pdfe-placeholder", moveHandleColor: "--pdfe-move-bg", borderWidthDp: "--pdfe-line", cornerRadiusDp: "--pdfe-box-radius",
  searchHighlightColor: "--pdfe-search", searchCurrentColor: "--pdfe-search-current",
  barBackgroundColor: "--pdfe-bar-bg", barBorderColor: "--pdfe-bar-border",
  barCornerRadiusDp: "--pdfe-bar-radius", barTextColor: "--pdfe-bar-text",
  barDeleteColor: "--pdfe-bar-delete", barTextSizeSp: "--pdfe-bar-size",
};
const PDFE_BUILT_IN_ACTIONS = new Set(["edit", "copy", "delete", "rotate", "rotate_left", "rotate_right"]);
const PDFE_ACTION_LABEL = { edit: "✎ Edit", copy: "⧉ Copy", delete: "🗑 Delete", rotate: "⟳ Rotate",
  rotate_left: "⟲ Left", rotate_right: "⟳ Right",   // a quarter turn each way (Android 3.11.0)
  // the words menu's four tools (W3) — Android's labels; no glyph, a tool name is its own label
  highlight: "Highlight", underline: "Underline", squiggle: "Squiggle", strikeout: "Strikeout" };
const PDFE_ACTION_CLASS = { edit: "pdfe-act-edit", copy: "pdfe-act-copy", delete: "pdfe-act-del", rotate: "pdfe-act-rotate",
  rotate_left: "pdfe-act-rotate", rotate_right: "pdfe-act-rotate" };

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

// ---- SIGNATURES (W4) — pdf/SignaturePlacement.kt + the pure core hit rule, transcribed ----
/** The faces a typed signature or a text item may name (PdfeSignatureFonts). @since 3.15.0 */
export const PdfeSignatureFonts = Object.freeze({
  PLAIN: "LiberationSerif-Regular",
  DEFAULT: "LiberationSerif-Regular",
  HANDWRITING: Object.freeze(["DancingScript-Regular", "GreatVibes-Regular", "Caveat-Regular", "MrDafoe-Regular"]),
});
const PDFE_STAMP_KIND_NAMES = ["signature", "signaturetext", "stamp"];
const PDFE_PAGE_KIND_NAMES = ["noText", "text", "scanned", "scannedWithOcr"];   // PDFE_PAGE_KIND_* (3.16.0)   // PDFE_STAMP_SIGNATURE/DATE/FOREIGN
/** DRAWING (DR3, vocabulary §25): the tools, and Android's defaults (DrawingToolState). The pen's
 *  width is in CSS px (Android dp) at the zoom it is drawn, as the reference app's slider: 1–34,
 *  default 7; the eraser's 5–60, default 10. A stroke keeps a point only once the pointer moved
 *  MIN_DIST_PX, and is smoothed in pieces of PIECE_PX — both handed to the core in page points. */
const PDFE_DRAWING_TOOLS = ["pen", "eraser"];
const PDFE_DRAWING = Object.freeze({
  color: 0xff000000, widthDp: 7, widthMinDp: 1, widthMaxDp: 34,
  eraserWidthDp: 10, eraserMinDp: 5, eraserMaxDp: 60,
  minDistPx: 2, piecePx: 3, eraserTrail: "rgba(120, 134, 157, 0.2)",   // the reference's 0x3378869D
});
/** pdfe_ink_distance's rule in JS (the cached points, no worker hop): the nearest segment or dot. */
function inkDistance(paths, x, y) {
  let best = -1;
  for (const p of paths) {
    const n = p.length >> 1;
    if (!n) continue;
    if (n === 1) { const d = Math.hypot(p[0] - x, p[1] - y); if (best < 0 || d < best) best = d; continue; }
    for (let i = 0; i + 1 < n; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], dx = p[2 * i + 2] - ax, dy = p[2 * i + 3] - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (best < 0 || d < best) best = d;
    }
  }
  return best;
}
/** The topmost ink a point reaches (within half its width + |slop|), or null. Hidden and nameless
 *  inks are never hit; other apps' only with |foreign| (otherAppInkEditable). */
function inkHit(list, x, y, slop, foreign) {
  let hit = null;
  for (const k of list) {
    if (k.flags & 6) continue;                     // PDFE_INK_F_HIDDEN | _NONAME
    if (k.foreign && !foreign) continue;
    const r = k.rect, reach = k.widthPt / 2 + slop;
    if (x < r[0] - slop || x > r[2] + slop || y < r[1] - slop || y > r[3] + slop) continue;
    const d = inkDistance(k.paths, x, y);
    if (d >= 0 && d <= reach && (!hit || k.annotIndex > hit.annotIndex)) hit = k;
  }
  return hit;
}
/** A drawing's box /Rect [l, b, r, t] (its points grown by |hw|, half the width) dragged onto
 *  |to|: the matrix [sx, 0, 0, sy, ox, oy] that carries the POINTS so the new /Rect is |to|
 *  exactly — the width does not scale, so the points' own span maps onto |to| less the same
 *  margin (DrawingToolState.inkBoxMatrix, the Kotlin twin). A span too thin to scale (a straight
 *  line along that axis) scales with the whole box, or only moves. |page| [l, b, r, t] (optional):
 *  an edge that was on the page stays on it (the knobs' limits allow half a pixel over, and a box
 *  over the edge may no longer grow). */
function inkBoxMatrix(rect, hw, to, page) {
  if (page) {
    to = [rect[0] >= page[0] ? Math.max(to[0], page[0]) : to[0], rect[1] >= page[1] ? Math.max(to[1], page[1]) : to[1],
          rect[2] <= page[2] ? Math.min(to[2], page[2]) : to[2], rect[3] <= page[3] ? Math.min(to[3], page[3]) : to[3]];
  }
  const axis = (a0, a1, b0, b1) => {
    const fa = a1 - a0 - 2 * hw, fb = b1 - b0 - 2 * hw;
    if (fa > 1e-3 && fb > 1e-3) { const s = fb / fa; return [s, b0 + hw - s * (a0 + hw)]; }
    if (a1 - a0 > 1e-3) { const s = (b1 - b0) / (a1 - a0); return [s, b0 - s * a0]; }
    return [1, (b0 + b1 - a0 - a1) / 2];
  };
  const [sx, ox] = axis(rect[0], rect[2], to[0], to[2]), [sy, oy] = axis(rect[1], rect[3], to[1], to[3]);
  return [sx, 0, 0, sy, ox, oy];
}
/** SignaturePlacement.signatureSize: 30% of the page wide, height from the shape, at most half the page tall. */
function signatureSize(aspect, pw, ph) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 3;
  let w = pw * 0.30, h = w / a;
  if (h > ph * 0.5) { h = ph * 0.5; w = h * a; }
  return [w, h];
}
/** SignaturePlacement.typedAspect / textSize. */
const typedAspect = (chars) => Math.min(8, Math.max(2, chars * 0.5));
const textSize = (chars, pw) => [Math.min(pw, Math.max(chars, 1) * 16 * 0.55 + 6), 16];
/** pdfe_stamp_hit over a cached list: the topmost (highest annotIndex) live, named stamp. */
function stampHit(list, x, y, foreign) {
  let best = -1;
  (list || []).forEach((st, i) => {
    if (st.flags & (1 | 8)) return;                  // HIDDEN | NONAME
    if (st.kind === 2 && !foreign) return;           // another app's, while not editable
    const r = st.rect;
    if (x < r[0] || x > r[2] || y < r[1] || y > r[3]) return;
    if (best < 0 || st.annotIndex > list[best].annotIndex) best = i;
  });
  return best;
}

/** StampDrop (I135), transcribed: the page whose box overlaps the ghost MOST (rects
 *  [left, top, right, bottom]), or -1; and a rect [l, b, r, t] put inside |box|, shrunk to 0.95
 *  of it about its centre when it does not fit. */
function stampDropTarget(ghost, pages) {
  let best = -1, bestArea = 0;
  for (const [p, r] of pages) {
    const w = Math.min(ghost[2], r[2]) - Math.max(ghost[0], r[0]);
    const h = Math.min(ghost[3], r[3]) - Math.max(ghost[1], r[1]);
    if (w <= 0 || h <= 0) continue;
    if (w * h > bestArea) { bestArea = w * h; best = p; }
  }
  return best;
}
function stampFitInside(rect, box) {
  let w = rect[2] - rect[0], h = rect[3] - rect[1];
  const bw = box[2] - box[0], bh = box[3] - box[1];
  if (w > bw || h > bh) { const k = 0.95 * Math.min(bw / w, bh / h); w *= k; h *= k; }
  const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
  const l = Math.min(Math.max(cx - w / 2, box[0]), box[2] - w);
  const b = Math.min(Math.max(cy - h / 2, box[1]), box[3] - h);
  return [l, b, l + w, b + h];
}

/** An `error` event payload that is also a PdfeError: `{code, detail}` as the event is
 *  documented, plus `message`. A bare PdfeError left `detail` undefined. */
function errorEvent(code, detail) { return new PdfeError(code, detail, { detail }); }

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

// The markup tool's defaults — Android's pdf/MarkupToolState.kt, byte for byte (parity rule 15).
const PDFE_MARKUP_TOOLS = ["highlight", "underline", "squiggle", "strikeout"];   // = core kind 0..3
const PDFE_MARKUP_DEFAULT_COLORS = {
  highlight: 0xFFFFEB3B, underline: 0xFF1E63D6, squiggle: 0xFF2E9E4F, strikeout: 0xFFE53935,
};
const PDFE_MARKUP_DEFAULT_AUTHOR = "PDFe";
const PDFE_MARKUP_MAX_AUTHOR_UTF16 = 256;
const PDFE_MARKUP_LINE = { ratioDefault: 0.0806, minDefault: 1.0, ratioMin: 0.01, ratioMax: 0.5,
                           minMin: 0.1, minMax: 20.0 };
const PDFE_PAGE_PRESS_REACH_PX = 8;   // Android's PAGE_PRESS_REACH_DP
// The SDK's own words menu (Android's PdfeSelectionMenuItem, lower-case as its action ids).
const PDFE_SELECTION_MENU_ITEMS = ["copy", "highlight", "underline", "squiggle", "strikeout"];
// A per-mode menu layout of 0 means "the SDK's own", null "the shared one" (Android's Int?).
const isMenuLayout = (v) => v === null || v === undefined || v === 0 || (!!v && v.nodeType === 1);

/** 0xAARRGGBB -> a CSS rgba() with its alpha scaled by |alphaScale|. */
function argbCss(argb, alphaScale = 1) {
  const a = ((argb >>> 24) & 255) / 255 * alphaScale;
  return `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${a.toFixed(3)})`;
}

/** MarkupHit.topmost, transcribed: the LAST mark (topmost) with a quad under the point. */
function topmostMark(marks, x, y) {
  for (let i = marks.length - 1; i >= 0; i--) {
    const q = marks[i].quads || [];
    for (let k = 0; k + 8 <= q.length; k += 8) {
      const l = Math.min(q[k], q[k + 2], q[k + 4], q[k + 6]);
      const r = Math.max(q[k], q[k + 2], q[k + 4], q[k + 6]);
      const b = Math.min(q[k + 1], q[k + 3], q[k + 5], q[k + 7]);
      const t = Math.max(q[k + 1], q[k + 3], q[k + 5], q[k + 7]);
      if (x >= l && x <= r && y >= b && y <= t) return i;
    }
  }
  return -1;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/**
 * pdf/PinchZoom.kt, transcribed (W6) — the pinch's rubber band, its glide back, the coast after a
 * thrown pinch, and where a double-tap goes. Pure; web/sdk/reader_test.mjs is PinchZoomTest.kt.
 */
const PinchZoom = {
  /** One pinch step of |factor| from |zoom|: plain inside the limits, resisted outside them. */
  next(zoom, factor, min, max, overMin, overMax) {
    let f = factor;
    const cl = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    if (f < 1 && zoom < min) f = 1 - (1 - f) * cl((zoom - overMin) / (min - overMin), 0, 1);
    else if (f > 1 && zoom > max) f = 1 + (f - 1) * cl((overMax - zoom) / (overMax - max), 0, 1);
    return cl(zoom * f, overMin, overMax);
  },
  /** A critically damped spring, 0..1 over 0..1: leaves quickly, lands without overshoot. */
  spring(t) {
    const w = 7, end = 1 - (1 + w) * Math.exp(-w);
    return Math.min(1, Math.max(0, (1 - (1 + w * t) * Math.exp(-w * t)) / end));
  },
  /** Where a thrown pinch coasts to (|velocity| log units / s), or null when too slow. */
  momentumTarget(zoom, velocity, min, max, durationMs) {
    if (Math.abs(velocity) < 0.3 || zoom < min || zoom > max) return null;
    const delta = Math.min(zoom * 0.5, Math.max(-zoom * 0.5, zoom * velocity * durationMs / 1000 / PINCH_COAST_SLOPE));
    const target = Math.min(max, Math.max(min, zoom + delta));
    return Math.abs(target - zoom) > zoom * 0.005 ? target : null;
  },
  /** The coast's curve: leaves at the pinch's own speed and decays to rest. */
  coast: (t) => Math.min(1, Math.max(0, (1 - Math.exp(-4 * t)) / (1 - Math.exp(-4)))),
  /** HOME is fit-width (1), or |min| above 1: away from home -> home; at home -> |tapZoom|. */
  doubleTapTarget(zoom, min, tapZoom) {
    const home = Math.max(min, 1);
    return Math.abs(zoom - home) > 0.01 ? home : tapZoom;
  },
  restingTarget: (zoom, min, max) => (zoom < min ? min : zoom > max ? max : null),
};
const PINCH_COAST_SLOPE = 4 / (1 - Math.exp(-4));
/**
 * PdfeZoomConfig.normalized() — impossible values corrected, never thrown. |base| carries the web's
 * own resting limits (0.25 / 3 unless the host passed minZoom / maxZoom: a desktop page starts
 * smaller than the width); the stretch defaults keep Android's proportions (half the min, 1.3x the max).
 */
function normalizeZoomConfig(v, base) {
  v = v || {};
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const min = Math.max(0.1, num(v.minZoom) ?? base.minZoom);
  const max = Math.max(min, num(v.maxZoom) ?? Math.max(min, base.maxZoom));
  const ms = (x, d) => Math.max(0, Math.round(num(x) ?? d));
  return Object.freeze({
    minZoom: min, maxZoom: max,
    stretchBeyondLimits: v.stretchBeyondLimits !== false,
    stretchMin: Math.min(min, Math.max(0.1, num(v.stretchMin) ?? min * 0.5)),
    stretchMax: Math.max(max, num(v.stretchMax) ?? max * 1.3),
    springBackDurationMs: ms(v.springBackDurationMs, 520),
    doubleTapEnabled: v.doubleTapEnabled !== false,
    doubleTapZoom: Math.min(max, Math.max(min, num(v.doubleTapZoom) ?? 2.5)),
    doubleTapDurationMs: ms(v.doubleTapDurationMs, 380),
    pinchMomentum: v.pinchMomentum !== false,
    pinchMomentumDurationMs: ms(v.pinchMomentumDurationMs, 500),
  });
}

/** Is (x, y) inside the quad |c| (8 floats, 4 corners in order)? (PdfPageView.pointInQuad) */
function pointInQuad(c, x, y) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = c[2 * i], yi = c[2 * i + 1], xj = c[2 * j], yj = c[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** PdfeHandleJob / PdfeHandlePosition (Android enums) as strings — the same words on the bridge. */
const PDFE_HANDLE_JOBS = ["none", "resize", "rotate", "resizeAndRotate", "stretch"];
const PDFE_HANDLE_POSITIONS = ["topLeft", "top", "topRight", "right", "bottomRight", "bottom", "bottomLeft", "left"];
const handleStyleOf = (s) => {
  if (!s || typeof s !== "object") return null;
  const o = {};
  if (PDFE_HANDLE_JOBS.includes(s.job)) o.job = s.job;
  if (typeof s.filled === "boolean") o.filled = s.filled;
  for (const k of ["fillColor", "borderColor", "icon"]) if (typeof s[k] === "string") o[k] = s[k];
  for (const k of ["radiusDp", "strokeWidthDp"]) if (Number.isFinite(s[k]) && s[k] >= 0) o[k] = s[k];
  return o;
};
/** A host's knob config, cleaned: unknown jobs fall to the default, and the two slots that do
 *  not take every job corrected (PdfeHandleConfig.normalized). */
function normalizeHandleConfig(v) {
  const j = (x, d) => (PDFE_HANDLE_JOBS.includes(x) ? x : d);
  v = v || {};
  const cornerButton = j(v.cornerButton, "resizeAndRotate"), pinch = j(v.pinch, "resizeAndRotate");
  const knobs = {};
  for (const p of PDFE_HANDLE_POSITIONS) { const s = handleStyleOf(v.knobs && v.knobs[p]); if (s) knobs[p] = s; }
  return Object.freeze({
    corners: j(v.corners, "none"), edges: j(v.edges, "none"),
    cornerButton: cornerButton === "stretch" ? "resize" : cornerButton,
    pinch: ["none", "resize", "resizeAndRotate"].includes(pinch) ? pinch : "resizeAndRotate",
    cornerStyle: handleStyleOf(v.cornerStyle), edgeStyle: handleStyleOf(v.edgeStyle), knobs: Object.freeze(knobs),
  });
}
/**
 * WHICH KNOBS A SELECTED PICTURE OR SIGNATURE SHOWS AND WHAT EACH DOES — Android's
 * PdfeHandleConfig companion values. Pass one (or your own object of the same shape) to
 * `editor.imageHandles` / `editor.signatureHandles`. @since 3.15.0
 */
export const PdfeHandleConfig = Object.freeze({
  /** No knobs, the round ↘ button, the pinch — every item's look up to 3.10.x. */
  LEGACY: normalizeHandleConfig({}),
  /** A picture's default: eight knobs — corners resize, middles stretch — and no ↘ button. */
  IMAGE_DEFAULT: normalizeHandleConfig({ corners: "resize", edges: "stretch", cornerButton: "none" }),
  /** A signature's default: the ↘ button on its bottom corner. */
  SIGNATURE_DEFAULT: normalizeHandleConfig({}),
  /** A drawing's default (3.16.0): corners resize, middles stretch, no ↘ button, no pinch (two
   *  fingers zoom the page). A drawing never turns: a turn job resizes or hides. */
  DRAWING_DEFAULT: normalizeHandleConfig({ corners: "resize", edges: "stretch", cornerButton: "none", pinch: "none" }),
});

/**
 * pdf/HandlePolicy.kt, transcribed (W5) — the rules for resizing, stretching and turning a selected
 * picture or signature. Corners |c| are 8 SCREEN floats in the item's OWN order BL, BR, TR, TL
 * (screen y down); limits are screen px. Pure, so the web and Android agree by construction.
 */
const HandlePolicy = {
  // ---- which knob does what (W5c) — PdfeHandleConfig + the knob positions, as on Android ----
  /** A knob's place on the item's own box: u along its width (0 left .. 1 right), v along its
   *  height (0 bottom .. 1 top). */
  u: (p) => (/Left$|^left$/.test(p) ? 0 : p === "top" || p === "bottom" ? 0.5 : 1),
  v: (p) => (/^bottom/.test(p) ? 0 : p === "left" || p === "right" ? 0.5 : 1),
  isCorner: (p) => HandlePolicy.u(p) !== 0.5 && HandlePolicy.v(p) !== 0.5,
  /** The config the page obeys: the host's, with the two released switches applied —
   *  transformHandleEnabled false hides the ↘ button (and the pinch), and showCornerKnobs true
   *  means "corners resize" for a signature whose host never set signatureHandles. */
  effective(cfg, hostSet, signature, showCornerKnobs, transformHandleEnabled) {
    let c = normalizeHandleConfig(cfg);
    if (signature && !hostSet && showCornerKnobs && c.corners === "none") c = { ...c, corners: "resize" };
    if (!transformHandleEnabled) c = { ...c, cornerButton: "none", pinch: "none" };
    return c;
  },
  /** What knob |p| does: its own entry in knobs, else its group's job; |canTurn| false takes the turn out. */
  job(cfg, p, canTurn = true) {
    const own = cfg.knobs && cfg.knobs[p] && cfg.knobs[p].job;
    return HandlePolicy.withoutTurn(own || (HandlePolicy.isCorner(p) ? cfg.corners : cfg.edges), canTurn);
  },
  withoutTurn: (j, canTurn) => (canTurn ? j : j === "rotate" ? "none" : j === "resizeAndRotate" ? "resize" : j),
  /** Knob |p|'s look: its own entry, then its group's, field by field; null = the appearance's. */
  style(cfg, p) {
    const own = (cfg.knobs && cfg.knobs[p]) || {}, grp = (HandlePolicy.isCorner(p) ? cfg.cornerStyle : cfg.edgeStyle) || {};
    const o = {};
    for (const k of ["filled", "fillColor", "borderColor", "radiusDp", "strokeWidthDp", "icon"]) o[k] = own[k] ?? grp[k] ?? null;
    return o;
  },
  /** Is knob |p| drawn? Not with no job; a MIDDLE knob not when its side is under |minSide|. */
  shown(cfg, p, c, minSide, canTurn = true) {
    const H = HandlePolicy;
    if (H.job(cfg, p, canTurn) === "none") return false;
    if (H.isCorner(p)) return true;
    return (H.v(p) === 0.5 ? H.height(c) : H.width(c)) >= minSide;
  },
  width: (c) => Math.hypot(c[2] - c[0], c[3] - c[1]),
  height: (c) => Math.hypot(c[6] - c[0], c[7] - c[1]),
  point: (c, u, v) => [c[0] + u * (c[2] - c[0]) + v * (c[6] - c[0]), c[1] + u * (c[3] - c[1]) + v * (c[7] - c[1])],
  drag: (sx = 1, sy = 1, angle = 0, au = 0.5, av = 0.5) => ({ sx, sy, angle, au, av }),
  changed: (d) => Math.abs(d.sx - 1) > 0.002 || Math.abs(d.sy - 1) > 0.002 || Math.abs(d.angle) > 0.001,
  /** [drag] for a grab at (ku, kv) of the own box — the ↘ button is (1, 0). */
  dragFrom(c, ku, kv, job, gx, gy, x, y, lim) {
    const H = HandlePolicy, w = H.width(c), h = H.height(c);
    if (w <= 0 || h <= 0 || job === "none") return H.drag();
    if (job === "rotate" || job === "resizeAndRotate") {
      const ctr = H.point(c, 0.5, 0.5);
      const angle = Math.atan2(y - ctr[1], x - ctr[0]) - Math.atan2(gy - ctr[1], gx - ctr[0]);
      const want = job === "rotate" ? 1 : Math.hypot(x - ctr[0], y - ctr[1]) / Math.max(1, Math.hypot(gx - ctr[0], gy - ctr[1]));
      return H.pinch(c, want, angle, lim);
    }
    const au = 1 - ku, av = 1 - kv;
    const ex = (c[2] - c[0]) / w, ey = (c[3] - c[1]) / w, fx = (c[6] - c[0]) / h, fy = (c[7] - c[1]) / h;
    const k0x = (ku - au) * w, k0y = (kv - av) * h;
    const dx = (x - gx) * ex + (y - gy) * ey, dy = (x - gx) * fx + (y - gy) * fy;
    let sx = 1, sy = 1;
    if (job === "resize") { const s = ((k0x + dx) * k0x + (k0y + dy) * k0y) / (k0x * k0x + k0y * k0y); sx = s; sy = s; }
    else { if (k0x !== 0) sx = (k0x + dx) / k0x; if (k0y !== 0) sy = (k0y + dy) / k0y; }   // stretch
    return H.anchored(c, sx, sy, au, av, job === "resize", lim);
  },
  /** Own width x sx, own height x sy about the CENTRE, under the limits (resize/stretch from code). */
  scaled(c, sx, sy, lim) {
    const H = HandlePolicy;
    return H.width(c) <= 0 || H.height(c) <= 0 ? H.drag() : H.anchored(c, sx, sy, 0.5, 0.5, sx === sy, lim);
  },
  anchored(c, sx, sy, au, av, keepShape, lim) {
    const H = HandlePolicy, w = H.width(c), h = H.height(c);
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const minSx = Math.min(1, lim.minW / w), minSy = Math.min(1, lim.minH / h);
    const maxSx = Math.max(1, lim.maxSide / w), maxSy = Math.max(1, lim.maxSide / h);
    if (keepShape) { const s = clamp(sx, Math.min(minSx, minSy), Math.min(maxSx, maxSy)); sx = s; sy = s; }
    else { sx = clamp(sx, minSx, maxSx); sy = clamp(sy, minSy, maxSy); }
    if (!H.inside(H.corners(c, H.drag(1, 1, 0, au, av)), lim)) return H.drag(Math.min(sx, 1), Math.min(sy, 1), 0, au, av);
    if (!H.inside(H.corners(c, H.drag(sx, sy, 0, au, av)), lim)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) {
        const t = (lo + hi) / 2;
        if (H.inside(H.corners(c, H.drag(1 + t * (sx - 1), 1 + t * (sy - 1), 0, au, av)), lim)) lo = t; else hi = t;
      }
      sx = 1 + lo * (sx - 1); sy = 1 + lo * (sy - 1);
    }
    return H.drag(sx, sy, 0, au, av);
  },
  /** A pinch: |scale| and |angle| about the centre, under the same limits. */
  pinch(c, scale, angle, lim) {
    const H = HandlePolicy, w = H.width(c), h = H.height(c);
    const lo = Math.min(1, Math.min(lim.minW / w, lim.minH / h));
    const hi = Math.max(1, lim.maxSide / Math.max(1, Math.max(w, h)));
    const fit = !H.inside(c, lim) ? 1 : H.fitScale(c, angle, lim);
    const s = Math.min(Math.min(Math.max(scale, lo), hi), fit);
    return H.drag(s, s, angle);
  },
  /** The largest scale at which the item, turned by |angle| about its centre, stays on the page. */
  fitScale(c, angle, lim) {
    const ctr = HandlePolicy.point(c, 0.5, 0.5), ca = Math.cos(angle), sa = Math.sin(angle);
    let s = Infinity;
    for (let k = 0; k < 4; k++) {
      const dx = c[k * 2] - ctr[0], dy = c[k * 2 + 1] - ctr[1];
      const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
      if (rx > 1e-3) s = Math.min(s, (lim.pr - ctr[0]) / rx); else if (rx < -1e-3) s = Math.min(s, (lim.pl - ctr[0]) / rx);
      if (ry > 1e-3) s = Math.min(s, (lim.pb - ctr[1]) / ry); else if (ry < -1e-3) s = Math.min(s, (lim.pt - ctr[1]) / ry);
    }
    return Math.max(0.05, s);
  },
  inside(c, lim) {
    for (let k = 0; k < 4; k++) {
      const x = c[k * 2], y = c[k * 2 + 1];
      if (x < lim.pl - 0.5 || x > lim.pr + 0.5 || y < lim.pt - 0.5 || y > lim.pb + 0.5) return false;
    }
    return true;
  },
  /** The four corners after |d| — same order as |c|. */
  corners(c, d) {
    const a = HandlePolicy.point(c, d.au, d.av);
    const ex = c[2] - c[0], ey = c[3] - c[1], fx = c[6] - c[0], fy = c[7] - c[1];
    const ca = Math.cos(d.angle), sa = Math.sin(d.angle), us = [0, 1, 1, 0], vs = [0, 0, 1, 1];
    const o = [];
    for (let k = 0; k < 4; k++) {
      const px = (us[k] - d.au) * d.sx, py = (vs[k] - d.av) * d.sy;
      const lx = px * ex + py * fx, ly = px * ey + py * fy;
      o.push(a[0] + lx * ca - ly * sa, a[1] + lx * sa + ly * ca);
    }
    return o;
  },
  /** [a b c d e f] carrying the first three corners of |from| onto |to|, or null. */
  affine(from, to) {
    const x0 = from[0], y0 = from[1], ux = from[2] - x0, uy = from[3] - y0, vx = from[6] - x0, vy = from[7] - y0;
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) return null;
    const px = to[2] - to[0], py = to[3] - to[1], qx = to[6] - to[0], qy = to[7] - to[1];
    const a = (px * vy - qx * uy) / det, c = (qx * ux - px * vx) / det;
    const b = (py * vy - qy * uy) / det, d = (qy * ux - py * vx) / det;
    return [a, b, c, d, to[0] - (a * x0 + c * y0), to[1] - (b * x0 + d * y0)];
  },
};

// ======== THE SIGNATURE PAD (W4b) — the web twin of PdfeSignaturePadView + SignaturePadModel ========
// Names are Android's (12-VOCABULARY §21.4). Pad units are CSS px (the web's dp), y DOWN.

/** SignaturePadModel, transcribed: strokes of raw points, undo/redo/clear/erase, the Catmull-Rom
 *  smoothing that is BOTH drawn and placed, and the crop to the ink. Pure. */
class SignaturePadModel {
  constructor() { this.strokes = []; this.undoStack = []; this.redoStack = []; this.current = null; this.erasing = null; }
  get isEmpty() { return this.strokes.length === 0 && this.current === null; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  currentSmoothed() { return this.current ? SignaturePadModel.smoothed(this.current) : null; }
  begin(x, y) { this.current = [x, y]; }
  /** One more sample; a repeat of the last point is dropped (a zero-length piece). */
  add(x, y) {
    const c = this.current;
    if (!c) return;
    if (c.length >= 2 && c[c.length - 2] === x && c[c.length - 1] === y) return;
    c.push(x, y);
  }
  /** Finish the stroke: one undo step. A single point stays — it is a dot. */
  end() {
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.strokes.push(c);
    this.undoStack.push({ add: c });
    this.redoStack.length = 0;
  }
  cancel() { this.current = null; }
  undo() {
    const st = this.undoStack.pop();
    if (!st) return false;
    if (st.add) this.strokes.pop();
    else if (st.clear) this.strokes.push(...st.clear);
    else for (const [i, s] of [...st.erase].reverse()) this.strokes.splice(i, 0, s);
    this.redoStack.push(st);
    return true;
  }
  redo() {
    const st = this.redoStack.pop();
    if (!st) return false;
    if (st.add) this.strokes.push(st.add);
    else if (st.clear) this.strokes.length = 0;
    else for (const [i] of st.erase) this.strokes.splice(i, 1);
    this.undoStack.push(st);
    return true;
  }
  /** Remove every finished stroke whose drawn line passes within |r| of (x, y). */
  eraseAt(x, y, r) {
    let hit = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (SignaturePadModel.touches(SignaturePadModel.smoothed(this.strokes[i]), x, y, r)) {
        (this.erasing ||= []).push([i, this.strokes.splice(i, 1)[0]]);
        hit = true;
      }
    }
    return hit;
  }
  /** Finish an eraser gesture: what it removed is one undo step. */
  endErase() {
    const e = this.erasing;
    if (!e) return;
    this.erasing = null;
    this.undoStack.push({ erase: e });
    this.redoStack.length = 0;
  }
  /** Wipe the drawing — ONE undoable step. */
  clear() {
    this.current = null;
    if (!this.strokes.length) return false;
    this.undoStack.push({ clear: [...this.strokes] });
    this.redoStack.length = 0;
    this.strokes.length = 0;
    return true;
  }
  /** Every stroke smoothed, moved so the INK starts at (0, 0); frame = the ink's box + half the
   *  pen on every side. Null when nothing is drawn. */
  export(widthPx) {
    if (!this.strokes.length) return null;
    const lines = this.strokes.map(SignaturePadModel.smoothed);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of lines) for (let i = 0; i < l.length; i += 2) {
      x0 = Math.min(x0, l[i]); x1 = Math.max(x1, l[i]); y0 = Math.min(y0, l[i + 1]); y1 = Math.max(y1, l[i + 1]);
    }
    const pad = widthPx / 2, ox = x0 - pad, oy = y0 - pad;
    return { strokes: lines.map((l) => l.map((v, i) => (i % 2 === 0 ? v - ox : v - oy))),
             frameWidth: x1 - x0 + 2 * pad, frameHeight: y1 - y0 + 2 * pad };
  }
  /** A uniform Catmull-Rom curve through EVERY point, as a polyline (PIECE_PX 3, at most 12 pieces). */
  static smoothed(raw) {
    const n = raw.length >> 1;
    if (n < 3) return raw.slice();
    const px = (i) => raw[2 * Math.min(Math.max(i, 0), n - 1)], py = (i) => raw[2 * Math.min(Math.max(i, 0), n - 1) + 1];
    const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
                                             (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      out.push(px(i), py(i));
      const len = Math.hypot(px(i + 1) - px(i), py(i + 1) - py(i));
      const pieces = Math.min(12, Math.max(1, Math.ceil(len / 3)));
      for (let k = 1; k < pieces; k++) {
        const t = k / pieces;
        out.push(cr(px(i - 1), px(i), px(i + 1), px(i + 2), t), cr(py(i - 1), py(i), py(i + 1), py(i + 2), t));
      }
    }
    out.push(px(n - 1), py(n - 1));
    return out;
  }
  /** Does the polyline |s| come within |r| of (x, y)? */
  static touches(s, x, y, r) {
    if (s.length === 2) return Math.hypot(s[0] - x, s[1] - y) <= r;
    for (let i = 0; i + 3 < s.length; i += 2) {
      const ax = s[i], ay = s[i + 1], dx = s[i + 2] - ax, dy = s[i + 3] - ay, len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
      if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r) return true;
    }
    return false;
  }
}

/**
 * THE SDK'S SIGNATURE PAD on the web — `new PdfeSignaturePadView(element)` fills |element| with a
 * drawing surface; `toSignature()` gives what `editor.setSignatureTool()` places, cropped to the
 * ink, exactly as drawn. Android's PdfeSignaturePadView, same names. @since 3.15.0
 */
export class PdfeSignaturePadView {
  /** @param {HTMLElement} container  @param {{fontsUrl?: string}} [opts] where `showTyped` finds a
   *  handwriting face (default: the SDK's own `fonts/`, next to this file). */
  constructor(container, opts = {}) {
    this._model = new SignaturePadModel();
    this._ink = 0xFF000000; this._width = 3; this._bg = 0xFFFFFFFF; this._guide = true;
    /** While true, a finger or the mouse removes every whole line it touches (one undo step per gesture). */
    this.eraser = false;
    /** `{onPadChanged(isEmpty, canUndo, canRedo)}` — told after every change. */
    this.listener = null;
    this._typed = null; this._typedFont = PdfeSignatureFonts.DEFAULT;
    const doc = container.ownerDocument;
    // A relative fontsUrl is read against the page, as the editor's own option is.
    this._fontsUrl = opts.fontsUrl ? new URL(opts.fontsUrl, doc.baseURI).href : new URL("./fonts/", import.meta.url).href;
    this._faces = new Map();
    this._canvas = doc.createElement("canvas");
    Object.assign(this._canvas.style, { width: "100%", height: "100%", display: "block", touchAction: "none" });
    container.appendChild(this._canvas);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._canvas);
    this._wire();
    this._resize();
  }
  /** The ink colour of the WHOLE signature (0xAARRGGBB or any colour applyTextColor takes). */
  get inkColor() { return this._ink; }
  set inkColor(c) { const v = parseArgb(c); if (v !== null) { this._ink = v; this._draw(); } }
  /** The pen width of the WHOLE signature, in CSS px (one width along every line; min 0.5). */
  get strokeWidthDp() { return this._width; }
  set strokeWidthDp(w) { const v = Number(w); if (Number.isFinite(v)) { this._width = Math.max(0.5, v); this._draw(); } }   // Android: coerceAtLeast(0.5)
  /** The pad's background. Never part of the signature. */
  get padBackgroundColor() { return this._bg; }
  set padBackgroundColor(c) { const v = parseArgb(c); if (v !== null) { this._bg = v; this._draw(); } }
  /** A thin "sign here" line near the bottom. Never part of the signature. */
  get guideLineVisible() { return this._guide; }
  set guideLineVisible(v) { this._guide = !!v; this._draw(); }
  get isEmpty() { return this._model.isEmpty; }
  get canUndo() { return this._model.canUndo; }
  get canRedo() { return this._model.canRedo; }
  undo() { if (this._model.undo()) this._changed(); }
  redo() { if (this._model.redo()) this._changed(); }
  /** Wipe the drawing — one undo step. */
  clear() { if (this._model.clear()) this._changed(); }
  /** What to place: `{type: "drawn", strokes, frameWidth, frameHeight}` in inkColor and
   *  strokeWidthDp, cropped to the ink; null when nothing is drawn. */
  toSignature() {
    const w = this._width, e = this._model.export(w);
    if (!e) return null;
    return { type: "drawn", strokes: e.strokes.map((points) => ({ points, width: w, color: this._ink })),
             frameWidth: e.frameWidth, frameHeight: e.frameHeight };
  }
  /** The drawing cropped to its ink on a transparent ImageData — a PREVIEW only (for your "saved
   *  signatures" list); what is placed is toSignature()'s lines. Null when empty. */
  previewBitmap() {
    const w = this._width, e = this._model.export(w);
    if (!e) return null;
    const c = this._canvas.ownerDocument.createElement("canvas");
    c.width = Math.max(1, Math.ceil(e.frameWidth)); c.height = Math.max(1, Math.ceil(e.frameHeight));
    const g = c.getContext("2d");
    for (const s of e.strokes) this._line(g, s);
    return g.getImageData(0, 0, c.width, c.height);
  }
  /** Show |text| as a typed signature in |fontName| — the letters the typed signature places,
   *  spaced the same way (advance only, no kerning). Drawing is off while a name shows and the
   *  drawing is kept; null goes back to drawing. A face that cannot load shows nothing. */
  showTyped(text, fontName = PdfeSignatureFonts.DEFAULT) {
    this._typed = text ? String(text) : null;
    this._typedFont = fontName;
    this._draw();
    if (this._typed) this._face(fontName).then(() => this._draw());
  }
  /** Stop listening and remove the surface. */
  destroy() { this._ro.disconnect(); this._off?.(); this._canvas.remove(); }

  _changed() {
    this._draw();
    try { this.listener?.onPadChanged?.(this.isEmpty, this.canUndo, this.canRedo); }
    catch (e) { console.error("[pdfe] pad listener threw", e); }
  }
  _resize() {
    const r = this._canvas.getBoundingClientRect(), dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this._canvas.width !== w || this._canvas.height !== h) { this._canvas.width = w; this._canvas.height = h; }
    this._draw();
  }
  /** One stroke as the engine draws it: straight pieces, round caps and joins; a dot is a disc. */
  _line(g, s) {
    g.strokeStyle = g.fillStyle = argbCss(this._ink);
    g.lineWidth = this._width; g.lineCap = "round"; g.lineJoin = "round";
    if (s.length === 2) { g.beginPath(); g.arc(s[0], s[1], this._width / 2, 0, 2 * Math.PI); g.fill(); return; }
    g.beginPath(); g.moveTo(s[0], s[1]);
    for (let i = 2; i < s.length; i += 2) g.lineTo(s[i], s[i + 1]);
    g.stroke();
  }
  _draw() {
    const c = this._canvas;
    if (!c) return;
    const g = c.getContext("2d"), dpr = c.width / Math.max(1, c.getBoundingClientRect().width || c.width);
    const W = c.width / dpr, H = c.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = argbCss(this._bg);
    g.clearRect(0, 0, W, H); g.fillRect(0, 0, W, H);
    if (this._guide) {
      g.strokeStyle = "rgba(0,0,0,0.25)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(16, H * 0.75); g.lineTo(W - 16, H * 0.75); g.stroke();
    }
    if (this._typed) { this._drawTyped(g, W, H); return; }
    for (const s of this._model.strokes) this._line(g, SignaturePadModel.smoothed(s));
    const cur = this._model.currentSmoothed();
    if (cur) this._line(g, cur);
  }
  _drawTyped(g, W, H) {
    const fam = this._faces.get(this._typedFont);
    if (!fam || fam === "failed" || typeof fam.then === "function") return;
    const pad = 12, bw = W - 2 * pad, bh = H - 2 * pad;
    if (bw <= 0 || bh <= 0) return;
    g.font = `100px "${fam}"`;
    const letters = [...this._typed];
    let adv = 0;
    for (const l of letters) adv += g.measureText(l).width;
    const m = g.measureText("Hg"), asc = m.fontBoundingBoxAscent ?? 80, desc = m.fontBoundingBoxDescent ?? 20, th = asc + desc;
    if (adv <= 0 || th <= 0) return;
    const k = Math.min(bw / adv, bh / th);
    g.font = `${100 * k}px "${fam}"`;
    g.fillStyle = argbCss(this._ink);
    let x = pad + (bw - adv * k) / 2;
    const base = pad + (bh - th * k) / 2 + asc * k;
    for (const l of letters) { g.fillText(l, x, base); x += g.measureText(l).width; }
  }
  /** Load a face from the SDK's fonts once (FontFace), keyed by its name. */
  _face(name) {
    const have = this._faces.get(name);
    if (have) return Promise.resolve(have);
    const fam = "pdfe-pad-" + name;
    const p = new FontFace(fam, `url(${new URL(name + ".ttf", this._fontsUrl).href})`).load()
      .then((f) => { this._canvas.ownerDocument.fonts.add(f); this._faces.set(name, fam); return fam; })
      .catch(() => { this._faces.set(name, "failed"); return "failed"; });
    this._faces.set(name, p);
    return p;
  }
  _wire() {
    const c = this._canvas;
    let id = null;
    const at = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const down = (e) => {
      if (this._typed || id !== null || e.button > 0) return;
      id = e.pointerId;
      try { c.setPointerCapture(id); } catch (_) { /* synthetic */ }
      e.preventDefault();
      const [x, y] = at(e);
      if (this.eraser) { if (this._model.eraseAt(x, y, 10 + this._width / 2)) this._draw(); }
      else { this._model.begin(x, y); this._draw(); }
    };
    const move = (e) => {
      if (e.pointerId !== id) return;
      // A fast mouse or finger batches samples: every one is a point the user drew.
      for (const s of e.getCoalescedEvents?.() || [e]) {
        const [x, y] = at(s);
        if (this.eraser) this._model.eraseAt(x, y, 10 + this._width / 2);
        else this._model.add(x, y);
      }
      this._draw();
    };
    const up = (e, cancel) => {
      if (e.pointerId !== id) return;
      id = null;
      if (this.eraser) { this._model.endErase(); this._changed(); return; }
      if (cancel) { this._model.cancel(); this._changed(); return; }
      const [x, y] = at(e);
      this._model.add(x, y); this._model.end(); this._changed();
    };
    const onUp = (e) => up(e, false), onCancel = (e) => up(e, true);
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onCancel);
    this._off = () => {
      c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", onUp); c.removeEventListener("pointercancel", onCancel);
    };
  }
}
/** The pad's pure drawing model, for tests. */
PdfeSignaturePadView._Model = SignaturePadModel;

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
    // W6, THE READER (Android's PdfeEditorView reader switches). zoomConfig takes minZoom /
    // maxZoom over: the two fields above stay readable and follow it.
    this._zoomConfig = normalizeZoomConfig(opts.zoomConfig, { minZoom: this.minZoom, maxZoom: this.maxZoom });
    this.minZoom = this._zoomConfig.minZoom;
    this.maxZoom = this._zoomConfig.maxZoom;
    this._linksEnabled = opts.linksEnabled ?? true;
    this._pageLinks = new Map();        // page -> [{rect, kind, page, uri}]
    this._linksAsked = new Set();
    this._nightMode = !!opts.nightMode;
    this._scrollEnabled = opts.scrollEnabled ?? true;
    this._pageSpacingDp = Number.isFinite(opts.pageSpacingDp) ? Math.min(64, Math.max(0, opts.pageSpacingDp)) : 8;
    // W6b: which way the pages run, page snapping, and every page as wide as the view (Android's
    // defaults: vertical, off, on). The web has no scrollConfig: the BROWSER owns a throw's coast.
    this._scrollDirection = opts.scrollDirection === "horizontal" ? "horizontal" : "vertical";
    this._pageSnap = !!opts.pageSnap;
    this._uniformPageWidth = opts.uniformPageWidth ?? true;
    this._fitScales = [];
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
    // WHERE THE ROTATE CONTROL LIVES — the host's choice (user decision 2026-09-15):
    // "bar" (the default since 3.1.0 — the labelled button only; 3.0.0 defaulted to
    // "both"), "both", "handle" (on the picture), or
    // "none". The same four words on web, Android and the iOS bridge, deliberately,
    // so a product configures one behaviour rather than three. rotateSelection()
    // works at every setting including "none", so a host can own the chrome entirely.
    this._imageRotateControl = PDFE_ROTATE_CONTROLS.includes(opts.imageRotateControl)
      ? opts.imageRotateControl : "none";   // Android's default since 3.11.0 (the bar has Left · Right)
    // DOES A PICTURE'S BAR OFFER DELETE (3.1.0): on unless the host passes false.
    this._imageDeleteControl = opts.imageDeleteControl !== false;
    // The client's own design (3.3.0): the look, the buttons per kind, the bar switch,
    // and the app's own bar element. See setAppearance / setActions.
    this._appearance = {};
    this._actionsByKind = new Map();
    this._actionBarEnabled = true;
    this._actionBarElement = null;
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
    this._pageMatrices = new Map(); // page -> the engine's display map, only for pages that need one (I99)
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
    // THE MODE IS THE ONE STORED VALUE, and `editMode` is derived from it
    // (docs/annotations/12-VOCABULARY.md). There is deliberately no `_editMode`
    // field: `editMode === (mode === "text")` must hold in BOTH directions forever,
    // and two fields that must agree is the bug, not the fix -- the shape that left
    // undo dead on Android for a whole release (I79).
    //
    // The initial value is asserted against Android's PdfeMode.VIEW by
    // check_platform_parity.mjs rule 13: a default that drifts on ONE platform is
    // the asymmetry nobody notices.
    this._mode = "view";
    // discardModeChanges (W2 = Android step 14b, pdf/ModeDiscard.kt). Each journal's distance
    // to its mode-entry mark, as last read; zeroed when a mark is set (a mark just set IS zero
    // steps away), and a read posted before a newer mark is dropped (_markGen). canDiscard is
    // computed from these, never from a worker hop.
    this._markSteps = { text: 0, markup: 0 };
    this._markGen = 0;
    this._discardJob = null;     // {journal, docGen, resolve, reject} — non-null IS "busy"
    this._deferredMode = null;   // a setMode asked for while a discard ran — last wins
    this._docGen = 0;            // bumped by every open: a discard that outlives its document says so
    this._runTyped = false;      // a keystroke went into the open box (Android's editDirty)
    // ANNOTATE MODE (annotations step 19). The tool, its colours and the switches are
    // SHELL state, read without touching the worker (12-VOCABULARY §4bis); the defaults
    // are Android's (pdf/MarkupToolState.kt, pdf/PageSelectionPolicy.kt) — rule 15 of
    // the parity gate compares them.
    this._markupTool = null;
    // SIGNATURES (W4): the pick, the selected stamp, the per-page stamp lists, two switches.
    this._signatureTool = null;
    this._sigPickId = 0;
    this._selectedStamp = null;         // {page, stamp}
    this._pageStamps = new Map();
    this._otherAppStampsEditable = true;          // PageSelectionPolicy.DEFAULT_OTHER_APP_STAMPS_EDITABLE (D34)
    this._signatureToolSelectsExisting = true;    // PageSelectionPolicy.DEFAULT_SIGNATURE_TOOL_SELECTS_EXISTING (I136)
    // DRAWING (DR3, vocabulary §25): shell state, read without a worker hop (§4bis).
    this._drawingTool = null;                     // "pen" | "eraser" | null
    this._drawingColor = PDFE_DRAWING.color;
    this._drawingWidthDp = PDFE_DRAWING.widthDp;
    this._eraserWidthDp = PDFE_DRAWING.eraserWidthDp;
    this._eraserCutsStrokes = opts.eraserCutsStrokes ?? true;
    this._drawingStylusOnly = opts.drawingStylusOnly ?? false;
    this._otherAppInkEditable = opts.otherAppInkEditable ?? true;     // D37
    this._pageInks = new Map();
    this._selectedInk = null;                     // {page, ink}
    this._drawStroke = null;                      // the stroke in flight (isDrawing)
    this._drawLive = [];                          // live stroke canvases waiting for the engine's paint
    // THE KNOBS (W5c): one config per kind, Android's defaults. |_signatureHandlesSet|: the host
    // set the signature one itself, so the older showCornerKnobs switch no longer speaks for it.
    this._imageHandles = PdfeHandleConfig.IMAGE_DEFAULT;
    this._signatureHandles = PdfeHandleConfig.SIGNATURE_DEFAULT;
    this._signatureHandlesSet = false;
    this._drawingHandles = PdfeHandleConfig.DRAWING_DEFAULT;
    this._itemGesture = null;           // the knob / ↘ / pinch / move in flight
    this._gestureKind = null;           // isSelectionGestureActive's kind, until the result landed
    this._live = null;                  // the dragged item's own pixels (the live drag)
    this._markupColors = { ...PDFE_MARKUP_DEFAULT_COLORS };
    this._markupAuthor = PDFE_MARKUP_DEFAULT_AUTHOR;
    this._markupLineRatio = PDFE_MARKUP_LINE.ratioDefault;
    this._markupLineMinWidth = PDFE_MARKUP_LINE.minDefault;
    this._annotateTextSelectionEnabled = opts.annotateTextSelectionEnabled ?? true;
    this._markupOnSelectionEnd = opts.markupOnSelectionEnd ?? true;
    this._markupOnToolPick = opts.markupOnToolPick ?? true;
    this._annotateDragSelectEnabled = opts.annotateDragSelectEnabled ?? true;
    // TEXT CHECK (3.16.0): off by default — nothing is worked out until checkText() is called.
    this._textCheckOnOpen = opts.textCheckOnOpen ?? false;
    this._textCheck = null;
    this._textCheckWaiters = null;   // [{resolve, reject}] while a check runs
    this._textCheckGen = 0;
    this._pageKindSeq = 0;
    this._pageKindWaiters = new Map();
    // PageSelectionPolicy.DEFAULT_NEW_SELECTION_DESELECTS_ANNOTATION (I167)
    this._newSelectionDeselectsAnnotation = opts.newSelectionDeselectsAnnotation ?? true;
    // PageSelectionPolicy.DEFAULT_TAP_KEEPS_ANNOTATION_SELECTED
    this._tapKeepsAnnotationSelected = opts.tapKeepsAnnotationSelected ?? true;
    this._pageSel = null;          // the worker's page selection as last painted
    this._reportedPageSel = null;  // what the host was last told (pagetextselection)
    this._pageMarks = new Map();   // page -> marks, for the tap hit-test and outlines
    this._selectedMark = null;     // { page, mark }
    this._annotSelecting = false;  // a finger is selecting: the page must not pan
    // VIEW-MODE SELECTION + THE SDK'S WORDS MENU (step 19 W3; Android step 14c / 3.14.0) —
    // the same switches, defaults (PageSelectionPolicy) and names as PdfeEditorView.
    this._viewTextSelectionEnabled = opts.viewTextSelectionEnabled ?? false;
    this._viewSelectionMenuEnabled = opts.viewSelectionMenuEnabled ?? false;
    this._annotateSelectionMenuEnabled = opts.annotateSelectionMenuEnabled ?? false;
    this._selectionMenuItems = [...PDFE_SELECTION_MENU_ITEMS];
    this._selectionMenuLayout = 0;
    this._viewSelectionMenuLayout = null;
    this._annotateSelectionMenuLayout = null;
    this._viewSelectionMenuActions = null;
    this._annotateSelectionMenuActions = null;
    this._menuKey = null;
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
  get mode() { return this._mode; }
  /** `true` exactly while the mode is `"text"`. Derived -- see `_mode`. */
  get editMode() { return this._mode === "text"; }
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
    // THROUGH THE FUNNEL, never `this._dirty = false` (I127, 2026-10-01): a host paints
    // its Save button from the `dirty` event, and a direct assignment said nothing — so
    // the worker's forced post-open `history` found the flag already false and stayed
    // silent too, leaving "unsaved" lit over a fresh document. Here and not at "opened":
    // the worker closes the old document before it tries the new one, so a FAILED open
    // has also replaced it. Android's openPdf does the same in both outcomes.
    this._dirtyUntracked = false;
    this._setDirty(false);
    this._painted = new Set();
    this._selected = null;
    this._selectedImage = null;
    this._history = { canUndo: false, canRedo: false, undoPage: -1, redoPage: -1,
                      recording: false };
    this._closeEditUiState();
    // DISCARD STATE BELONGS TO THE OLD DOCUMENT (W2). A discard already on the worker
    // finishes against the old document and reports itself stale (_docGen).
    this._docGen++;
    this._deferredMode = null;
    this._markSteps = { text: 0, markup: 0 };
    this._markGen++;
    const p = this._promiseFor("open");
    this._post({ type: "open", blob, tier: opts.tier || 0, blockKB: opts.blockKB || 0,
                 password: opts.password || "" });
    // `opts.mode` (W2): open straight into a mode — Android's openPdfInAnnotateMode /
    // openPdfInEditMode, as one option. Applied once the document is open, so `opened`
    // comes first and then `mode`, as on Android.
    if (!PDFE_MODES.includes(opts.mode)) return p;
    const info = await p;
    this.setMode(opts.mode);
    return info;
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
   * exportFlattened (3.2.0): a COPY of the document with its annotations burned into the
   * pages, as PDF bytes — for printing, or anywhere the marks must show whatever draws the
   * PDF. Optional; nothing changes for a host that never calls it.
   *
   * The OPEN document is unchanged: marks stay marks, undo/redo and `dirty` are untouched,
   * it is not a save. It includes unsaved work and leaves the open box first (as save()
   * does). Hidden / do-not-print annotations are left out. A password document gives an
   * UNPROTECTED copy. All or nothing.
   *
   * Rejects with PdfeError: 'no-document', 'flatten-failed' (a page would not flatten; no
   * copy), 'engine-error' (the engine failed writing it), 'save-too-large' (the copy is made
   * in memory and the document is over the in-heap ceiling), or 'superseded' (a newer call
   * replaced this one). Emits no event.
   */
  async exportFlattened() {
    // Same order as save(): leave the box synchronously, inside the host's gesture.
    this.getOutOfBoxEditing();
    await this._readyPromise;
    if (!this._pages.length) throw new PdfeError("no-document", "nothing open to export");
    const limitMB = this._caps.inHeapMaxMB;
    const sizeMB = this._docBytes / (1024 * 1024);
    if (limitMB && sizeMB > limitMB) {
      throw new PdfeError("save-too-large",
        "the copy is made in memory and the document is over the in-heap ceiling",
        { sizeMB, limitMB });
    }
    const p = this._promiseFor("exportFlattened");
    this._post({ type: "exportFlattened" });
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
    // Guard on the DERIVED value, so that setEditMode(false) while the mode is
    // "annotate" is a no-op rather than a mode change: edit mode is already off,
    // and a legacy toggle must not silently drag a host out of a mode it chose.
    if (this.editMode === on) return;
    this.setMode(on ? "text" : "view");
  }
  toggleEditMode() { this.setEditMode(!this.editMode); }

  /**
   * SET THE MODE: `"view"` | `"text"` | `"annotate"`
   * (docs/annotations/12-VOCABULARY.md). This is the ONE funnel -- `setEditMode` and
   * `toggleEditMode` both come through here, so the mode and `editMode` cannot
   * disagree.
   *
   * `"annotate"` is DECLARED AND INERT. Setting it is legal, `mode` reads it back,
   * and it behaves in every other respect exactly like `"view"` -- no tool, no marks,
   * no gesture. The behaviour lands at roadmap step 13; the value is here now so the
   * vocabulary ships once and a host's switch is written once.
   *
   * An unrecognised value is IGNORED rather than thrown, the same way
   * `setImageRotateControl` ignores one: nothing crosses this SDK's boundary as an
   * exception.
   */
  setMode(next) {
    if (!PDFE_MODES.includes(next) || this._destroyed) return;
    // A DISCARD IS RUNNING (W2): the editor is already in view and the rewind is on the
    // worker. Entering a mode now would set a NEW mark ahead of work the rewind has not
    // finished, so the switch waits for it — last request wins (Android's deferredMode).
    if (this._discardJob && !this._discardSwitching) { this._deferredMode = next; return; }
    const previous = this._mode;
    if (previous === next) return;
    const wasText = previous === "text", isText = next === "text";
    this._mode = next;
    if (isText) this.clearSearch();   // 3.3.0: typing changes the words under the results
    // THE TEXT-EDITING SEAM. Only a change in text-ness does any work -- every other
    // transition (view <-> annotate) is state plus events, which is exactly why this
    // step is a no-op. Step 13 hangs annotate's own enter/leave off this branch.
    if (isText) {
      this._sweepVisible();
    } else if (wasText) {
      // Leaving text mode is leaving box editing, keyboard included.
      this.getOutOfBoxEditing();
      this._post({ type: "deselect" });
      this._selected = null;
      this._selectedImage = null;
      this._pageGroups.clear();
      this._pageImages.clear();
      this._groupsPending.clear();
      this._renderBoxes();
    }
    // `editmode` FIRST, unchanged in payload and in timing, so a host that has never
    // heard of modes observes exactly the sequence it observed before. `mode` is the
    // additive one.
    //
    // KNOWN, PRE-EXISTING HAZARD, not introduced here: a listener that re-enters
    // setMode during this emit completes the inner transition first, so the outer
    // frame then emits a payload naming a mode that is no longer current. `editmode`
    // has behaved this way since it was written (measured). Suppressing it would be a
    // behaviour change, and this step must have none -- recorded for step 13.
    // ANNOTATE'S OWN ENTER/LEAVE (step 19) — a conditioned branch on the annotate-ness
    // changing; the text seam above is untouched.
    // A READER selection survives entering annotate (12-VOCABULARY §18), so "select, then
    // Highlight" works from view mode; every other change of page-selection mode drops it.
    // Any reader selection, settled or taken over (Android's setModeInternal carries it too).
    const carry = previous === "view" && next === "annotate" && !!this._pageSel;
    if (carry) this._annotateCarry();
    else if ((previous === "annotate") !== (next === "annotate")) this._annotateTransition(next === "annotate");
    else if (this._pageSel) this._clearPageSel();
    if (isText !== wasText) this._emit("editmode", { editMode: isText });
    // THE MODE-ENTRY MARK (W2 = Android step 14b). Entering a mode marks "here" in the
    // journal it drives — on the worker, so FIFO with every edit the user then makes. A mark
    // just set is zero steps away, so canDiscard reads false ("grey until a change").
    // Leaving KEEPING posts no clear: the next entry replaces the mark.
    this._markModeEntry();
    this._emit("mode", { mode: next, previous, canDiscard: this.canDiscard });
    // The one Undo button now points at another journal (12-VOCABULARY §7): say so.
    this._emitHistory();
  }

  /** The journal the mode's undo button drives, which a discard rewinds (pdf/ModeDiscard.kt). */
  _journalOf(mode) { return mode === "text" ? "text" : mode === "annotate" ? "markup" : "none"; }

  /** Mark "here" in the current mode's journal (W2), or stop pinning pages in view mode. */
  _markModeEntry() {
    const journal = this._journalOf(this._mode);
    if (journal === "none") { this._post({ type: "releaseMarkPins" }); return; }
    (this._markSteps ||= { text: 0, markup: 0 })[journal] = 0;
    this._markGen = (this._markGen | 0) + 1;
    this._post({ type: "setHistoryMark", journal, gen: this._markGen });
  }

  /**
   * WOULD discardModeChanges() DO ANYTHING? True only when something changed since the
   * current mode was entered — so false the moment a mode is entered, and false again once
   * everything done in the mode was undone. Also false in view mode, while a discard runs,
   * while a save or an export is still writing, and in text mode with undo recording off
   * (nothing was written down to rewind). Re-read it on `history` and `mode` (which carries
   * it). Pure shell state. Android's twin is `canDiscard` (pdf/ModeDiscard.kt). @since 3.15.0
   */
  get canDiscard() {
    if (this._discardJob || this._pending?.has("save") || this._pending?.has("exportFlattened")) return false;
    const steps = this._markSteps || { text: 0, markup: 0 };
    if (this._mode === "text")
      return !!this._history?.recording && (steps.text !== 0 ||
                                            (this._editingPage >= 0 && this._runTyped));
    if (this._mode === "annotate") return steps.markup !== 0;
    return false;
  }

  /**
   * LEAVE THE CURRENT MODE, REVERTING EVERYTHING DONE IN IT, and return to view mode
   * (12-VOCABULARY §3; Android's discardModeChanges). Everything since the mode was entered
   * goes — typing, styling, moved or deleted boxes and pictures in text mode; created and
   * deleted marks in annotate mode — including a word still being typed in an open box. Work
   * from before the mode was entered is untouched; after a save inside the mode, "entered"
   * means "saved".
   *
   * It NEVER reloads the document: it rewinds the history in place — same page, zoom and
   * scroll; it scrolls to nothing and selects nothing. It cannot be undone (it lands in view
   * mode, and the reverted steps cannot be redone): ask the user first. Past about 200
   * changes in one mode the history no longer reaches the entry point; the discard then
   * reverts what the history still holds.
   *
   * Resolves once the page is reverted. Rejects with PdfeError 'discard-unavailable' when
   * `canDiscard` is false (nothing changes), 'history-unavailable' when the engine refused a
   * step part-way (it stops there, never skipping ahead), or 'no-document' when another
   * document was opened meanwhile; each rejection is also emitted as `error`. `mode` (to
   * view) fires at the start; a setMode() asked for before it resolves is applied after.
   * @since 3.15.0
   */
  discardModeChanges() {
    if (!this.canDiscard) {
      const detail = this._discardJob ? "A discard is already running"
        : this._mode === "view" ? "View mode has nothing to discard"
        : "Nothing has changed since this mode was entered";
      return Promise.reject(this._discardError("discard-unavailable", detail));
    }
    return new Promise((resolve, reject) => {
      this._discardJob = { journal: this._journalOf(this._mode), docGen: this._docGen, resolve, reject };
      // The open box is CANCELLED, never committed — its keystrokes are journal steps already
      // (the worker drains the latch first), and a commit can write identity marks the rewind
      // would keep. UI only here; the worker cancels the session inside the rewind.
      this._closeEditUiState();
      this._setSinkFocus(false);
      // Posted BEFORE the mode change, so on the FIFO worker it runs ahead of everything the
      // change queues (the commit a leave-text posts finds no session and does nothing).
      this._post({ type: "discard", journal: this._discardJob.journal });
      this._discardSwitching = true;
      try { this.setMode("view"); } finally { this._discardSwitching = false; }
    });
  }

  _discardError(code, detail) {
    const err = new PdfeError(code, detail);
    this._emit("error", { code, detail });
    return err;
  }

  /** The worker's answer to a discard: adopt what changed — once per page, quietly — and report. */
  _onDiscarded(msg) {
    const job = this._discardJob;
    if (!job) return;
    this._discardJob = null;
    if (job.docGen !== this._docGen) {
      job.reject(this._discardError("no-document", "A different document was opened during the discard"));
      return;
    }
    for (const p of msg.pages || []) {
      if (msg.journal === "text") {
        this._pageGroups.set(p.page, p.blocks);
        if (p.images) this._pageImages.set(p.page, p.images);
        this._groupsPending.delete(p.page);
      } else {
        this._pageMarks?.set(p.page, p.marks || []);
        if (p.inks) this._pageInks.set(p.page, p.inks);
      }
    }
    // NO scroll and no re-selection: "a discard does not go sightseeing" (12-VOCABULARY §4).
    this._renderBoxes();
    this._renderAnnotate?.();
    // A partial discard (the history no longer reached the entry point) or one that stopped
    // part-way leaves changes the stacks cannot account for: they stop proving "unmodified".
    const complete = msg.done === msg.wanted;
    if (msg.kind === 2 || !complete) this._dirtyUntracked = true;
    const next = this._deferredMode;
    this._deferredMode = null;
    if (next) this.setMode(next);
    if (complete) job.resolve();
    else job.reject(this._discardError("history-unavailable",
      `The discard stopped after ${msg.done} of ${msg.wanted} steps — the engine could not apply the next one`));
  }

  // ======== ANNOTATE MODE (annotations step 19 — the web twin of Android steps 12–14) ========
  // Names and payloads are 12-VOCABULARY.md's; behaviour is PdfeEditorView's. The selection
  // rules run in the WORKER over the core's text model; this half arms, paints and reports.

  /** The ARMED markup tool — "highlight" | "underline" | "squiggle" | "strikeout" — or null.
   *  Pure shell state. @since 3.15.0 */
  get markupTool() { return this._markupTool; }
  /** The armed tool's colour, 0xAARRGGBB, or 0 when nothing is armed. @since 3.15.0 */
  get markupColor() { return this._markupTool ? this._markupColors[this._markupTool] : 0; }
  /** Every tool's colour, `{highlight, underline, squiggle, strikeout}` (0xAARRGGBB). A copy. @since 3.15.0 */
  get markupColors() { return { ...this._markupColors }; }
  /** The author written into every NEW mark. Never blank: "PDFe" until setMarkupAuthor. @since 3.15.0 */
  get markupAuthor() { return this._markupAuthor; }
  /** Line thickness of a new underline/squiggle/strikeout, as a fraction of the text height. @since 3.15.0 */
  get markupLineRatio() { return this._markupLineRatio; }
  /** The thinnest such line, in PDF points. @since 3.15.0 */
  get markupLineMinWidth() { return this._markupLineMinWidth; }

  /** In annotate mode with no tool armed, may a long-press select text? Default true. @since 3.15.0 */
  get annotateTextSelectionEnabled() { return this._annotateTextSelectionEnabled; }
  set annotateTextSelectionEnabled(v) { this._annotateTextSelectionEnabled = !!v; this._syncAnnotatePolicy(); }
  /** With a tool armed, does a finished selection become a mark at once? Default true. @since 3.15.0 */
  get markupOnSelectionEnd() { return this._markupOnSelectionEnd; }
  set markupOnSelectionEnd(v) { this._markupOnSelectionEnd = !!v; this._syncAnnotatePolicy(); this._reportPageSel(); }
  /** Does arming a tool mark text that is already selected? Default true. @since 3.15.0 */
  get markupOnToolPick() { return this._markupOnToolPick; }
  set markupOnToolPick(v) { this._markupOnToolPick = !!v; }
  /** With a tool armed, does ONE finger drag over text to mark it (two fingers scroll)?
   *  Default true. A mouse always drags to select in annotate mode. @since 3.15.0 */
  get annotateDragSelectEnabled() { return this._annotateDragSelectEnabled; }
  set annotateDragSelectEnabled(v) { this._annotateDragSelectEnabled = !!v; this._syncAnnotatePolicy(); }
  /** In annotate mode, does a long-press (or a one-finger drag with a tool armed) on OTHER text
   *  unselect the selected mark / signature / drawing first, then select as usual? A press ON it
   *  starts nothing. Default true. false = while one is selected nothing starts. @since 3.16.0 */
  get newSelectionDeselectsAnnotation() { return this._newSelectionDeselectsAnnotation; }
  set newSelectionDeselectsAnnotation(v) { this._newSelectionDeselectsAnnotation = !!v; }
  /** In annotate mode, does a tap on the mark / signature / drawing that is ALREADY selected keep
   *  it selected? Default true. false = that tap unselects it. @since 3.16.0 */
  get tapKeepsAnnotationSelected() { return this._tapKeepsAnnotationSelected; }
  set tapKeepsAnnotationSelected(v) { this._tapKeepsAnnotationSelected = !!v; }
  /** true while one finger marks instead of scrolling (a tool armed + annotateDragSelectEnabled). @since 3.15.0 */
  get oneFingerScrollFrozen() { return this._dragSelects() || this._draws("touch"); }
  /** In annotate mode, does a long-press only REPORT (no tool armed and text selection
   *  off)? The "pick a tool first" check as one reader. @since 3.15.0 */
  get needsMarkupTool() { return this._mode === "annotate" && !this._canSelectPageText(); }

  /**
   * ARM a markup tool, or disarm with null. While armed in annotate mode, each selection
   * the finger (or mouse) finishes becomes a mark of that kind in that tool's colour.
   * With no tool armed and finished text selected, arming also marks it (markupOnToolPick).
   * Always reports `markuptool` — the disarm too. @since 3.15.0
   */
  setMarkupTool(tool) {
    if (tool !== null && !PDFE_MARKUP_TOOLS.includes(tool)) return;
    const markNow = this._mode === "annotate" && !this._markupTool && tool !== null &&
      this._markupOnToolPick && !!this._pageSel && this._pageSel.settled;
    this._markupTool = tool;
    this._emit("markuptool", { tool, color: this.markupColor });
    if (tool !== null && this._signatureTool) this._publishSignatureTool(null);   // one tool at a time
    if (tool !== null && this._drawingTool) this._publishDrawingTool(null);
    this._syncAnnotatePolicy();
    if (markNow) this._markSelection(tool, this._markupColors[tool]);
  }
  /** Set the ARMED tool's colour (each tool keeps its own). Ignored with no tool armed.
   *  Accepts what applyTextColor accepts. Reports `markupcolor`. @since 3.15.0 */
  setMarkupColor(color) {
    const t = this._markupTool;
    if (!t) return;
    const argb = parseArgb(color);
    if (argb === null) return;
    this._markupColors[t] = argb;
    this._emit("markupcolor", { tool: t, color: argb });
    this._renderAnnotate();
  }
  /** Name the author of the marks this user makes. null/blank resets to "PDFe"; longer
   *  than 256 UTF-16 units is cut (never inside a character). @since 3.15.0 */
  setMarkupAuthor(name) {
    if (name == null || !String(name).trim()) { this._markupAuthor = PDFE_MARKUP_DEFAULT_AUTHOR; return; }
    const s = String(name);
    let end = Math.min(s.length, PDFE_MARKUP_MAX_AUTHOR_UTF16);
    if (end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
    this._markupAuthor = s.slice(0, end);
  }
  /** width = max(minWidth, ratio × text height) for every NEW underline/squiggle/strikeout.
   *  Non-numbers and <= 0 reset to the default; else clamped to 0.01–0.5 and 0.1–20. @since 3.15.0 */
  setMarkupLineRatio(ratio, minWidth = PDFE_MARKUP_LINE.minDefault) {
    const L = PDFE_MARKUP_LINE;
    const pick = (v, d, lo, hi) => (!Number.isFinite(v) || v <= 0 ? d : Math.min(hi, Math.max(lo, v)));
    this._markupLineRatio = pick(Number(ratio), L.ratioDefault, L.ratioMin, L.ratioMax);
    this._markupLineMinWidth = pick(Number(minWidth), L.minDefault, L.minMin, L.minMax);
  }
  /** Mark the current page selection ONCE with |tool| (its colour by default), arm nothing.
   *  Annotate mode only; nothing selected fails with `markup-no-text`. |select| true SELECTS
   *  the new mark once written (a `select` event, kind "markup", after `markupcreated`). @since 3.15.0 */
  markupSelection(tool, color, select = false) {
    if (!PDFE_MARKUP_TOOLS.includes(tool)) return;
    const argb = color == null ? this._markupColors[tool] : parseArgb(color);
    if (argb === null) return;
    this._markSelection(tool, argb, select === true);
  }
  /** Recolour the SELECTED mark (one undo step). Ignored with no mark selected. @since 3.15.0 */
  setSelectedMarkupColor(color) {
    const sel = this._selectedMark;
    if (!sel) return;
    const argb = parseArgb(color);
    if (argb === null) return;
    if (!sel.mark.nm) {
      this._emit("error", errorEvent("markup-not-found", "This mark has no name in the file, so it cannot be recoloured"));
      return;
    }
    this._post({ type: "markupRecolor", page: sel.page, nm: sel.mark.nm, color: argb });
  }
  /** The text selected on a page in annotate mode, or null: {page, start, end, text, bounds}. @since 3.15.0 */
  get pageTextSelection() {
    const s = this._pageSel;
    return s ? { page: s.page, start: s.start, end: s.end, text: s.text,
                 bounds: s.bounds ? [...s.bounds] : null } : null;
  }
  // ---- SIGNATURES (W4 — Android's §21 names; PdfeEditorView.setSignatureTool) -----------

  /**
   * PICK WHAT THE NEXT TAP IN ANNOTATE MODE PLACES, or turn it off with null. One of:
   *   {type: "drawn",   strokes: [{points: [x, y, …], width, color}], frameWidth, frameHeight}
   *   {type: "typed",   text, fontName?, color?}     — drawn as outlines, not copyable
   *   {type: "picture", image}                       — ImageData, a canvas, an ImageBitmap or a loaded <img>
   *   {type: "text",    text, fontName?, color?}     — real, copyable text (a name, a date)
   * Points are in the pad's units, y DOWN, inside frameWidth × frameHeight; colours as
   * applyTextColor takes them. A picture is copied now. Nothing usable (no strokes, blank text,
   * an empty picture) → `error` `signature-empty`, and the previous pick stays. Picking turns a
   * markup tool off (one tool at a time). The tool STAYS ON after a placement. Reports
   * `signaturetool`, turning off too. @since 3.15.0
   */
  setSignatureTool(signature) {
    if (signature == null) { this._publishSignatureTool(null); return; }
    const sig = this._readSignature(signature);
    if (!sig) {
      this._emit("error", errorEvent("signature-empty", "Nothing to place: no strokes, no text or an empty picture"));
      return;
    }
    if (sig.type === "picture") {
      const px = sig.image.data.slice();
      this._post({ type: "signaturePick", pictureId: sig.pictureId, width: sig.image.width,
                   height: sig.image.height, pixels: px }, [px.buffer]);
    } else if (sig.fontName) {
      this._post({ type: "signaturePick", fontName: sig.fontName });   // stage a handwriting face early
    }
    if (this._markupTool) this.setMarkupTool(null);   // one tool at a time; reports markuptool
    if (this._drawingTool) this._publishDrawingTool(null);
    this._publishSignatureTool(sig);
  }
  /** The picked signature as validated, or null. A picture reads {type, width, height} with the
   *  copied ImageData on a NON-enumerable `image` (so JSON never carries pixels). @since 3.15.0 */
  get signatureTool() { return this._signatureTool ? this._signatureTool.given : null; }
  /** The selected signature, name, date or other app's stamp, or null: {page, id, kind, bounds}. @since 3.15.0 */
  get selectedSignature() {
    const s = this._selectedStamp;
    return s ? { page: s.page, id: s.stamp.nm || "", kind: s.stamp.kindName, bounds: [...s.stamp.rect] } : null;
  }
  /** Other apps' stamp annotations can be selected, dragged and deleted in annotate. Default true (D34). @since 3.15.0 */
  get otherAppStampsEditable() { return this._otherAppStampsEditable; }
  set otherAppStampsEditable(v) {
    this._otherAppStampsEditable = !!v;
    if (!v && this._selectedStamp && this._selectedStamp.stamp.kind === 2) this._setSelectedStamp(null);
  }
  /** With a signature picked, a tap on an existing signature/stamp SELECTS it instead of placing
   *  another. Default true (I136). @since 3.15.0 */
  get signatureToolSelectsExisting() { return this._signatureToolSelectsExisting; }
  set signatureToolSelectsExisting(v) { this._signatureToolSelectsExisting = !!v; }

  // ---- DRAWING (DR3 — vocabulary §25; the core's pdfe_ink_*, 19-DRAWING.md) ----------------

  /**
   * PICK UP THE PEN OR THE ERASER, or put it down with null. In annotate mode one finger (or the
   * mouse, or a stylus) then draws a stroke — or rubs strokes out — and two fingers still pinch.
   * Each stroke is ONE drawing (one undo step); the eraser cuts through strokes (eraserCutsStrokes).
   * Picking a tool puts a markup or signature tool down (each reports). Always reports
   * `drawingtool`. @since 3.16.0
   */
  setDrawingTool(tool) {
    if (tool !== null && !PDFE_DRAWING_TOOLS.includes(tool)) return;
    if (tool !== null && this._markupTool) this.setMarkupTool(null);
    if (tool !== null && this._signatureTool) this._publishSignatureTool(null);
    this._publishDrawingTool(tool);
  }
  /** "pen", "eraser" or null. @since 3.16.0 */
  get drawingTool() { return this._drawingTool; }
  /** The pen's colour, 0xAARRGGBB — a see-through alpha draws a see-through stroke. Accepts what
   *  applyTextColor accepts; reports `drawingtool`. Default black. @since 3.16.0 */
  setDrawingColor(color) {
    const argb = parseArgb(color);
    if (argb === null) return;
    this._drawingColor = argb;
    this._emitDrawingTool();
  }
  /** The pen colour, 0xAARRGGBB. @since 3.16.0 */
  get drawingColor() { return this._drawingColor; }
  /** The pen's width in CSS px at the zoom it is drawn (1–34, default 7); reports `drawingtool`. @since 3.16.0 */
  setDrawingWidth(widthDp) {
    const v = Number(widthDp);
    if (!Number.isFinite(v)) return;
    this._drawingWidthDp = Math.min(PDFE_DRAWING.widthMaxDp, Math.max(PDFE_DRAWING.widthMinDp, v));
    this._emitDrawingTool();
  }
  /** The pen width, CSS px. @since 3.16.0 */
  get drawingWidthDp() { return this._drawingWidthDp; }
  /** The eraser's width in CSS px (5–60, default 10); reports `drawingtool`. @since 3.16.0 */
  get eraserWidthDp() { return this._eraserWidthDp; }
  set eraserWidthDp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this._eraserWidthDp = Math.min(PDFE_DRAWING.eraserMaxDp, Math.max(PDFE_DRAWING.eraserMinDp, n));
    this._emitDrawingTool();
  }
  /** true (default): the eraser removes only the part it rubs; false: every stroke it touches, whole. @since 3.16.0 */
  get eraserCutsStrokes() { return this._eraserCutsStrokes; }
  set eraserCutsStrokes(v) { this._eraserCutsStrokes = !!v; }
  /** true: only a stylus draws and a finger scrolls (palm rejection); the mouse always draws.
   *  Default false. @since 3.16.0 */
  get drawingStylusOnly() { return this._drawingStylusOnly; }
  set drawingStylusOnly(v) { this._drawingStylusOnly = !!v; this._syncTouchAction(); }
  /** Other apps' drawings can be selected, moved, restyled, deleted and erased. Default true (D37). @since 3.16.0 */
  get otherAppInkEditable() { return this._otherAppInkEditable; }
  set otherAppInkEditable(v) {
    this._otherAppInkEditable = !!v;
    if (!v && this._selectedInk && this._selectedInk.ink.foreign) this._setSelectedInk(null);
  }
  /** true while a finger (mouse, stylus) is drawing or erasing a stroke. @since 3.16.0 */
  get isDrawing() { return !!this._drawStroke; }
  /** The selected drawing, or null: {page, id, bounds, color, widthPt, ownedBySdk}. @since 3.16.0 */
  get selectedDrawing() {
    const s = this._selectedInk;
    return s ? this._inkPayload(s.page, s.ink) : null;
  }
  /** Restyle the SELECTED drawing: {color?, widthPt?} (one undo step). Ignored with none. @since 3.16.0 */
  setSelectedDrawingStyle(style = {}) {
    const sel = this._selectedInk;
    if (!sel || !style) return;
    let what = 0, color = 0, widthPt = 0;
    if (style.color != null) { const c = parseArgb(style.color); if (c === null) return; color = c; what |= 1; }
    if (style.widthPt != null) { const w = Number(style.widthPt); if (!(w > 0)) return; widthPt = w; what |= 2; }
    if (!what) return;
    this._post({ type: "inkStyle", page: sel.page, nm: sel.ink.nm, what, color, widthPt });
  }

  _inkPayload(page, k) {
    return { page, id: k.nm || null, bounds: [...k.rect], color: k.colorKnown ? k.color : null,
             widthPt: k.widthPt, ownedBySdk: !k.foreign };
  }
  /** The funnel every tool change goes through: one event, always (rule 14). */
  _publishDrawingTool(tool) {
    this._drawingTool = tool;
    this._emitDrawingTool();
    this._syncTouchAction();
  }
  _emitDrawingTool() {
    this._emit("drawingtool", { tool: this._drawingTool, color: this._drawingColor,
                                widthDp: this._drawingWidthDp, eraserWidthDp: this._eraserWidthDp });
  }
  /** Does one pointer of |type| draw here? (annotate, a tool in hand, a stylus when stylusOnly). */
  _draws(type) {
    if (this._mode !== "annotate" || !this._drawingTool) return false;
    return !this._drawingStylusOnly || type === "pen" || type === "mouse";
  }
  _setSelectedInk(sel) {
    const had = !!this._selectedInk;
    if (sel && this._selectedMark) this._selectedMark = null;   // at most one selection
    if (sel && this._selectedStamp) this._selectedStamp = null;
    this._selectedInk = sel;
    this._renderBoxes();
    if (sel) {
      this._emit("select", { selection: { kind: "drawing", page: sel.page, id: sel.ink.nm || null,
                                          bounds: [...sel.ink.rect] } });
    } else if (had && !this._selectedMark && !this._selectedStamp && !this._selected && !this._selectedImage) {
      this._emit("select", { selection: null });
    }
  }
  _deleteSelectedInk() {
    const sel = this._selectedInk;
    this._setSelectedInk(null);
    this._post({ type: "inkDelete", page: sel.page, nm: sel.ink.nm });
  }
  /** The selected drawing's outline and its bar (Delete by default). */
  _renderSelectedInk(scaleCss) {
    const sel = this._selectedInk;
    if (!sel || this._draggingBox) return;
    const rect = this._pageRect(sel.page);
    if (!rect || !this._pageCanvases[sel.page]) return;
    const div = this._doc.createElement("div");
    div.className = "pdfe-parabox pdfe-selected";
    const v = this._viewBox(sel.page, sel.ink.rect);
    div.style.left = `${rect.left + v.left * scaleCss}px`;
    div.style.top = `${rect.top + v.top * scaleCss}px`;
    div.style.width = `${v.width * scaleCss}px`;
    div.style.height = `${v.height * scaleCss}px`;
    this.boxesEl.appendChild(div);
    if (this._fillActions("drawing")) this._placeActions(sel.page, sel.ink.rect, scaleCss);
  }
  _inkAt(page, xPt, yPt) {
    return inkHit(this._pageInks.get(page) || [], xPt, yPt, PDFE_PAGE_PRESS_REACH_PX / 2 / this._k(page),
                  this._otherAppInkEditable);
  }

  /** ONE STROKE of the pen or the eraser, from the press to the lift (the reference's Doodle:
   *  a stroke that never moved makes no dot; a second finger ends it unsaved). The finger's path
   *  is drawn live over the page and handed to the core in page points on the lift. */
  _drawStrokeGesture(ev, canvas, page, toPt) {
    const tool = this._drawingTool, k = this._k(page);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    const rect = this._pageRect(page);
    const live = this._doc.createElement("canvas");
    const dpr = this._dpr || 1;
    live.className = "pdfe-drawlive";
    Object.assign(live.style, { position: "absolute", pointerEvents: "none", zIndex: "3",
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    live.width = Math.round(rect.width * dpr); live.height = Math.round(rect.height * dpr);
    this.strip.appendChild(live);
    const g = live.getContext("2d");
    g.scale(dpr, dpr);
    g.lineCap = "round"; g.lineJoin = "round";
    const pen = tool === "pen", c = this._drawingColor >>> 0;
    g.strokeStyle = pen ? `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${((c >>> 24) & 255) / 255})`
                        : PDFE_DRAWING.eraserTrail;
    g.lineWidth = pen ? this._drawingWidthDp : this._eraserWidthDp;
    const cr = canvas.getBoundingClientRect();
    const pts = [], sx = ev.clientX, sy = ev.clientY;
    let lx = sx - cr.left, ly = sy - cr.top, moved = false;
    // Kept ON the page: a point past an edge lands on that edge (off the page it would be saved and
    // never seen).
    const box = this._pageUserBox(page) || [-1e9, -1e9, 1e9, 1e9];
    const add = (cx, cy) => {
      const q = toPt(cx, cy);
      pts.push(Math.min(box[2], Math.max(box[0], q.xPt)), Math.min(box[3], Math.max(box[1], q.yPt)));
    };
    add(sx, sy);
    this._drawStroke = { page, tool, cancel: () => finish(false) };
    this._emit("drawingstroke", { phase: "start", page, tool });
    const finish = (commit) => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      this._drawStroke = null;
      const keep = commit && (moved || !pen);   // a pen tap is no dot; an eraser tap rubs a spot
      this._emit("drawingstroke", { phase: "end", page, tool, saved: keep });
      if (!keep) { live.remove(); return; }
      this._drawLive.push(live);
      if (pen) {
        this._post({ type: "inkCreate", page, points: pts, widthPt: this._drawingWidthDp / k, color: c,
                     minDistPt: PDFE_DRAWING.minDistPx / k, pieceLenPt: PDFE_DRAWING.piecePx / k,
                     author: this._markupAuthor });
      } else {
        this._post({ type: "inkErase", page, points: pts, radiusPt: this._eraserWidthDp / 2 / k,
                     whole: !this._eraserCutsStrokes, foreign: this._otherAppInkEditable });
      }
    };
    const move = (mv) => {
      if (this._pinchActive) { finish(false); return; }
      const evs = mv.getCoalescedEvents ? mv.getCoalescedEvents() : [];
      for (const e of evs.length ? evs : [mv]) {
        const x = e.clientX - cr.left, y = e.clientY - cr.top;
        if (Math.hypot(x - lx, y - ly) < PDFE_DRAWING.minDistPx) continue;
        moved = true;
        g.beginPath(); g.moveTo(lx, ly); g.lineTo(x, y); g.stroke();
        lx = x; ly = y;
        add(e.clientX, e.clientY);
      }
    };
    const up = (uv) => { add(uv.clientX, uv.clientY); finish(true); };
    const cancel = () => finish(false);
    if (!pen) { g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx, ly); g.stroke(); }
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
  }
  /** The engine painted the stroke: drop the live copy a moment later (a timer, not a frame —
   *  a hidden tab runs no frames, W5c). */
  _dropDrawLive() {
    const done = this._drawLive.shift();
    if (done) setTimeout(() => done.remove(), 60);
  }
  /** A selected drawing dragged to a new place: an outline follows, ONE transform on the lift. */
  _dragInkGesture(ev, canvas, page, toPt, down) {
    const sel = this._selectedInk;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    let dragging = false;
    const end = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
    };
    const move = (mv) => {
      const c = toPt(mv.clientX, mv.clientY);
      if (!dragging) {
        if (Math.hypot(mv.clientX - ev.clientX, mv.clientY - ev.clientY) <= 8) return;
        dragging = true;
        this._draggingBox = true;
        this.actionsEl.style.display = "none";
        this._beginSelectionGesture("drawing");
        this._renderBoxes();
      }
      this._showMoveGhost(page, sel.ink.rect, c.xPt - down.xPt, c.yPt - down.yPt);
    };
    const up = (uv) => {
      end();
      if (!dragging) {     // a tap on the selected drawing: what a tap there means
        const q = toPt(uv.clientX, uv.clientY);
        this._annotateTap(page, q.xPt, q.yPt);
        return;
      }
      const c = toPt(uv.clientX, uv.clientY);
      const [dx, dy] = this._ghostDelta || [c.xPt - down.xPt, c.yPt - down.yPt];
      this._draggingBox = false;
      this._hideMoveGhost();
      this._endSelectionGesture();
      if (dx || dy) this._post({ type: "inkTransform", page, nm: sel.ink.nm, m: [1, 0, 0, 1, dx, dy], scaleWidth: false, change: "moved" });
      else this._renderBoxes();
    };
    const cancel = () => { end(); if (dragging) { this._draggingBox = false; this._hideMoveGhost(); this._endSelectionGesture(); this._renderBoxes(); } };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
  }

  /** The funnel every pick goes through: one event, always (rule 14). */
  _publishSignatureTool(sig) {
    this._signatureTool = sig;
    this._emit("signaturetool", { signature: sig ? sig.given : null });
  }

  /** Validate and copy a signature (PdfeEditorView.pickSignature). Null when nothing is usable. */
  _readSignature(s) {
    const color = (c) => (c == null ? 0xff000000 : parseArgb(c) ?? 0xff000000);
    switch (s && s.type) {
      case "drawn": {
        const fw = Number(s.frameWidth), fh = Number(s.frameHeight);
        const strokes = (s.strokes || []).filter((k) => k && k.points && k.points.length >= 2)
          .map((k) => ({ points: Array.from(k.points, Number), width: Number(k.width) || 1, color: color(k.color) }));
        if (!(fw > 0 && fh > 0) || !strokes.length) return null;
        const given = { type: "drawn", strokes: strokes.map((k) => ({ ...k, points: [...k.points] })), frameWidth: fw, frameHeight: fh };
        return { type: "drawn", strokes, frameWidth: fw, frameHeight: fh, aspect: fw / fh, given };
      }
      case "typed": case "text": {
        const text = String(s.text ?? "");
        if (!text.trim()) return null;
        const fontName = s.fontName ? String(s.fontName) : (s.type === "typed" ? PdfeSignatureFonts.DEFAULT : null);
        const c = color(s.color);
        return { type: s.type, text, fontName, color: c, given: { type: s.type, text, fontName, color: c } };
      }
      case "picture": {
        const image = this._imageDataOf(s.image);
        if (!image || !image.width || !image.height) return null;
        // `image` is NOT enumerable: a host reads it, but JSON (the native bridge's `state`)
        // carries only the size — never the pixels.
        const given = { type: "picture", width: image.width, height: image.height };
        Object.defineProperty(given, "image", { value: image, enumerable: false });
        return { type: "picture", image, pictureId: ++this._sigPickId, aspect: image.width / image.height, given };
      }
    }
    return null;
  }
  /** ImageData from what a page holds (copied, so a later change to the source changes nothing). */
  _imageDataOf(src) {
    try {
      if (typeof ImageData !== "undefined" && src instanceof ImageData)
        return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
      const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
      if (!w || !h) return null;
      const c = this._doc.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    } catch (e) { return null; }
  }

  /** A tap placed the picked signature at (xPt, yPt) — PdfeEditorView.placeSignature. */
  _placeSignature(page, xPt, yPt) {
    const sig = this._signatureTool;
    const pg = this._pages[page];
    if (!sig || !pg) return;
    const pw = pg.w, ph = pg.h;   // the page as SHOWN (display points)
    const [w, h] = sig.type === "text" ? textSize(sig.text.length, pw)
      : signatureSize(sig.type === "typed" ? typedAspect(sig.text.length) : sig.aspect, pw, ph);
    // SignaturePlacement.centred in display points, then back to unrotated user space.
    const [cx, cy] = this._ptToView(page, xPt, yPt);
    const ww = Math.min(w, pw), hh = Math.min(h, ph);
    const l = Math.min(Math.max(cx - ww / 2, 0), pw - ww), t = Math.min(Math.max(cy - hh / 2, 0), ph - hh);
    const a = this._viewToPt(page, l, t), b = this._viewToPt(page, l + ww, t + hh);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const kind = sig.type === "text" ? 1 : 0;   // PDFE_STAMP_DATE : PDFE_STAMP_SIGNATURE
    this._emit("signatureplacing", { page });
    const signature = sig.type === "picture" ? { type: "picture", pictureId: sig.pictureId }
      : sig.type === "drawn" ? { type: "drawn", strokes: sig.strokes, frameWidth: sig.frameWidth, frameHeight: sig.frameHeight }
      : { type: sig.type, text: sig.text, fontName: sig.fontName, color: sig.color };
    this._post({ type: "signaturePlace", page, kind, rect, author: this._markupAuthor, signature });
  }

  _setSelectedStamp(sel) {
    const had = !!this._selectedStamp;
    if (sel && this._selectedMark) this._selectedMark = null;
    if (sel && this._selectedInk) this._selectedInk = null;
    this._selectedStamp = sel;
    this._renderBoxes();
    if (sel) {
      this._emit("select", { selection: { kind: sel.stamp.kindName, page: sel.page, id: sel.stamp.nm || null,
                                          bounds: [...sel.stamp.rect] } });
    } else if (had && !this._selectedMark && !this._selectedInk && !this._selected && !this._selectedImage) {
      this._emit("select", { selection: null });
    }
  }

  _deleteSelectedStamp() {
    const sel = this._selectedStamp;
    if (!sel.stamp.nm) {
      this._emit("error", errorEvent("signature-not-found", "This item has no name in the file, so it cannot be deleted"));
      this._emit("deleted", { page: sel.page, ok: false, kind: sel.stamp.kindName });
      return;
    }
    this._setSelectedStamp(null);
    this._post({ type: "stampDelete", page: sel.page, nm: sel.stamp.nm, kind: sel.stamp.kindName });
  }

  /** The selected stamp's outline and its bar (Delete by default). */
  _renderSelectedStamp(scaleCss) {
    const sel = this._selectedStamp;
    if (!sel) return;
    const rect = this._pageRect(sel.page);
    if (!rect || !this._pageCanvases[sel.page]) return;
    if (this._live) return;   // dragged (W5c): the live copy carries the outline
    const turned = !!sel.stamp.turn && sel.stamp.kind !== 2 && Math.abs(sel.stamp.turn[0]) > 1e-4;
    const c = turned && this._itemCorners({ kind: "stamp", page: sel.page, item: sel.stamp });
    if (c) {   // a turned signature: its own outline, not its bounding rect (itemCorners)
      const cr = this._pageCanvases[sel.page].getBoundingClientRect();
      const svg = this._doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "pdfe-imagebox pdfe-imagebox-selected pdfe-stampbox");
      svg.style.left = `${rect.left}px`; svg.style.top = `${rect.top}px`;
      svg.style.width = `${rect.width}px`; svg.style.height = `${rect.height}px`;
      svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
      const poly = this._doc.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", [0, 1, 2, 3].map((i) => `${c[2 * i] - cr.left},${c[2 * i + 1] - cr.top}`).join(" "));
      svg.appendChild(poly);
      this.boxesEl.appendChild(svg);
    } else {
      const div = this._doc.createElement("div");
      div.className = "pdfe-parabox pdfe-selected";
      const v = this._viewBox(sel.page, sel.stamp.rect);
      div.style.left = `${rect.left + v.left * scaleCss}px`;
      div.style.top = `${rect.top + v.top * scaleCss}px`;
      div.style.width = `${v.width * scaleCss}px`;
      div.style.height = `${v.height * scaleCss}px`;
      this.boxesEl.appendChild(div);
    }
    if (!this._draggingBox && this._fillActions(sel.stamp.kindName))
      this._placeActions(sel.page, sel.stamp.rect, scaleCss);
  }

  /** A user box [l, b, r, t] of |page| on screen: [left, top, right, bottom] client px, or null. */
  _clientBox(page, b) {
    const c = this._pageCanvases[page];
    if (!c) return null;
    const k = this._k(page), cr = c.getBoundingClientRect(), v = this._viewBox(page, b);
    return [cr.left + v.left * k, cr.top + v.top * k, cr.left + (v.left + v.width) * k, cr.top + (v.top + v.height) * k];
  }
  /** The whole page in its own (unrotated) user space, [l, b, r, t]. */
  _pageUserBox(page) {
    const pg = this._pages[page];
    if (!pg) return null;
    const a = this._viewToPt(page, 0, 0), b = this._viewToPt(page, pg.w, pg.h);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  /** A signature dropped after a drag (PdfPageView.dropStampAcrossPages): the page its box
   *  overlaps most wins, and the box is put fully inside that page. */
  _dropStampAcrossPages(ss, dx, dy) {
    const page = ss.page, r = ss.stamp.rect;
    const moved = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
    const g = this._clientBox(page, moved);
    const cands = new Map();
    this._pageCanvases.forEach((c, p) => {
      const box = c && this._pageUserBox(p);
      const cb = box && this._clientBox(p, box);
      if (cb && cb[2] > 0 && cb[0] < innerWidth && cb[3] > 0 && cb[1] < innerHeight) cands.set(p, cb);
    });
    let target = g ? stampDropTarget(g, cands) : -1;
    if (target < 0) target = page;
    const box = this._pageUserBox(target);
    let dest = moved;
    if (target !== page) {   // the ghost's screen corners, read in the target page's own space
      const cr = this._pageCanvases[target].getBoundingClientRect(), k = this._k(target);
      const a = this._viewToPt(target, (g[0] - cr.left) / k, (g[1] - cr.top) / k);
      const b = this._viewToPt(target, (g[2] - cr.left) / k, (g[3] - cr.top) / k);
      dest = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }
    const fitted = stampFitInside(dest, box);
    if (target === page) this._post({ type: "stampSetRect", page, nm: ss.stamp.nm, rect: fitted });
    else this._post({ type: "stampMoveToPage", from: page, to: target, nm: ss.stamp.nm, rect: fitted });
  }

  /** The stamp under a page point, by the pure core rule over the cached list, or null. */
  _stampAt(page, xPt, yPt) {
    const list = this._pageStamps.get(page) || [];
    const i = stampHit(list, xPt, yPt, this._otherAppStampsEditable);
    return i >= 0 ? list[i] : null;
  }

  /** The mark the user tapped (selectionKind "markup"), or null:
   *  {page, id, tool, color, colorKnown, bounds, quads}. @since 3.15.0 */
  get selectedMarkup() {
    const s = this._selectedMark;
    return s ? this._markupPayload(s.page, s.mark) : null;
  }

  _markupPayload(page, mark) {
    return { page, id: mark.nm || null, tool: mark.tool, color: mark.color ?? 0,
             colorKnown: mark.color != null, bounds: [...mark.rect], quads: [...mark.quads] };
  }
  _canSelectPageText() {
    if (this._mode === "view") return this._viewTextSelectionEnabled;
    return this._mode === "annotate" && (!!this._markupTool || this._annotateTextSelectionEnabled);
  }
  /** PageSelectionPolicy.reports: is a settled selection told to the host? */
  _pageSelReports() {
    if (this._mode === "view") return true;
    return this._mode === "annotate" && (!this._markupTool || !this._markupOnSelectionEnd);
  }
  /** PageSelectionPolicy.showsMenu */
  _showsMenu() {
    if (!this._canSelectPageText() || !this._pageSelReports()) return false;
    if (this._mode === "view") return this._viewSelectionMenuEnabled;
    return this._annotateSelectionMenuEnabled && !this._markupTool;
  }
  _dragSelects() {
    return this._mode === "annotate" && !!this._markupTool && this._annotateDragSelectEnabled;
  }
  /** Re-apply what the switches decide: the preview tint, and a selection that may no
   *  longer exist (PdfeEditorView.pushPageSelectionState). */
  _syncAnnotatePolicy() {
    if (this._pageSel && !this._canSelectPageText()) this._clearPageSel();
    this._syncTouchAction();
    this._renderAnnotate();
  }
  /** One finger marks while a tool is armed (§23): the canvases stop the browser's pan. */
  _syncTouchAction() {
    const freeze = this._dragSelects() || this._draws("touch");   // DR3: one finger draws
    for (const c of this._pageCanvases || []) if (c) c.style.touchAction = freeze ? "none" : "";
  }

  _annotateTransition(entering) {
    this._post({ type: "annotateReset" });
    this._pageSel = null;
    this._reportPageSel();
    if (this._selectedMark) this._setSelectedMark(null);
    if (this._selectedStamp) this._setSelectedStamp(null);
    if (this._selectedInk) this._setSelectedInk(null);
    this._pageMarks.clear();
    this._pageStamps?.clear();
    this._pageInks?.clear();
    if (entering) for (const p of this._painted) this._post({ type: "marks", page: p });
    this._syncTouchAction();
    this._renderAnnotate();
  }

  /** View -> annotate with a settled selection: keep it (and the worker's snapshot). */
  _annotateCarry() {
    for (const p of this._painted) this._post({ type: "marks", page: p });
    this._syncTouchAction();
    this._reportPageSel();
    this._renderAnnotate();
  }

  _clearPageSel() {
    this._pageSel = null;
    this._post({ type: "pageSelClear" });
    this._reportPageSel();
    this._renderAnnotate();
  }

  /** `pagetextselection`: told when a selection SETTLES and when it goes — never per move,
   *  and not while an armed tool turns it into a mark (PageSelectionPolicy.reports). */
  _reportPageSel() {
    const s = this._pageSel;
    const sel = s && s.settled && this._pageSelReports() ? s : null;
    if (!sel) {
      if (!this._reportedPageSel) return;
      this._reportedPageSel = null;
      this._emit("pagetextselection", { selection: null });
      return;
    }
    const key = `${sel.page}:${sel.start}:${sel.end}`;
    if (this._reportedPageSel === key) return;
    this._reportedPageSel = key;
    this._emit("pagetextselection", { selection: this.pageTextSelection });
  }

  _markSelection(tool, argb, select = false) {
    const s = this._pageSel;
    if (this._mode !== "annotate" || !s || !s.quads || !s.quads.length) {
      this._emit("error", errorEvent("markup-no-text", "Select some text first"));
      return;
    }
    this._pageSel = null;
    this._reportPageSel();
    this._renderAnnotate();
    this._post({ type: "markupSelection", kind: PDFE_MARKUP_TOOLS.indexOf(tool), color: argb,
                 author: this._markupAuthor, lineRatio: this._markupLineRatio,
                 lineMinWidth: this._markupLineMinWidth, select });
  }

  _setSelectedMark(sel) {
    const had = !!this._selectedMark;
    if (sel && this._selectedStamp) this._selectedStamp = null;   // at most one selection
    if (sel && this._selectedInk) this._selectedInk = null;
    this._selectedMark = sel;
    this._renderBoxes();
    if (sel) {
      const p = this._markupPayload(sel.page, sel.mark);
      this._emit("select", { selection: { kind: "markup", page: sel.page, id: p.id,
                                          markupKind: p.tool, color: p.color, bounds: p.bounds } });
    } else if (had && !this._selectedInk && !this._selected && !this._selectedImage) {
      this._emit("select", { selection: null });
    }
  }

  _deleteSelectedMark() {
    const sel = this._selectedMark;
    if (!sel.mark.nm) {
      this._emit("error", errorEvent("markup-not-found", "This mark has no name in the file, so it cannot be deleted"));
      this._emit("deleted", { page: sel.page, ok: false, kind: "markup" });
      return;
    }
    this._setSelectedMark(null);
    this._post({ type: "markupDelete", page: sel.page, nm: sel.mark.nm, kind: sel.mark.tool });
  }

  /** A tap in annotate mode: a mark selects it, anything else clears (the
   *  `android-annotate-tap` chain, minus the signature rungs that land later). */
  /** Is the point on the selected mark, signature or drawing? */
  _pressOnSelectedAnnotation(page, pt) {
    const sm = this._selectedMark, ss = this._selectedStamp, si = this._selectedInk;
    return (!!sm && sm.page === page && topmostMark([sm.mark], pt.xPt, pt.yPt) >= 0) ||
           (!!ss && ss.page === page && this._inBounds(ss.stamp.rect, pt)) ||
           (!!si && si.page === page && this._inBounds(si.ink.rect, pt));
  }
  /** I167: a long-press or drag-select deselects first (the empty tap's path). */
  _dropAnnotationSelection() {
    if (this._selectedMark) this._setSelectedMark(null);
    if (this._selectedStamp) this._setSelectedStamp(null);
    if (this._selectedInk) this._setSelectedInk(null);
  }

  _annotateTap(page, xPt, yPt) {
    // [tap-precedence: BEGIN web-annotate-tap]
    const marks = this._pageMarks.get(page) || [];
    const st = this._stampAt(page, xPt, yPt);
    // [tap-rung: signature-place]
    // With a signature picked a tap places it — unless it lands on an existing item and
    // signatureToolSelectsExisting (PageSelectionPolicy.placesPickedSignature).
    if (this._signatureTool && !(this._signatureToolSelectsExisting && st)) {
      if (this._pageSel) this._clearPageSel();
      this._placeSignature(page, xPt, yPt);
      return;
    }
    // [tap-rung: annotate-retap-unselect]
    // A tap on the annotation ALREADY selected keeps it, or with tapKeepsAnnotationSelected off
    // unselects it (PageSelectionPolicy.tapUnselects) — the empty tap's path.
    if (!this._tapKeepsAnnotationSelected) {
      const ink0 = st ? null : this._inkAt(page, xPt, yPt);
      const mi = st || ink0 ? -1 : topmostMark(marks, xPt, yPt);
      const ss = this._selectedStamp, si = this._selectedInk, sm = this._selectedMark;
      const same = (a, b) => a === b || (!!a.nm && a.nm === b.nm);
      if ((st && ss && ss.page === page && same(st, ss.stamp)) ||
          (ink0 && si && si.page === page && same(ink0, si.ink)) ||
          (mi >= 0 && sm && sm.page === page && same(marks[mi], sm.mark))) {
        if (this._pageSel) this._clearPageSel();
        this._dropAnnotationSelection();
        return;
      }
    }
    // [tap-rung: stamp-hit]
    if (st) {   // drawn OVER the page and its marks, so it outranks a mark
      if (this._pageSel) this._clearPageSel();
      this._setSelectedStamp({ page, stamp: st });
      return;
    }
    // [tap-rung: ink-hit]
    const ink = this._inkAt(page, xPt, yPt);
    if (ink) {   // drawn over the page's marks (DR3)
      if (this._pageSel) this._clearPageSel();
      this._setSelectedInk({ page, ink });
      return;
    }
    // [tap-rung: markup-hit]
    const i = topmostMark(marks, xPt, yPt);
    if (this._pageSel) this._clearPageSel();
    if (i >= 0) { this._setSelectedMark({ page, mark: marks[i] }); return; }
    // [tap-rung: annotate-empty-clear]
    if (this._selectedMark) this._setSelectedMark(null);   // _annotateTapEmpty
    if (this._selectedStamp) this._setSelectedStamp(null);
    if (this._selectedInk) this._setSelectedInk(null);
    // [tap-precedence: END web-annotate-tap]
  }

  // ---- VIEW-MODE SELECTION + THE SDK'S WORDS MENU (W3) — PdfeEditorView's names ----------

  /** In VIEW mode, may a long-press (or a mouse drag) select text? Default false. @since 3.15.0 */
  get viewTextSelectionEnabled() { return this._viewTextSelectionEnabled; }
  set viewTextSelectionEnabled(v) { this._viewTextSelectionEnabled = !!v; this._syncAnnotatePolicy(); }
  /** In VIEW mode, does the SDK draw its menu over a settled selection? Default false. @since 3.15.0 */
  get viewSelectionMenuEnabled() { return this._viewSelectionMenuEnabled; }
  set viewSelectionMenuEnabled(v) { this._viewSelectionMenuEnabled = !!v; this._syncAnnotatePolicy(); }
  /** In ANNOTATE mode with no tool armed, does the SDK draw its menu? Default false. @since 3.15.0 */
  get annotateSelectionMenuEnabled() { return this._annotateSelectionMenuEnabled; }
  set annotateSelectionMenuEnabled(v) { this._annotateSelectionMenuEnabled = !!v; this._syncAnnotatePolicy(); }
  /** Which built-in items the menu offers, in order: "copy", "highlight", "underline",
   *  "squiggle", "strikeout" (all by default). Duplicates and unknown ids are dropped; an
   *  empty list hides the menu. Replaces a `setActions("pagetext", …)` list. @since 3.15.0 */
  get selectionMenuItems() { return [...this._selectionMenuItems]; }
  set selectionMenuItems(v) {
    this._selectionMenuItems = [...new Set((v || []).map(String))].filter((id) => PDFE_SELECTION_MENU_ITEMS.includes(id));
    this._actionsByKind.delete("pagetext");   // the latest call wins, as on Android
    this._menuKey = null;
    this._syncSelectionMenu();
  }
  /** The menu's buttons in VIEW mode only ({id, label?, icon?} — built-ins and your own), or
   *  null for the shared list. @since 3.15.0 */
  get viewSelectionMenuActions() { return this._viewSelectionMenuActions && this._viewSelectionMenuActions.map((a) => ({ ...a })); }
  set viewSelectionMenuActions(v) { this._viewSelectionMenuActions = this._cleanActions(v); this._menuKey = null; this._syncSelectionMenu(); }
  /** The menu's buttons in ANNOTATE mode only, or null for the shared list. @since 3.15.0 */
  get annotateSelectionMenuActions() { return this._annotateSelectionMenuActions && this._annotateSelectionMenuActions.map((a) => ({ ...a })); }
  set annotateSelectionMenuActions(v) { this._annotateSelectionMenuActions = this._cleanActions(v); this._menuKey = null; this._syncSelectionMenu(); }
  /** YOUR OWN menu element, or 0 / null for the SDK's. Every `[data-pdfe-action="<id>"]` in
   *  it is that button (shown only when its id is offered); everything else is yours. A value
   *  that is not an element reports `menu-layout-failed` and falls back to the SDK's. @since 3.15.0 */
  get selectionMenuLayout() { return this._selectionMenuLayout; }
  set selectionMenuLayout(v) { this._selectionMenuLayout = this._checkMenuLayout(v, 0); this._menuKey = null; this._syncSelectionMenu(); }
  /** The menu element in VIEW mode only: an element, 0 for the SDK's, null for the shared one. @since 3.15.0 */
  get viewSelectionMenuLayout() { return this._viewSelectionMenuLayout; }
  set viewSelectionMenuLayout(v) { this._viewSelectionMenuLayout = this._checkMenuLayout(v, null); this._menuKey = null; this._syncSelectionMenu(); }
  /** The menu element in ANNOTATE mode only: an element, 0 for the SDK's, null for the shared one. @since 3.15.0 */
  get annotateSelectionMenuLayout() { return this._annotateSelectionMenuLayout; }
  set annotateSelectionMenuLayout(v) { this._annotateSelectionMenuLayout = this._checkMenuLayout(v, null); this._menuKey = null; this._syncSelectionMenu(); }

  /**
   * WHERE A PAGE POINT IS ON SCREEN — `{x, y}` in CSS pixels from the editor's top-left (the
   * same space as `selectionScreenRect`), or null for a page that does not exist. Turn a
   * `pagelongpress` point into the spot under the finger for your own popup. Scrolling and
   * zooming move the answer. @since 3.15.0
   */
  pageToScreen(page, xPt, yPt) {
    if (!Number.isInteger(page) || page < 0 || page >= this._pages.length) return null;
    const rect = this._pageRect(page);
    if (!rect) return null;
    const k = this._k(page);
    const v = this._ptToView(page, Number(xPt) || 0, Number(yPt) || 0);
    const box = this.root.getBoundingClientRect();
    const strip = this.strip.getBoundingClientRect();
    return { x: strip.left - box.left + rect.left + v[0] * k, y: strip.top - box.top + rect.top + v[1] * k };
  }

  _cleanActions(v) {
    if (v == null) return null;
    const seen = new Set();
    return [...v].filter((a) => {
      const id = a && String(a.id || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map((a) => ({ id: String(a.id), label: a.label ?? null, icon: a.icon ?? null }));
  }
  _checkMenuLayout(v, fallback) {
    if (isMenuLayout(v)) return v ?? fallback;
    this._emit("error", errorEvent("menu-layout-failed",
      "selectionMenuLayout must be an element, 0 or null — using the SDK's own menu"));
    return 0;
  }
  /** The app's menu element for the mode now, or null for the SDK's own. */
  _menuHost() {
    const per = this._mode === "annotate" ? this._annotateSelectionMenuLayout : this._viewSelectionMenuLayout;
    const v = per ?? this._selectionMenuLayout;
    return v && v.nodeType === 1 ? v : null;
  }
  /** ActionPolicy.offered for the words: Copy needs text, the four tools always; delete,
   *  edit and rotate never; an id of the app's always. */
  _menuOffered(id) {
    if (id === "copy") return !!(this._pageSel && this._pageSel.text);
    if (PDFE_MARKUP_TOOLS.includes(id)) return true;
    return !["edit", "delete", "rotate", "rotate_left", "rotate_right"].includes(id);
  }

  /** Show, fill and park the words menu — or hide it (PdfeEditorView.syncSelectionMenu). */
  _syncSelectionMenu() {
    const el = this.selMenuEl;
    if (!el) return;
    const s = this._mode !== "text" ? this._pageSel : null;
    const host = this._menuHost();
    let items = s && s.settled && this._showsMenu()
      ? this.actions("pagetext").filter((a) => this._menuOffered(a.id)) : [];
    if (host) items = items.filter((a) => [...host.querySelectorAll("[data-pdfe-action]")]
      .some((b) => b.dataset.pdfeAction === a.id));
    if (!items.length) { el.style.display = "none"; return; }
    const key = items.map((a) => a.id).join(",") + "|" + (host ? "host" : "sdk");
    if (key !== this._menuKey) {
      this._menuKey = key;
      el.classList.toggle("pdfe-hostbar", !!host);
      if (host) {
        if (host.parentNode !== el) el.replaceChildren(host);
        for (const b of host.querySelectorAll("[data-pdfe-action]"))
          b.style.display = items.some((a) => a.id === b.dataset.pdfeAction) ? "" : "none";
      } else {
        el.replaceChildren(...items.map((a) => this._actionButton(a)));
      }
    }
    // Park it just above the selection, below when there is no room, inside the page.
    const rect = this._pageRect(s.page);
    if (!rect || !s.bounds) { el.style.display = "none"; return; }
    el.style.display = "flex";
    const k = this._k(s.page);
    const v = this._viewBox(s.page, s.bounds);
    const left = rect.left + v.left * k, top = rect.top + v.top * k, bot = top + v.height * k;
    const bw = el.offsetWidth, bh = el.offsetHeight;
    let y = top - bh - 8;
    if (y < rect.top) y = bot + 8;
    el.style.left = `${Math.max(rect.left, Math.min(left, rect.left + rect.width - bw))}px`;
    el.style.top = `${y}px`;
  }

  /** A menu button: the app is asked first (`action`, then for the five built-ins
   *  `selectionmenuitem`); otherwise the SDK acts. Taken over: the menu closes, the
   *  selection STAYS (PdfeEditorView.onSelectionMenuPick). */
  _onMenuPick(id) {
    const s = this._pageSel;
    if (!s || !s.settled) return;
    const snap = this.pageTextSelection;
    let handled = false;
    this._emit("action", { id, kind: "pagetext", page: snap.page,
                           boundsPt: snap.bounds ? [...snap.bounds] : null, text: snap.text,
                           preventDefault() { handled = true; } });
    const builtIn = PDFE_SELECTION_MENU_ITEMS.includes(id);
    if (!handled && builtIn)
      this._emit("selectionmenuitem", { item: id, selection: snap, preventDefault() { handled = true; } });
    if (handled || !builtIn) {
      s.settled = false;            // the menu closes; the selection is kept
      this._syncSelectionMenu();
      return;
    }
    this._runWordsAction(id);
  }

  /** The SDK's own action for a words item: Copy, or arm that tool and mark — switching a
   *  reader selection into annotate mode first (PageSelectionPolicy.action). */
  _runWordsAction(id) {
    const s = this._pageSel;
    if (!s) return;
    if (id === "copy") {
      try { navigator.clipboard?.writeText(s.text || ""); } catch (e) { /* no clipboard here */ }
      this._clearPageSel();
      return;
    }
    if (!PDFE_MARKUP_TOOLS.includes(id)) return;
    if (this._mode === "view") this.setMode("annotate");   // the selection is carried (§18)
    if (this._mode !== "annotate") return;
    this._markupTool = id;   // arm only — the mark is made just below, once
    this._emit("markuptool", { tool: id, color: this.markupColor });
    this._syncAnnotatePolicy();
    this._markSelection(id, this._markupColors[id]);
  }

  /** The pointer in annotate mode: a long-press (or a mouse drag, or a one-finger drag with
   *  a tool armed) selects text; a tap selects a mark. Two fingers stay the pinch's. */
  _pagePointerDown(ev, canvas) {
    if (ev.button > 0) return;
    const annotate = this._mode === "annotate";
    const page = Number(canvas.dataset.page);
    const mouse = this._lastPointerType === "mouse";
    const scaleCss = this._k(page);
    const toPt = (cx, cy) => {
      const rect = canvas.getBoundingClientRect();
      const [xPt, yPt] = this._viewToPt(page, (cx - rect.left) / scaleCss, (cy - rect.top) / scaleCss);
      return { xPt, yPt };
    };
    const tolPt = PDFE_PAGE_PRESS_REACH_PX / scaleCss;
    const sx = ev.clientX, sy = ev.clientY;
    const down = toPt(sx, sy);
    const canSelect = this._canSelectPageText();
    // [tap-precedence: BEGIN web-annotate-down]
    // [tap-rung: annotate-draw-grab]
    // DRAWING (DR3): with the pen or the eraser in hand one pointer draws (a stylus only when
    // drawingStylusOnly); two fingers pinch, and a second finger ends the stroke unsaved.
    if (annotate && this._draws(ev.pointerType || this._lastPointerType)) {
      // A SECOND pointer while one draws: that stroke ends unsaved and the pinch takes over.
      if (this._drawStroke) { this._drawStroke.cancel(); return; }
      ev.preventDefault();
      this._drawStrokeGesture(ev, canvas, page, toPt);
      return;
    }
    // [tap-rung: ink-drag]
    // A SELECTED DRAWING DRAGS: an outline follows, ONE transform on the lift (a tap selects again).
    const si = annotate ? this._selectedInk : null;
    if (si && si.page === page && this._inBounds(si.ink.rect, down)) {
      ev.preventDefault();
      this._dragInkGesture(ev, canvas, page, toPt, down);
      return;
    }
    // A SELECTED SIGNATURE DRAGS (W4 = SG10): a ghost follows, the stamp is written ONCE on the lift.
    const ss = annotate ? this._selectedStamp : null;
    const stampDrag = !!ss && ss.page === page && this._inBounds(ss.stamp.rect, down);
    // OUR signature crosses pages (I135: no clamp, it lands on the page it overlaps most);
    // another app's stays on its page, clamped by the core's limits.
    const crosses = stampDrag && !!ss.stamp.turn && ss.stamp.kind !== 2;
    if (stampDrag) {
      this._moveLimits = null;
      if (!crosses) this._post({ type: "stampLimits", page, nm: ss.stamp.nm });
      // Captured at the PRESS: a fast drag onto the next page would otherwise send its moves to
      // that page's canvas, and this one would never see the drag begin.
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
    }
    const onStamp = annotate && !!this._stampAt(page, down.xPt, down.yPt);
    // I138/I167 (PageSelectionPolicy.swallowsLongPress): a press ON the selected annotation starts
    // nothing; elsewhere it unselects it first — or, with newSelectionDeselectsAnnotation off,
    // starts nothing while one is selected.
    const anySel = !!(this._selectedMark || this._selectedStamp || this._selectedInk);
    const blocked = annotate && anySel &&
      (!this._newSelectionDeselectsAnnotation || this._pressOnSelectedAnnotation(page, down));
    // [tap-rung: annotate-drag-select-grab]
    const dragSel = !stampDrag && !onStamp && !blocked && (mouse ? canSelect : this._dragSelects());
    if ((mouse && canSelect) || stampDrag) ev.preventDefault();   // no native text selection / image drag
    let pressed = false, selecting = false, moved = false, reported = false, dragging = false;
    // [tap-rung: long-press-stamp-swallow]
    // A long-press ON a signature means nothing (15-SIGNATURE §5.6, stampAt( on Android); with an
    // annotation selected it unselects it first (I167), or with the switch off means nothing (I138).
    const lpArmed = !(annotate && (blocked || onStamp));
    // [tap-rung: long-press-page-word]
    const lp = lpArmed ? setTimeout(() => {
      if (this._pinchActive || this._mode === "text") return;
      if (annotate) this._dropAnnotationSelection();
      const at = { page, xPt: down.xPt, yPt: down.yPt };
      // Selection off for this mode: only REPORTED, so a host can say "pick a tool first".
      if (!this._canSelectPageText()) { reported = true; this._emit("pagelongpress", { ...at, selected: false }); return; }
      pressed = true;
      this._annotSelecting = true;      // the finger now drags the selection, not the page
      this._post({ type: "pageSelPress", page, xPt: down.xPt, yPt: down.yPt, tolPt, unit: "word", lp: at });
    }, this.longPressMs) : 0;
    // [tap-precedence: END web-annotate-down]
    const cleanup = () => {
      clearTimeout(lp);
      this._annotSelecting = false;
      this._loupeHide();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", abort);
    };
    const abort = () => {
      const was = pressed || selecting;
      cleanup();
      if (was) this._post({ type: "pageSelEnd" });
      if (dragging) {
        dragging = false; this._draggingBox = false; this._hideMoveGhost();
        if (!this._itemGesture) { this._liveEnd(); this._endSelectionGesture(); }
        this._renderBoxes();
      }
    };
    const move = (mv) => {
      if (this._pinchActive) { abort(); return; }
      if (dragging) {
        const c = toPt(mv.clientX, mv.clientY);
        this._showMoveGhost(page, ss.stamp.rect, c.xPt - down.xPt, c.yPt - down.yPt);
        this._liveMove(page, ...(this._ghostDelta || [c.xPt - down.xPt, c.yPt - down.yPt]));
        return;
      }
      if (!moved) {
        if (Math.hypot(mv.clientX - sx, mv.clientY - sy) <= 8) return;
        moved = true;
        clearTimeout(lp);
        if (stampDrag) {
          dragging = true;
          this._draggingBox = true;
          this.actionsEl.style.display = "none";
          try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
          // W5c: the signature moves ITSELF, and the host hears the gesture.
          this._beginSelectionGesture(ss.stamp.kindName);
          const t = this._transformTarget();
          this._liveBegin(t, this._itemCorners(t));
          this._renderBoxes();
          return;
        }
        if (!pressed && dragSel) {
          selecting = true;
          this._annotSelecting = true;
          try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
          const c = toPt(mv.clientX, mv.clientY);
          if (annotate) this._dropAnnotationSelection();
          this._post({ type: "pageSelDragFrom", page, ax: down.xPt, ay: down.yPt,
                       xPt: c.xPt, yPt: c.yPt, tolPt });
          return;
        }
        if (!pressed) { cleanup(); return; }   // a pan: the browser scrolls
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
      }
      const c = toPt(mv.clientX, mv.clientY);
      this._loupeAt(mv, page, mv.clientX, mv.clientY);   // W7b
      this._post({ type: "pageSelDrag", which: 1, xPt: c.xPt, yPt: c.yPt });
    };
    const up = (uv) => {
      const sel = pressed || selecting;
      cleanup();
      if (dragging) {
        const c = toPt(uv.clientX, uv.clientY);
        const [dx, dy] = this._ghostDelta || [c.xPt - down.xPt, c.yPt - down.yPt];
        this._draggingBox = false;
        this._hideMoveGhost();
        const r = ss.stamp.rect;
        if ((dx || dy) && ss.stamp.nm) {
          this._liveMove(page, dx, dy);
          if (crosses) this._dropStampAcrossPages(ss, dx, dy);
          else this._post({ type: "stampSetRect", page, nm: ss.stamp.nm, rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] });
          this._itemCommitPending();
        } else { this._liveEnd(); this._renderBoxes(); this._endSelectionGesture(); }
        return;
      }
      if (this._pinchActive || performance.now() - this._lastPinchEnd < 350) return;
      if (sel) { this._post({ type: "pageSelEnd" }); return; }
      if (reported) { this._swallowPageTapAt = performance.now(); return; }   // a long-press is not also a tap
      if (moved) return;
      const { xPt, yPt } = toPt(uv.clientX, uv.clientY);
      if (annotate) this._annotateTap(page, xPt, yPt);
      else this._viewTap(page, xPt, yPt);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", abort);
  }

  /** A tap in VIEW mode: it drops a page selection (and its menu) and means nothing else;
   *  with none, the `pagetap` report runs as before (Android's handleViewTap). */
  _viewTap(page, xPt, yPt) {
    // [tap-precedence: BEGIN web-view-tap]
    // [tap-rung: view-selection-clear]
    if (this._pageSel) { this._clearPageSel(); this._swallowPageTapAt = performance.now(); return; } // _viewTapClear
    // [tap-rung: view-link]
    // W6 (reader R2): a tap on a link follows it — a jump inside the document scrolls there, an
    // address is REPORTED (the SDK never opens a browser). It is not also a pagetap.
    const link = this._linkAt(page, xPt, yPt);
    if (link) {
      this._swallowPageTapAt = performance.now();
      if (link.kind === 1) this.goToPage(link.page, true);
      else this._emit("linktapped", { uri: link.uri });
    }
    // [tap-precedence: END web-view-tap]
  }

  /** The two knobs on a page selection (annotate's own; text mode's stay untouched). */
  _wireAnnotHandles() {
    this.annotHandleEls.forEach((el, which) => {
      this._listen(el, "pointerdown", (ev) => {
        if (!this._pageSel) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ }
        this._annotHeldKnob = which;
        const page = this._pageSel.page;
        this._annotSelecting = true;
        const move = (mv) => {
          const canvas = this._pageCanvases[page];
          if (!canvas || !this._pageSel) return;
          const rect = canvas.getBoundingClientRect();
          const scaleCss = this._k(page);
          const [xPt, yPt] = this._viewToPt(page, (mv.clientX - rect.left) / scaleCss,
            (mv.clientY - HANDLE_TOUCH_LIFT - rect.top) / scaleCss);
          this._loupeAt(mv, page, mv.clientX, mv.clientY - HANDLE_TOUCH_LIFT);   // W7b
          this._post({ type: "pageSelDrag", which: this._annotHeldKnob, xPt, yPt });
        };
        const up = () => {
          this._annotSelecting = false;
          this._loupeHide();
          el.removeEventListener("pointermove", move);
          this._post({ type: "pageSelEnd" });
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up, { once: true });
        el.addEventListener("pointercancel", up, { once: true });
      });
    });
  }

  /** Paint the page selection (in the armed tool's colour as a live preview) and its knobs. */
  _renderAnnotate() {
    if (!this.annotSelEl) return;
    this.annotSelEl.innerHTML = "";
    const s = this._mode !== "text" ? this._pageSel : null;
    const rect = s && this._pageRect(s.page);
    this._syncSelectionMenu();
    this._reportSelectionRect();
    if (!s || !rect || !this._pages[s.page]) {
      this.annotHandleEls.forEach((h) => { h.style.display = "none"; });
      return;
    }
    const scaleCss = this._k(s.page);
    const tint = this._mode === "annotate" && this._markupTool ? argbCss(this.markupColor, 0.55) : null;
    const q = s.quads || [];
    for (let o = 0; o + 8 <= q.length; o += 8) {
      const xs = [q[o], q[o + 2], q[o + 4], q[o + 6]], ys = [q[o + 1], q[o + 3], q[o + 5], q[o + 7]];
      const v = this._viewBox(s.page, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      const div = this._doc.createElement("div");
      div.className = "pdfe-selrect";
      if (tint) div.style.background = tint;
      div.style.left = (rect.left + v.left * scaleCss) + "px";
      div.style.top = (rect.top + v.top * scaleCss) + "px";
      div.style.width = (v.width * scaleCss) + "px";
      div.style.height = (v.height * scaleCss) + "px";
      this.annotSelEl.appendChild(div);
    }
    (s.anchors || [null, null]).forEach((a, i) => {
      const el = this.annotHandleEls[i];
      const bot = a && this._pageToCss(a[0], a[1], s.page);
      if (!bot) { el.style.display = "none"; return; }
      el.style.display = "block";
      el.style.left = `${bot.x - 9}px`;
      el.style.top = `${bot.y}px`;
    });
  }

  /** The selected mark's outline and its bar — called from _renderBoxes in annotate mode. */
  _renderSelectedMark(scaleCss) {
    const sel = this._selectedMark;
    if (!sel) return;
    const rect = this._pageRect(sel.page);
    if (!rect || !this._pageCanvases[sel.page]) return;
    const div = this._doc.createElement("div");
    div.className = "pdfe-parabox pdfe-selected";
    const v = this._viewBox(sel.page, sel.mark.rect);
    div.style.left = `${rect.left + v.left * scaleCss}px`;
    div.style.top = `${rect.top + v.top * scaleCss}px`;
    div.style.width = `${v.width * scaleCss}px`;
    div.style.height = `${v.height * scaleCss}px`;
    this.boxesEl.appendChild(div);
    if (this._fillActions("markup")) this._placeActions(sel.page, sel.mark.rect, scaleCss);
  }

  /** The engine answered a drawing call (DR3): the lists, the events, the selection. */
  _onInkChanged(msg) {
    this._pageInks.set(msg.page, msg.inks || []);
    const find = (nm) => (msg.inks || []).find((k) => k.nm === nm);
    if (msg.op === "create" || msg.op === "erase") this._dropDrawLive();
    if (!msg.ok) {
      this._emit("error", errorEvent(msg.op === "create" ? "drawing-failed" : "drawing-not-found",
        msg.op === "create" ? "The drawing could not be written" : "That drawing is no longer on the page"));
      if (msg.op === "delete") this._emit("deleted", { page: msg.page, ok: false, kind: "drawing" });
      if (this._selectedInk && !find(this._selectedInk.ink.nm)) this._setSelectedInk(null);
      else this._renderBoxes();
      return;
    }
    if (msg.op === "erase" && !msg.count) return;   // touched nothing, changed nothing
    if (!this._history.recording) this._setDirty(true);
    switch (msg.op) {
      case "create": {
        const k = find(msg.nm);
        this._emit("drawingcreated", { page: msg.page, id: msg.nm, bounds: k ? [...k.rect] : null });
        return;
      }
      case "erase":
        for (const nm of msg.changed || []) {
          const k = find(nm);
          this._emit("drawingchanged", { page: msg.page, id: nm, what: "erased", bounds: k ? [...k.rect] : null });
        }
        for (const nm of msg.deleted || []) this._emit("drawingdeleted", { page: msg.page, id: nm });
        if (this._selectedInk && !find(this._selectedInk.ink.nm)) this._setSelectedInk(null);
        return;
      case "delete":
        this._emit("deleted", { page: msg.page, ok: true, kind: "drawing" });
        this._emit("drawingdeleted", { page: msg.page, id: msg.nm });
        return;
      default: {   // transform (moved / resized) or style
        if (msg.op === "transform") this._settleItemGesture();
        const k = find(msg.nm);
        if (k) this._setSelectedInk({ page: msg.page, ink: k });
        const what = msg.op === "style" ? "restyled" : (msg.change || "moved");
        this._emit("drawingchanged", { page: msg.page, id: msg.nm, what, bounds: k ? [...k.rect] : null });
        if (msg.op === "transform") this._emit("moved", { page: msg.page, ok: true, kind: "drawing", bounds: k ? [...k.rect] : null });
      }
    }
  }

  /** The worker's annotate replies. Returns true when |msg| was one. */
  _onAnnotateMessage(msg) {
    switch (msg.type) {
      case "marks":
        if (msg.matrix !== undefined) this._pageMatrices.set(msg.page, msg.matrix);
        this._pageMarks.set(msg.page, msg.marks || []);
        this._pageStamps.set(msg.page, msg.stamps || []);
        if (msg.inks) this._pageInks.set(msg.page, msg.inks);
        return true;
      case "inkChanged": this._onInkChanged(msg); return true;
      case "signaturePlaced": {
        this._pageStamps.set(msg.page, msg.stamps || []);
        if (!msg.ok) {
          this._emit("error", errorEvent("signature-failed", "The signature could not be placed"));
          return true;
        }
        if (!this._history.recording) this._setDirty(true);
        const st = (msg.stamps || []).find((s) => s.nm === msg.nm);
        this._emit("signatureplaced", { page: msg.page, id: msg.nm, kind: st ? st.kindName : "signature",
                                        bounds: st ? [...st.rect] : null });
        if (st && this._mode === "annotate") this._setSelectedStamp({ page: msg.page, stamp: st });
        return true;
      }
      case "stampMovedToPage": {
        this._settleItemGesture();
        this._pageStamps.set(msg.from, msg.fromStamps || []);
        this._pageStamps.set(msg.to, msg.toStamps || []);
        this._pageMarks.set(msg.from, msg.fromMarks || []);
        this._pageMarks.set(msg.to, msg.toMarks || []);
        const fresh = (msg.toStamps || []).find((s) => s.nm === msg.nm);
        if (!msg.ok || !fresh) {
          // The web reports a refused move through `moved` ok:false (Android: move-failed).
          this._renderBoxes();
          this._emit("moved", { page: msg.from, ok: false, kind: this._selectedStamp?.stamp.kindName ?? "signature", bounds: null });
          return true;
        }
        if (!this._history.recording) this._setDirty(true);
        this._setSelectedStamp({ page: msg.to, stamp: fresh });
        this._emit("moved", { page: msg.to, ok: true, kind: fresh.kindName, bounds: [...fresh.rect] });
        return true;
      }
      case "stampLimits":
        if (this._selectedStamp && this._selectedStamp.stamp.nm === msg.nm) this._moveLimits = msg.limits;
        return true;
      case "stampChanged": {
        if (msg.op !== "stampDelete") this._settleItemGesture();
        this._pageStamps.set(msg.page, msg.stamps || []);
        const kind = (this._selectedStamp?.stamp.nm === msg.nm ? this._selectedStamp.stamp.kindName : null) ??
                     (msg.stamps || []).find((s) => s.nm === msg.nm)?.kindName ?? msg.kind ?? "signature";
        if (msg.op === "stampDelete") {
          if (!msg.ok) this._emit("error", errorEvent("signature-not-found", "That item is no longer on the page"));
          else if (!this._history.recording) this._setDirty(true);
          this._emit("deleted", { page: msg.page, ok: !!msg.ok, kind: msg.kind || kind });
          if (msg.ok) this._emit("signaturedeleted", { page: msg.page, id: msg.nm, kind: msg.kind || kind });
          return true;
        }
        const fresh = (msg.stamps || []).find((s) => s.nm === msg.nm);
        if (!msg.ok) {
          this._emit("error", errorEvent("signature-not-found", "That item is no longer on the page"));
          if (!fresh && this._selectedStamp?.stamp.nm === msg.nm) this._setSelectedStamp(null);
          else this._renderBoxes();
          return true;
        }
        if (!this._history.recording) this._setDirty(true);
        if (fresh) this._setSelectedStamp({ page: msg.page, stamp: fresh });
        this._emit("moved", { page: msg.page, ok: true, kind: fresh ? fresh.kindName : kind,
                              bounds: fresh ? [...fresh.rect] : null });
        return true;
      }
      case "pageSel": {
        if (this._mode === "text") return true;
        if (msg.page < 0) {
          this._pageSel = null;
          this._reportPageSel();
          this._renderAnnotate();
          if (msg.lp) this._emit("pagelongpress", { ...msg.lp, selected: false });
          return true;
        }
        if (msg.which !== undefined) this._annotHeldKnob = msg.which;
        this._pageSel = { page: msg.page, start: msg.start, end: msg.end, quads: msg.quads,
                          anchors: msg.anchors, text: msg.text, bounds: msg.bounds,
                          settled: !!msg.settled };
        if (msg.reason === "press" && this._selectedMark) this._setSelectedMark(null);
        this._renderAnnotate();
        if (msg.lp) this._emit("pagelongpress", { ...msg.lp, selected: true });
        if (msg.settled && this._mode === "view") {
          this._reportPageSel();
        } else if (msg.settled) {
          const t = this._markupTool;
          if (t && this._markupOnSelectionEnd) this._markSelection(t, this._markupColors[t]);
          else this._reportPageSel();
        } else {
          this._reportPageSel();   // a press or a drag withdraws what the host was told
        }
        return true;
      }
      case "markupCreated": {
        if (msg.marks) this._pageMarks.set(msg.page, msg.marks);
        if (!msg.ok) {
          this._emit("error", errorEvent(msg.code || "markup-failed",
            msg.code === "markup-no-text" ? "Select some text first"
                                          : "The mark could not be written — the page may have changed"));
          return true;
        }
        if (msg.nothing) return true;
        if (!this._history.recording) this._setDirty(true);
        this._emit("markupcreated", { page: msg.page, id: msg.nm, tool: PDFE_MARKUP_TOOLS[msg.kind],
                                      color: msg.color });
        // markupSelection(..., select = true): select the new mark, unless a new selection began.
        const made = msg.select && this._mode === "annotate" && !this._pageSel &&
                     (msg.marks || []).find((m) => m.nm === msg.nm);
        if (made) this._setSelectedMark({ page: msg.page, mark: made });
        return true;
      }
      case "markupDeleted": {
        if (msg.marks) this._pageMarks.set(msg.page, msg.marks);
        if (!msg.ok) this._emit("error", errorEvent("markup-not-found", "That mark is no longer on the page"));
        else if (!this._history.recording) this._setDirty(true);
        this._emit("deleted", { page: msg.page, ok: !!msg.ok, kind: "markup" });
        if (msg.ok) this._emit("markupdeleted", { page: msg.page, id: msg.nm, tool: msg.kind ?? null });
        return true;
      }
      case "markupRecolored": {
        if (msg.marks) this._pageMarks.set(msg.page, msg.marks);
        if (!msg.ok) {
          this._emit("error", errorEvent("markup-failed", "That mark could not be recoloured"));
          return true;
        }
        if (!this._history.recording) this._setDirty(true);
        const back = (msg.marks || []).find((m) => m.nm === msg.nm);
        if (back && this._selectedMark && this._selectedMark.page === msg.page &&
            this._selectedMark.mark.nm === msg.nm) this._setSelectedMark({ page: msg.page, mark: back });
        return true;
      }
      case "markupHistoryApplied": {
        if (msg.marks) this._pageMarks.set(msg.page, msg.marks);
        if (msg.stamps) this._pageStamps.set(msg.page, msg.stamps);
        if (msg.inks) this._pageInks.set(msg.page, msg.inks);
        if (msg.other?.inks) this._pageInks.set(msg.other.page, msg.other.inks);
        if (msg.stepKind === 2) {   // DR3: an INK step — the drawing it brought back is selected
          const back = msg.ok && msg.present && msg.nm && (msg.inks || []).find((k) => k.nm === msg.nm);
          if (back) this._setSelectedInk({ page: msg.page, ink: back });
          else if (this._selectedInk && !(this._pageInks.get(this._selectedInk.page) || [])
                     .some((k) => k.nm === this._selectedInk.ink.nm)) this._setSelectedInk(null);
          if (msg.ok) this._scrollRectIntoViewIfOffscreen(msg.page, msg.focus);
          else this._emit("error", errorEvent("history-unavailable", "Undo failed."));
          this._emit(msg.kind, { page: msg.page, ok: !!msg.ok, live: false });
          return true;
        }
        if (msg.other) { this._pageMarks.set(msg.other.page, msg.other.marks); this._pageStamps.set(msg.other.page, msg.other.stamps); }
        // A SIGNATURE the step brought back is selected; one it took away is deselected (W4).
        const stBack = msg.ok && msg.present && msg.nm &&
          [[msg.page, msg.stamps], msg.other && [msg.other.page, msg.other.stamps]].filter(Boolean)
            .map(([p, l]) => ({ page: p, stamp: (l || []).find((s) => s.nm === msg.nm) })).find((x) => x.stamp);
        if (stBack) {
          this._setSelectedStamp(stBack);
          if (msg.ok) this._scrollRectIntoViewIfOffscreen(stBack.page, stBack.stamp.rect);
          this._emit(msg.kind, { page: msg.page, ok: true, live: false });
          return true;
        }
        if (this._selectedStamp && !(this._pageStamps.get(this._selectedStamp.page) || [])
              .some((s) => s.nm === this._selectedStamp.stamp.nm)) this._setSelectedStamp(null);
        // The mark a step brought back is SELECTED (Android parity); one it took away is
        // deselected if it was the selection.
        const back = msg.ok && msg.present && msg.nm && (msg.marks || []).find((m) => m.nm === msg.nm);
        if (back) this._setSelectedMark({ page: msg.page, mark: back });
        else if (this._selectedMark && this._selectedMark.page === msg.page &&
                 !(msg.marks || []).some((m) => m.nm === this._selectedMark.mark.nm)) this._setSelectedMark(null);
        if (msg.ok) this._scrollRectIntoViewIfOffscreen(msg.page, msg.focus);
        else this._emit("error", errorEvent("history-unavailable", "Undo failed."));
        this._emit(msg.kind, { page: msg.page, ok: !!msg.ok, live: false });
        return true;
      }
    }
    return false;
  }

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
    if (this._selectedInk) return "drawing";   // annotate only (DR3)
    if (this._selectedStamp) return this._selectedStamp.stamp.kindName;   // annotate only (W4)
    if (this._selectedMark) return "markup";   // annotate mode only (step 19)
    if (this._selectedImage) return "image";
    if (this._selected) return "text";
    return null;
  }
  /** true while a TEXT BOX is selected (tapped once, not open for typing) — the
   *  one-line form of `selectionKind === "text"`. Since 3.1.0. */
  get isTextBoxSelected() { return this.selectionKind === "text"; }
  /** true while a PICTURE is selected — `selectionKind === "image"`. Since 3.1.0. */
  get isImageSelected() { return this.selectionKind === "image"; }
  /** true while ANYTHING is selected — what `clearSelection()` clears: a box, a picture,
   *  a mark, or page text (annotate mode, since 3.15.0 — as Android). Since 3.3.0. */
  get isAnythingSelected() { return this.selectionKind !== null || !!this._pageSel; }
  /**
   * The TEXT of the selected text box, or null when no text box is selected (a
   * picture, nothing, or a box open for typing — read `editing` for that). Plain
   * text as the box shows it: paragraphs on their own lines, a bullet list one line
   * per line; no style. Answered from what the SDK already holds, so it is instant
   * and safe inside the `select` handler. Since 3.1.0.
   */
  get selectedTextBoxText() {
    return this.selectionKind === "text" ? (this._selected.text ?? null) : null;
  }
  // ---- FREE RESIZE / STRETCH / TURN FROM CODE (W5b — Android's names) ---------------------

  /** The selected picture (text mode) or signature/stamp (annotate) as {kind, page, item}, or null. */
  _transformTarget() {
    if (this._mode === "text" && this._selectedImage) return { kind: "image", page: this._selectedImage.page, item: this._selectedImage };
    if (this._mode === "annotate" && this._selectedStamp) return { kind: "stamp", page: this._selectedStamp.page, item: this._selectedStamp.stamp };
    // A drawing: its box (/Rect), which never turns; the knobs resize / stretch it.
    if (this._mode === "annotate" && this._selectedInk) return { kind: "ink", page: this._selectedInk.page, item: this._selectedInk.ink };
    return null;
  }
  /** A page point on screen as client px [x, y]. */
  _ptToClient(page, x, y) {
    const r = this._pageCanvases[page].getBoundingClientRect(), k = this._k(page), v = this._ptToView(page, x, y);
    return [r.left + v[0] * k, r.top + v[1] * k];
  }
  _clientToPt(page, cx, cy) {
    const r = this._pageCanvases[page].getBoundingClientRect(), k = this._k(page);
    return this._viewToPt(page, (cx - r.left) / k, (cy - r.top) / k);
  }
  /** The selected item's corners on SCREEN, in its own order BL, BR, TR, TL (PdfPageView.itemCorners):
   *  a picture's quad; a turnable stamp's unturned box turned about its centre; else its rect. */
  _itemCorners(t) {
    if (!t || !this._pageCanvases[t.page]) return null;
    if (t.kind === "image") {
      const q = t.item.quad;
      return q && q.length === 8 ? [0, 1, 2, 3].flatMap((i) => this._ptToClient(t.page, q[2 * i], q[2 * i + 1])) : null;
    }
    const r = t.item.rect, turn = t.item.turn;
    if (!turn || t.item.kind === 2) {
      return [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].flatMap(([x, y]) => this._ptToClient(t.page, x, y));
    }
    const k = this._k(t.page), [cx, cy] = this._ptToClient(t.page, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
    const hw = turn[1] * k / 2, hh = turn[2] * k / 2, a = -turn[0], ca = Math.cos(a), sa = Math.sin(a);
    return [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].flatMap(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
  }
  /** PdfPageView.knobLimits: 60 x 40 px at least, the page side at most, and the page on screen. */
  _knobLimits(page) {
    const r = this._pageCanvases[page].getBoundingClientRect(), pg = this._pages[page], k = this._k(page);
    const ap = this._appearance, f = Number.isFinite(ap.maxItemSizeFraction) ? Math.min(1, Math.max(0.1, ap.maxItemSizeFraction)) : 1;
    return { minW: 60, minH: 40, maxSide: Math.max(pg.w, pg.h) * k * f, pl: r.left, pt: r.top, pr: r.right, pb: r.bottom };
  }
  /** Can the selection be TURNED to any angle — a picture, or a signature made here (not another
   *  app's stamp). @since 3.15.0 */
  get canRotateSelection() {
    const t = this._transformTarget();
    return !!t && (t.kind === "image" || (!!t.item.turn && t.item.kind !== 2));
  }
  /** The selected picture's or signature's angle on screen in degrees, clockwise-positive,
   *  (-180, 180], 0.01 steps; null with nothing selected. @since 3.15.0 */
  get selectionAngle() {
    const c = this._itemCorners(this._transformTarget());
    if (!c) return null;
    let deg = Math.round(Math.atan2(c[3] - c[1], c[2] - c[0]) * 180 / Math.PI * 100) / 100;
    if (deg <= -180) deg += 360;
    return deg;
  }
  /** Turn the selection to |degrees| (clockwise on screen). One undo step. @since 3.15.0 */
  setSelectionAngle(degrees) {
    const now = this.selectionAngle;
    if (now === null || !Number.isFinite(degrees)) return false;
    let d = (degrees - now) % 360;
    if (d <= -180) d += 360; else if (d > 180) d -= 360;
    return Math.abs(d) < 0.01 ? true : this.rotateSelectionBy(d);
  }
  /** Turn the selected picture or signature by |degrees| about its centre, clockwise on screen —
   *  shrunk if it would leave the page. One undo step. False when it cannot turn. @since 3.15.0 */
  rotateSelectionBy(degrees) {
    if (!Number.isFinite(degrees) || !this.canRotateSelection) return false;
    const t = this._transformTarget(), c = this._itemCorners(t), lim = this._knobLimits(t.page);
    const rad = degrees * Math.PI / 180;
    const fit = HandlePolicy.inside(c, lim) ? Math.min(1, HandlePolicy.fitScale(c, rad, lim)) : 1;
    return this._transformSelection(t, fit, -rad);
  }
  /** Resize the selection about its centre, shape kept (60 x 40 px at least, inside the page).
   *  One undo step. @since 3.15.0 */
  resizeSelectionBy(scale) { return this.stretchSelectionBy(scale, scale); }
  /** Scale the selection's own width and height separately about its centre. @since 3.15.0 */
  stretchSelectionBy(scaleX, scaleY) {
    if (!(Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX > 0 && scaleY > 0)) return false;
    const t = this._transformTarget(), c = this._itemCorners(t);
    if (!c) return false;
    const d = HandlePolicy.scaled(c, scaleX, scaleY, this._knobLimits(t.page));
    if (!HandlePolicy.changed(d)) return false;
    const pts = HandlePolicy.corners(c, d);
    return this._applyKnobTransform(t, d.sx, d.sy, 0, [0, 1, 2, 3].flatMap((i) => this._clientToPt(t.page, pts[2 * i], pts[2 * i + 1])));
  }
  /** PdfeEditorView.transformSelection: |scale| and |pageAngle| (radians, CCW in page space). */
  _transformSelection(t, scale, pageAngle) {
    if (t.kind === "ink") {
      if (Math.abs(scale - 1) <= 0.002 || !t.item.nm) return false;
      const r = t.item.rect, cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, hw = (r[2] - r[0]) * scale / 2, hh = (r[3] - r[1]) * scale / 2;
      this._post({ type: "inkTransform", page: t.page, nm: t.item.nm, m: inkBoxMatrix(r, t.item.widthPt / 2, [cx - hw, cy - hh, cx + hw, cy + hh], this._pageUserBox(t.page)),
                   scaleWidth: false, change: "resized" });
      return true;
    }
    if (t.kind === "image") {
      const q = t.item.quad, cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
      const a = scale * Math.cos(pageAngle), b = scale * Math.sin(pageAngle);
      this._post({ type: "imageApplyMatrix", m: [a, b, -b, a, cx - (a * cx - b * cy), cy - (b * cx + a * cy)] });
      return true;
    }
    if (!t.item.nm) return false;
    if (t.item.turn && t.item.kind !== 2) {
      this._post({ type: "stampRotate", page: t.page, nm: t.item.nm, angle: t.item.turn[0] + pageAngle, scale });
      return true;
    }
    if (Math.abs(scale - 1) <= 0.002) return false;
    const r = t.item.rect, cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, hw = (r[2] - r[0]) * scale / 2, hh = (r[3] - r[1]) * scale / 2;
    this._post({ type: "stampSetRect", page: t.page, nm: t.item.nm, rect: [cx - hw, cy - hh, cx + hw, cy + hh] });
    return true;
  }
  /** PdfeEditorView.applyKnobTransform: the new corners |pts| (page points, own order). */
  _applyKnobTransform(t, sx, sy, angle, pts) {
    if (t.kind === "ink") {   // the points follow their box onto the new corners; the width stays
      if (!t.item.nm) return false;
      const xs = [pts[0], pts[2], pts[4], pts[6]], ys = [pts[1], pts[3], pts[5], pts[7]];
      const m = inkBoxMatrix(t.item.rect, t.item.widthPt / 2, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
                             this._pageUserBox(t.page));
      this._post({ type: "inkTransform", page: t.page, nm: t.item.nm, m, scaleWidth: false, change: "resized" });
      return true;
    }
    if (t.kind === "image") {
      const m = HandlePolicy.affine(t.item.quad, pts);
      if (!m) return false;
      this._post({ type: "imageApplyMatrix", m });
      return true;
    }
    if (!t.item.nm) return false;
    if (t.item.turn && t.item.kind !== 2) {
      const centre = [(pts[0] + pts[2] + pts[4] + pts[6]) / 4, (pts[1] + pts[3] + pts[5] + pts[7]) / 4];
      this._post({ type: "stampTransform", page: t.page, nm: t.item.nm, angle: t.item.turn[0] + angle, sx, sy, centre });
      return true;
    }
    const xs = [pts[0], pts[2], pts[4], pts[6]], ys = [pts[1], pts[3], pts[5], pts[7]];
    this._post({ type: "stampSetRect", page: t.page, nm: t.item.nm, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    return true;
  }
  /** The selected item's four corners on screen (CSS px from the editor's top-left; own order
   *  BL, BR, TR, TL; a text box or a mark is its rect), or null. @since 3.15.0 */
  get selectionScreenCorners() {
    let c = this._itemCorners(this._transformTarget());
    if (!c) {
      const r = this.selectionScreenRect;
      if (!r) return null;
      return [r.left, r.top + r.height, r.left + r.width, r.top + r.height, r.left + r.width, r.top, r.left, r.top];
    }
    const box = this.root.getBoundingClientRect();
    return c.map((v, i) => (i % 2 === 0 ? v - box.left : v - box.top));
  }
  /** The top of the selection on screen — where an app's own bar goes: {x, y} CSS px from the
   *  editor's top-left (the highest corner; x the middle of the corners at that height), or null. @since 3.15.0 */
  get selectionTopAnchor() {
    const c = this.selectionScreenCorners;
    if (!c) return null;
    const ys = [c[1], c[3], c[5], c[7]], y = Math.min(...ys);
    const xs = [0, 1, 2, 3].filter((i) => c[2 * i + 1] - y <= 1).map((i) => c[2 * i]);
    return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y };
  }

  // ---- THE KNOBS ON SCREEN (W5c — Android's PdfPageView knobs, the ↘ button, the ×, the pinch) ----

  /** Which knobs a selected PICTURE shows and what each does (Android's imageHandles). Default
   *  PdfeHandleConfig.IMAGE_DEFAULT: corners resize, middles stretch, no ↘ button. @since 3.15.0 */
  get imageHandles() { return this._imageHandles; }
  set imageHandles(v) { this._imageHandles = normalizeHandleConfig(v); this._renderBoxes(); }
  /** The same for a selected SIGNATURE (ours, a reopened one, another app's stamp). Default
   *  PdfeHandleConfig.SIGNATURE_DEFAULT: the ↘ button. @since 3.15.0 */
  get signatureHandles() { return this._signatureHandles; }
  set signatureHandles(v) { this._signatureHandles = normalizeHandleConfig(v); this._signatureHandlesSet = true; this._renderBoxes(); }
  /** The same for a selected DRAWING. Default PdfeHandleConfig.DRAWING_DEFAULT: corners resize,
   *  middles stretch, no ↘ button, no pinch. A drawing never turns, so a turn job resizes (or, a
   *  plain ROTATE, hides the knob). A knob drag is ONE undo step, reported as `drawingchanged`
   *  with what "resized"; the stroke width stays. @since 3.16.0 */
  get drawingHandles() { return this._drawingHandles; }
  set drawingHandles(v) { this._drawingHandles = normalizeHandleConfig(v); this._renderBoxes(); }
  /** True while a finger (or the mouse) is MOVING, RESIZING or TURNING the selection — a drag,
   *  a knob, the ↘ button or a pinch — and, for a picture or signature, until the result is on
   *  the page. Reported by the `selectiongesture` event. @since 3.15.0 */
  get isSelectionGestureActive() { return this._gestureKind !== null; }

  _beginSelectionGesture(kind) {
    if (this._gestureKind !== null) return;
    this._gestureKind = kind || this.selectionKind || "text";
    this._emit("selectiongesture", { active: true, kind: this._gestureKind });
  }
  _endSelectionGesture() {
    const k = this._gestureKind;
    if (k === null) return;
    this._gestureKind = null;
    this._emit("selectiongesture", { active: false, kind: k });
  }

  /** The knob config of what is selected now, the released switches applied (handleCfg). */
  _handleCfg(t) {
    const ap = this._appearance, tf = ap.transformHandleEnabled !== false, corners = ap.showCornerKnobs === true;
    if (t && t.kind === "ink") return HandlePolicy.effective(this._drawingHandles, true, false, corners, tf);
    return t && t.kind === "image" ? HandlePolicy.effective(this._imageHandles, true, false, corners, tf)
      : HandlePolicy.effective(this._signatureHandles, this._signatureHandlesSet, true, corners, tf);
  }
  /** The knobs' look, from the appearance (PdfeAppearance.knob* / transformHandle* / deleteHandle*). */
  _knobLook() {
    const ap = this._appearance;
    return {
      radius: Number.isFinite(ap.knobRadiusDp) ? ap.knobRadiusDp : 7,
      stroke: Number.isFinite(ap.knobStrokeWidthDp) ? ap.knobStrokeWidthDp : 2,
      filled: ap.knobFilled !== false, fill: ap.knobFillColor || "#3f51b5", border: ap.knobBorderColor || "transparent",
      tfColor: ap.transformHandleColor || "#ffffff", tfIcon: ap.transformHandleIcon || null,
      delOn: ap.deleteHandleEnabled === true, delColor: ap.deleteHandleColor || "#e53935", delIcon: ap.deleteHandleIcon || null,
    };
  }
  /** A knob/button's icon: SVG markup or an image URL (the bar's icon rule). */
  _iconEl(icon, size) {
    const s = this._doc.createElement("span");
    s.className = "pdfe-knob-icon";
    s.style.width = s.style.height = `${size}px`;
    if (/^\s*<svg/i.test(icon)) s.innerHTML = icon;
    else { const img = this._doc.createElement("img"); img.src = icon; img.alt = ""; s.append(img); }
    return s;
  }

  /** Draw the selected item's knobs, its ↘ button and its × (strip coords) — never mid-gesture. */
  _renderItemHandles() {
    if (this._itemGesture || this._live || this._draggingBox) return;
    const t = this._transformTarget(), c = this._itemCorners(t);
    if (!c) return;
    const pr = this._pageRect(t.page), cr = this._pageCanvases[t.page].getBoundingClientRect();
    const ox = pr.left - cr.left, oy = pr.top - cr.top;   // client -> strip
    const cfg = this._handleCfg(t), canTurn = this.canRotateSelection, L = this._knobLook();
    const touch = this._lastPointerType !== "mouse";
    const add = (cls, x, y, hit, draw) => {
      const el = this._doc.createElement("div");
      el.className = cls;
      el.style.left = `${x + ox - hit}px`; el.style.top = `${y + oy - hit}px`;
      el.style.width = el.style.height = `${2 * hit}px`;
      if (draw) el.append(draw);
      this.boxesEl.appendChild(el);
      return el;
    };
    for (const p of PDFE_HANDLE_POSITIONS) {
      if (!HandlePolicy.shown(cfg, p, c, L.radius * 6, canTurn)) continue;
      const st = HandlePolicy.style(cfg, p), [x, y] = HandlePolicy.point(c, HandlePolicy.u(p), HandlePolicy.v(p));
      const rad = st.radiusDp ?? L.radius, stroke = st.strokeWidthDp ?? L.stroke, filled = st.filled ?? L.filled;
      const dot = this._doc.createElement("span");
      dot.className = "pdfe-knob-dot";
      dot.style.width = dot.style.height = `${2 * rad}px`;
      const fill = st.fillColor ?? L.fill, border = st.borderColor ?? L.border;
      dot.style.background = filled ? fill : "transparent";
      // hollow: the fill colour is the ring; filled: an optional border ring on top
      dot.style.boxShadow = `inset 0 0 0 ${stroke}px ${filled ? border : fill}`;
      if (st.icon) dot.append(this._iconEl(st.icon, rad * 1.3));
      const el = add("pdfe-knob", x, y, Math.max(rad * 1.5, touch ? 18 : 10), dot);
      el.dataset.knob = p;
      this._listen(el, "pointerdown", (ev) => this._startItemGesture(ev, "knob", p));
    }
    const corner = (x, y) => this._keepOnScreen(x, y, c);
    const btnJob = HandlePolicy.withoutTurn(cfg.cornerButton, canTurn);
    if (btnJob !== "none") {
      const [x, y] = corner(c[2], c[3]);
      const b = this._doc.createElement("span");
      b.className = "pdfe-tfbutton";
      b.style.background = L.tfColor;
      if (L.tfIcon) b.append(this._iconEl(L.tfIcon, 17));
      else {   // the SDK's glyph: a double arrow along centre -> corner, turning with the item
        const ctr = HandlePolicy.point(c, 0.5, 0.5), a = Math.atan2(y - ctr[1], x - ctr[0]) * 180 / Math.PI;
        const dark = this._isLight(L.tfColor) ? "#212121" : "#fff";
        b.innerHTML = `<svg viewBox="-14 -14 28 28" width="28" height="28" style="transform:rotate(${a}deg)" aria-hidden="true">` +
          `<g fill="none" stroke="${dark}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
          `<path d="M-7 0H7M3.5-4.5L7 0 3.5 4.5M-3.5-4.5L-7 0-3.5 4.5"/></g></svg>`;
      }
      const el = add("pdfe-knob pdfe-tfhandle", x, y, touch ? 22 : 14, b);
      this._listen(el, "pointerdown", (ev) => this._startItemGesture(ev, "button"));
    }
    if (L.delOn) {
      const [x, y] = corner(c[6], c[7]);
      const b = this._doc.createElement("span");
      b.className = "pdfe-tfbutton pdfe-delbutton";
      b.style.background = L.delColor;
      if (L.delIcon) b.append(this._iconEl(L.delIcon, 17));
      else b.innerHTML = `<svg viewBox="-14 -14 28 28" width="28" height="28" aria-hidden="true"><path d="M-5-5L5 5M-5 5L5-5" ` +
        `stroke="${this._isLight(L.delColor) ? "#212121" : "#fff"}" stroke-width="2" stroke-linecap="round"/></svg>`;
      const el = add("pdfe-knob pdfe-delhandle", x, y, touch ? 22 : 14, b);
      // A press on the × deletes on the LIFT, and only a lift still on it (deleteHandleHit).
      this._listen(el, "pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); el.dataset.pressed = "1"; });
      this._listen(el, "pointerleave", () => { delete el.dataset.pressed; });
      this._listen(el, "pointercancel", () => { delete el.dataset.pressed; });
      this._listen(el, "pointerup", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (el.dataset.pressed) this.deleteSelection();
      });
    }
  }
  _isLight(css) {
    const ctx = (this._lumCtx ||= this._doc.createElement("canvas").getContext("2d"));
    if (!ctx) return true;
    ctx.fillStyle = "#000"; ctx.fillStyle = css;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(ctx.fillStyle);
    if (!m) return true;   // rgba(): an alpha colour reads as light
    const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
  }
  /** How far the selected item's drawn knobs reach past its edge (largest radius + half its
   *  ring; the × counts too), 0 when it shows none — so the bar can clear them. */
  _selectedKnobReach() {
    const t = this._transformTarget(), c = this._itemCorners(t);
    if (!c) return 0;
    const cfg = this._handleCfg(t), canTurn = this.canRotateSelection, L = this._knobLook();
    let reach = L.delOn ? 14 : 0;
    for (const p of PDFE_HANDLE_POSITIONS) {
      if (!HandlePolicy.shown(cfg, p, c, L.radius * 6, canTurn)) continue;
      const st = HandlePolicy.style(cfg, p);
      reach = Math.max(reach, (st.radiusDp ?? L.radius) + (st.strokeWidthDp ?? L.stroke) / 2);
    }
    return reach;
  }
  /** keepOnScreen: a corner button slides inward until it is whole in the visible area, while
   *  the item is on screen at all. Client px in and out.
   *  shortcut: decided when the knobs are drawn, not on every scroll frame as Android does; a
   *  scroll that cuts the button keeps it cut until the next re-render (any tap, zoom, edit). */
  _keepOnScreen(x, y, c) {
    const r = this.scroller.getBoundingClientRect(), m = 18;
    const xs = [c[0], c[2], c[4], c[6]], ys = [c[1], c[3], c[5], c[7]];
    if (Math.max(...xs) < r.left || Math.min(...xs) > r.right || Math.max(...ys) < r.top || Math.min(...ys) > r.bottom) return [x, y];
    const cl = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
    return [cl(x, r.left + m, r.right - m), cl(y, r.top + m, r.bottom - m)];
  }

  /** A press on a knob ("knob", |pos|) or the ↘ button ("button"): its drag, HandlePolicy's rule,
   *  ONE write on the lift (beginKnobAt / beginTransformAt). */
  _startItemGesture(ev, how, pos) {
    if (ev.button > 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = this._transformTarget(), c = this._itemCorners(t);
    if (!c || this._itemGesture) return;
    const cfg = this._handleCfg(t), canTurn = this.canRotateSelection;
    const job = how === "knob" ? HandlePolicy.job(cfg, pos, canTurn) : HandlePolicy.withoutTurn(cfg.cornerButton, canTurn);
    if (job === "none") return;
    const g = { how, pos, job, t, c, lim: this._knobLimits(t.page), gx: ev.clientX, gy: ev.clientY, d: HandlePolicy.drag(), id: ev.pointerId };
    this._beginItemGesture(g);
    const win = this._win;
    const move = (mv) => {
      if (mv.pointerId !== g.id || this._itemGesture !== g) return;
      mv.preventDefault();
      const ctr = HandlePolicy.point(c, 0.5, 0.5);
      g.d = how === "knob" ? HandlePolicy.dragFrom(c, HandlePolicy.u(pos), HandlePolicy.v(pos), job, g.gx, g.gy, mv.clientX, mv.clientY, g.lim)
        : job === "resize"   // the ↘ resizes about the CENTRE (the reference's gesture), shape kept
          ? HandlePolicy.pinch(c, Math.hypot(mv.clientX - ctr[0], mv.clientY - ctr[1]) / Math.max(1, Math.hypot(g.gx - ctr[0], g.gy - ctr[1])), 0, g.lim)
          : HandlePolicy.dragFrom(c, 1, 0, job, g.gx, g.gy, mv.clientX, mv.clientY, g.lim);
      this._liveDraw(HandlePolicy.corners(c, g.d));
    };
    const up = (uv) => {
      if (uv.pointerId !== g.id) return;
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
      this._finishItemGesture(g, true);
    };
    const cancel = (cv) => { if (cv.pointerId === g.id) { up(cv); } };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
    win.addEventListener("pointercancel", cancel);
    g.unhook = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); win.removeEventListener("pointercancel", cancel); };
  }
  _beginItemGesture(g) {
    this._itemGesture = g;
    this._draggingBox = true;          // the bar, the rotate control and the knobs go
    this._beginSelectionGesture(g.t.kind === "image" ? "image" : this.selectionKind);
    this._renderBoxes();
    this._liveBegin(g.t, g.c);
    this._liveDraw(g.c);
  }
  /** The lift (or a pinch's end): commit |g.d| once; nothing changed -> back as it was. */
  _finishItemGesture(g, apply) {
    if (this._itemGesture !== g) return;
    g.unhook?.();
    this._itemGesture = null;
    const t = g.t, d = g.d;
    let ok = false;
    if (apply && HandlePolicy.changed(d)) {
      if (g.how === "knob") {
        const pts = HandlePolicy.corners(g.c, d);
        ok = this._applyKnobTransform(t, d.sx, d.sy, -d.angle, [0, 1, 2, 3].flatMap((i) => this._clientToPt(t.page, pts[2 * i], pts[2 * i + 1])));
      } else ok = this._transformSelection(t, d.sx, -d.angle);
    }
    if (ok) this._itemCommitPending();
    else { this._liveEnd(); this._draggingBox = false; this._renderBoxes(); this._endSelectionGesture(); }
  }
  /** A move/resize/turn was written: the live copy stays where it was dropped until the result
   *  lands (_settleItemGesture), then the bar shows once at the new place. */
  _itemCommitPending() {
    clearTimeout(this._settleTimer);
    if (this._live) this._live.pending = true;
    this._settleTimer = setTimeout(() => this._settleItemGesture(), 2000);   // a reply that never came
  }
  /** The result of a picture/signature/box gesture landed (or failed): drop the live copy just
   *  after the page under it repaints, and report the gesture's end. */
  _settleItemGesture() {
    if (!(this._live && this._live.pending) && this._gestureKind === null) return;
    clearTimeout(this._settleTimer);
    this._draggingBox = false;
    if (this._live) {
      const live = this._live;
      // A moment later: the worker's canvas presents the committed render first, then the copy
      // goes. A timer, not animation frames — a hidden tab holds frames back, and the knobs with them.
      setTimeout(() => { if (this._live === live) { this._liveEnd(); this._renderBoxes(); } }, 60);
    }
    this._endSelectionGesture();
  }

  /** Two fingers on the selected item (its pinch job not "none"): a resize (and turn) of it,
   *  instead of zooming the page (beginPinchTransform). True when it took the pinch. */
  _maybeItemPinch(touches) {
    const t = this._transformTarget(), c = this._itemCorners(t);
    if (!c || this._itemGesture) return false;
    const cfg = this._handleCfg(t), job = HandlePolicy.withoutTurn(cfg.pinch, this.canRotateSelection);
    if (job === "none") return false;
    const mx = (touches[0].clientX + touches[1].clientX) / 2, my = (touches[0].clientY + touches[1].clientY) / 2;
    if (!pointInQuad(c, mx, my)) return false;
    const ang = (ts) => Math.atan2(ts[1].clientY - ts[0].clientY, ts[1].clientX - ts[0].clientX);
    const dist = (ts) => Math.hypot(ts[1].clientX - ts[0].clientX, ts[1].clientY - ts[0].clientY);
    const g = { how: "pinch", job, t, c, lim: this._knobLimits(t.page), d: HandlePolicy.drag(), dist0: Math.max(1, dist(touches)), ang0: ang(touches) };
    g.move = (ts) => {
      g.d = HandlePolicy.pinch(c, dist(ts) / g.dist0, job === "resizeAndRotate" ? ang(ts) - g.ang0 : 0, g.lim);
      this._liveDraw(HandlePolicy.corners(c, g.d));
    };
    this._beginItemGesture(g);
    return true;
  }

  // ---- THE LIVE DRAG: the item itself follows the finger, not an outline (user 2026-11-05, the
  // reference app's behaviour). One canvas over the visible area; the page behind the item and
  // the item's own pixels come from the worker (liveItem), prefetched once a selection settles.

  /** The worker request for |t| at the page's current pixels: {key, msg}, or null. */
  _liveRequest(t, c) {
    const canvas = this._pageCanvases[t.page], pg = this._pages[t.page];
    if (!canvas || !pg || !c) return null;
    const cr = canvas.getBoundingClientRect();
    let k = this._dpr || 1;
    if (cr.width * cr.height * k * k > 5e6) k = Math.sqrt(5e6 / (cr.width * cr.height));
    const w = Math.round(cr.width * k), h = Math.round(cr.height * k);
    const quad = c.map((v, i) => (i % 2 === 0 ? (v - cr.left) : (v - cr.top)) * k);
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    const box = [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2];
    const image = t.kind === "image" ? t.item.index : -1, nm = t.kind === "image" ? null : t.item.nm;
    if (t.kind !== "image" && !nm) return null;
    const key = [t.page, image, nm, w, h, quad.map((v) => Math.round(v)).join(",")].join("|");
    return { key, k, msg: { type: "liveItem", page: t.page, w, h, image, nm, quad, box } };
  }
  /** Ask for the live copy of the selection ahead of a grab (debounced, once per selection). */
  _liveSchedulePrefetch() {
    if (this._itemGesture || this._live) return;
    const t = this._transformTarget(), req = t && this._liveRequest(t, this._itemCorners(t));
    if (!req) return;
    if (this._livePrefetch && this._livePrefetch.key === req.key) return;
    this._livePrefetch = { key: req.key, ready: null, seq: 0 };
    clearTimeout(this._livePrefetchTimer);
    this._livePrefetchTimer = setTimeout(() => {
      const pre = this._livePrefetch;
      if (!pre || pre.key !== req.key || this._itemGesture) return;
      pre.seq = this._liveSeq = (this._liveSeq || 0) + 1;
      this._post({ ...req.msg, seq: pre.seq });
    }, 120);
  }
  _liveBegin(t, c) {
    const req = this._liveRequest(t, c);
    if (!req) return;
    const el = this.liveEl, sc = this.scroller;
    el.style.left = `${sc.scrollLeft - (this._stripLeft || 0)}px`;
    el.style.top = `${sc.scrollTop - (this._stripTop || 0)}px`;
    el.style.width = `${sc.clientWidth}px`; el.style.height = `${sc.clientHeight}px`;
    const dpr = this._dpr || 1;
    el.width = Math.round(sc.clientWidth * dpr); el.height = Math.round(sc.clientHeight * dpr);
    el.style.display = "block";
    const st = this._win.getComputedStyle(this.root), v = (n, d) => st.getPropertyValue(n).trim() || d;
    const colors = { sel: v("--pdfe-sel-border", "#03a9f4"), ghost: v("--pdfe-ghost-border", "#03a9f4"), ghostFill: v("--pdfe-ghost-fill", "#03a9f41f") };
    this._live = { t, c, req, ready: null, corners: c, pending: false, colors };
    const pre = this._livePrefetch;
    if (pre && pre.key === req.key && pre.ready) this._live.ready = pre.ready;
    else {
      this._live.seq = this._liveSeq = (this._liveSeq || 0) + 1;
      this._post({ ...req.msg, seq: this._live.seq });
    }
  }
  _onLiveItem(msg) {
    const ready = msg.ok ? { bg: msg.bg, item: msg.item, box: msg.box } : null;
    const pre = this._livePrefetch;
    if (pre && pre.seq === msg.seq) pre.ready = ready;
    const live = this._live;
    if (live && (live.seq === msg.seq || (pre && pre.seq === msg.seq && pre.key === live.req.key))) {
      live.ready = ready;
      this._liveDraw(live.corners);
    }
  }
  /** Paint the item at its new corners |to| (client px, own order): the page behind it where it
   *  was, the item carried by the affine c -> to; an outline until the pixels arrive. */
  _liveDraw(to) {
    const live = this._live, el = this.liveEl;
    if (!live || !to) return;
    live.corners = to;
    const ctx = el.getContext("2d"), dpr = this._dpr || 1, or = el.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    const path = (q) => { ctx.beginPath(); for (let i = 0; i < 4; i++) ctx[i ? "lineTo" : "moveTo"](q[2 * i] - or.left, q[2 * i + 1] - or.top); ctx.closePath(); };
    const r = live.ready, canvas = this._pageCanvases[live.t.page];
    const cs = live.colors;
    if (r && canvas) {
      const cr = canvas.getBoundingClientRect(), k = live.req.k, [bx0, by0, bx1, by1] = r.box;
      const place = () => ctx.drawImage(r.item, cr.left + bx0 / k - or.left, cr.top + by0 / k - or.top, (bx1 - bx0) / k, (by1 - by0) / k);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Night mode (W6): the copy is page pixels, so it is inverted like the page; the outline is not.
      ctx.filter = this._nightMode ? "invert(1)" : "none";
      // where it was: the page without it
      ctx.drawImage(r.bg, cr.left + bx0 / k - or.left, cr.top + by0 / k - or.top, (bx1 - bx0) / k, (by1 - by0) / k);
      const m = HandlePolicy.affine(live.c.map((v, i) => v - (i % 2 ? or.top : or.left)), to.map((v, i) => v - (i % 2 ? or.top : or.left)));
      if (m) {
        ctx.save();
        ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
        path(live.c); ctx.clip();
        place();
        ctx.restore();
      }
      ctx.filter = "none";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      path(to);
      ctx.lineWidth = 2;
      ctx.strokeStyle = cs.sel;
      ctx.stroke();
    } else {   // no pixels yet (or a huge item): the ghost outline
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      path(to);
      ctx.fillStyle = cs.ghostFill;
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = cs.ghost;
      ctx.stroke();
    }
    // The move ghost is the fallback only: with the item's own pixels on screen it would double it.
    if (r) this.moveGhostEl.style.display = "none";
  }
  /** A MOVE of the selected picture/signature by (dxPt, dyPt) page points: the live copy shifts. */
  _liveMove(page, dxPt, dyPt) {
    const live = this._live;
    if (!live) return;
    const a = this._ptToClient(page, 0, 0), b = this._ptToClient(page, dxPt, dyPt), dx = b[0] - a[0], dy = b[1] - a[1];
    this._liveDraw(live.c.map((v, i) => v + (i % 2 ? dy : dx)));
  }
  _liveEnd() {
    this._live = null;
    const el = this.liveEl;
    if (!el) return;
    el.style.display = "none";
    el.width = el.height = 0;
  }

  // ---- THE READER (W6a — Android's linksEnabled / nightMode / scrollEnabled / pageSpacingDp /
  // zoomConfig, same names, same defaults but the web's own resting zoom limits) ---------------

  /** LINKS in reading (view) mode: a tap on a link to another page scrolls there (animated); a
   *  tap on a web address emits `linktapped` {uri} and opens nothing. `false` = links are plain
   *  page (a tap is a `pagetap`). Text and annotate modes never follow links. Default `true`. @since 3.15.0 */
  get linksEnabled() { return this._linksEnabled; }
  set linksEnabled(v) { this._linksEnabled = !!v; }
  /** The topmost link under page point (xPt, yPt), or null. */
  _linkAt(page, xPt, yPt) {
    if (!this._linksEnabled || this._mode !== "view" || page == null) return null;
    const list = this._pageLinks.get(page) || [];
    for (let i = list.length - 1; i >= 0; i--) if (this._inBounds(list[i].rect, { xPt, yPt })) return list[i];
    return null;
  }
  /** NIGHT MODE: the pages are drawn with their colours inverted — the document and a save are
   *  untouched. Default `false`. Pair it with setBackgroundColor for the surround. @since 3.15.0 */
  get nightMode() { return this._nightMode; }
  set nightMode(v) { this._nightMode = !!v; this.root?.classList.toggle("pdfe-night", this._nightMode); }
  /** `false`: a drag, a swipe or the wheel does not move the pages (a floating mini-player).
   *  Pinch, taps and goToPage / scrollToPosition still work. Default `true`. @since 3.15.0 */
  get scrollEnabled() { return this._scrollEnabled; }
  set scrollEnabled(v) { this._scrollEnabled = !!v; this.root?.classList.toggle("pdfe-noscroll", !this._scrollEnabled); }
  /** The gap between pages in CSS px (0–64, clamped). The page in view stays put. Default 8. @since 3.15.0 */
  get pageSpacingDp() { return this._pageSpacingDp; }
  set pageSpacingDp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const next = Math.min(64, Math.max(0, n));
    if (next === this._pageSpacingDp) return;
    this._pageSpacingDp = next;
    if (!this.root) return;
    if (!this._pageOffsets.length && this._pageCanvases.length) this._measurePageOffsets();
    const p = this._currentPage, before = this._pageOffsets[p] ? this._pageSpan(p)[0] : null;
    this.root.style.setProperty("--pdfe-gap", `${next}px`);
    if (!this._pageCanvases.length) return;
    this._measurePageOffsets();
    if (before != null) {
      const d = this._pageSpan(p)[0] - before;
      if (this._scrollDirection === "horizontal") this.scroller.scrollLeft += d;
      else this.scroller.scrollTop += d;
    }
    this._repositionOverlays();
    this._renderBoxes();
    this._updateCurrentPage();
  }
  /** CSS px per PDF point on |page| now (W6b: each page has its own fit scale). */
  _k(page) {
    return ((this._fitScales && this._fitScales[page]) || this._fitScale) * this._zoom;
  }
  /** The scroll position and the view's length along the way the pages run. */
  _scrollAxis() {
    const sc = this.scroller;
    return this._scrollDirection === "horizontal" ? [sc.scrollLeft, sc.clientWidth] : [sc.scrollTop, sc.clientHeight];
  }
  /** Page |i|'s start and length along that axis, in the scroller's own coordinates. */
  _pageSpan(i) {
    const o = this._pageOffsets[i];
    return this._scrollDirection === "horizontal" ? [(this._stripLeft || 0) + o[2], o[3]] : [o[0], o[1]];
  }
  _applyLayoutClasses() {
    const h = this._scrollDirection === "horizontal";
    this.strip?.classList.toggle("pdfe-h", h);
    this.root?.classList.toggle("pdfe-hscroll", h);
    this.root?.classList.toggle("pdfe-snap", this._pageSnap && !this._zoomAnim && !this._pinch);
  }
  /** Re-fit every page after a layout switch, keeping the page the user is on in view. */
  _relayout(resetZoom) {
    if (!this.root) return;
    const page = this._currentPage;
    this._applyLayoutClasses();
    if (!this._pages.length) return;
    if (resetZoom) this._zoom = 1;
    this._computeFitScale();
    this._applyZoom();
    this._repositionOverlays();
    this.goToPage(page);
    if (resetZoom) this._emit("zoom", { zoom: this._zoom });
  }
  /** WHICH WAY THE PAGES RUN: "vertical" (top to bottom, the default) or "horizontal" (left to
   *  right, each page fitted into the view). Changing it keeps the page the user is on in view and
   *  resets the zoom to fit. Every mode works in both. @since 3.15.0 */
  get scrollDirection() { return this._scrollDirection; }
  set scrollDirection(v) {
    const next = v === "horizontal" ? "horizontal" : "vertical";
    if (next === this._scrollDirection) return;
    this._scrollDirection = next;
    this._relayout(true);
  }
  /** PAGE SNAPPING: `true` = a swipe stops on a whole page, centred, and each page fits the view;
   *  zoomed in past the view, the page pans freely. Default `false`. @since 3.15.0 */
  get pageSnap() { return this._pageSnap; }
  set pageSnap(v) {
    if (!!v === this._pageSnap) return;
    this._pageSnap = !!v;
    this._relayout(false);
  }
  /** UNIFORM PAGE WIDTH: `true` (default) = every page as wide as the view; `false` = one
   *  document-wide scale (the widest page fits, narrower ones look narrower). Vertical free
   *  scrolling only — sideways or snapping, each page already fits the view. @since 3.15.0 */
  get uniformPageWidth() { return this._uniformPageWidth; }
  set uniformPageWidth(v) {
    if (!!v === this._uniformPageWidth) return;
    this._uniformPageWidth = !!v;
    this._relayout(false);
  }
  /** HOW ZOOM BEHAVES — the resting limits, the stretch past them and its glide back,
   *  double-tap, the coast after a thrown pinch. Impossible values are corrected; read it back to
   *  see what applies. Setting it moves minZoom / maxZoom too. @since 3.15.0 */
  get zoomConfig() {
    if (this.minZoom !== this._zoomConfig.minZoom || this.maxZoom !== this._zoomConfig.maxZoom)   // a host set the fields
      this._zoomConfig = normalizeZoomConfig({ ...this._zoomConfig, minZoom: this.minZoom, maxZoom: this.maxZoom }, this);
    return this._zoomConfig;
  }
  set zoomConfig(v) {
    this._zoomConfig = normalizeZoomConfig(v, { minZoom: 0.25, maxZoom: 3 });
    this.minZoom = this._zoomConfig.minZoom;
    this.maxZoom = this._zoomConfig.maxZoom;
    if (this._zoom < this.minZoom || this._zoom > this.maxZoom) this.setZoom(this._zoom);
  }
  /** The zoom without the resting clamp (a pinch's stretch, a glide): only [lo, hi]. */
  _setZoomRaw(z, lo, hi) {
    const next = Math.min(hi, Math.max(lo, z));
    if (!Number.isFinite(next) || next === this._zoom) return;
    this._zoom = next;
    this._applyZoom();
    this._repositionOverlays();
    this._emit("zoom", { zoom: next });
  }
  /** Glide the zoom to |target| over |ms| along |curve|, keeping the page point under (cx, cy) there. */
  _animateZoom(target, ms, cx, cy, curve = PinchZoom.spring) {
    this._stopZoomAnim();
    const from = this._zoom, lo = Math.min(from, target), hi = Math.max(from, target);
    const anchor = this._pagePointAt(cx, cy) || this._nearestPagePoint(cx, cy);
    const step = (z) => { this._setZoomRaw(z, lo, hi); if (anchor) this._scrollPagePointTo(anchor, cx, cy); };
    if (!(ms > 0)) { step(target); return; }
    const t0 = performance.now(), anim = { id: 0 };
    const frame = () => {
      if (this._zoomAnim !== anim || this._destroyed) return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      step(from + (target - from) * curve(t));
      if (t < 1) anim.id = this._win.requestAnimationFrame(frame);
      else { this._zoomAnim = null; this._applyLayoutClasses(); }
    };
    this._zoomAnim = anim;
    this._applyLayoutClasses();     // snapping waits until the glide is over
    anim.id = this._win.requestAnimationFrame(frame);
  }
  _stopZoomAnim() {
    if (this._zoomAnim) { this._win.cancelAnimationFrame(this._zoomAnim.id); this._zoomAnim = null; this._applyLayoutClasses(); }
  }
  /** The fingers left a pinch at (cx, cy): spring back inside the limits, or coast on a throw. */
  _endPinchZoom(cx, cy) {
    const zc = this.zoomConfig, z = this._zoom, rest = PinchZoom.restingTarget(z, zc.minZoom, zc.maxZoom);
    if (rest != null) { this._animateZoom(rest, zc.springBackDurationMs, cx, cy, PinchZoom.spring); return; }
    if (!zc.pinchMomentum) return;
    // the speed over the last ~80 ms; a pinch held still before the lift does not coast
    const now = performance.now(), s = (this._pinchSamples || []).filter((x) => now - x.t <= 80);
    if (s.length < 2 || now - s[s.length - 1].t > 50) return;
    const v = (Math.log(s[s.length - 1].z) - Math.log(s[0].z)) / ((s[s.length - 1].t - s[0].t) / 1000 || 1);
    const target = PinchZoom.momentumTarget(z, v, zc.minZoom, zc.maxZoom, zc.pinchMomentumDurationMs);
    if (target != null) this._animateZoom(target, zc.pinchMomentumDurationMs, cx, cy, PinchZoom.coast);
  }

  // ---- THE MAGNIFIER (W7b — Android's drag loupe, PdfeAppearance.magnifier*) -------------------
  // A finger hides what it drags, so while a FINGER (never a mouse) drags a selection knob, the
  // caret thumb or a drag-selection, a loupe above it shows the page under it, enlarged. The page
  // canvases belong to the worker, so the pixels come from it (one region render per frame, one in
  // flight). Defaults are Android's own: 100 x 48 px, x1.25, a 2 px corner, a 4 px shadow, 42 px above.
  // shortcut: page pixels only — the selection's tint and the caret are not drawn into the loupe;
  // draw them in too if users ask where the selection end is.

  /** Show the loupe for the point (cx, cy) on |page| — touch/pen only, when the look allows it. */
  _loupeAt(ev, page, cx, cy) {
    const ap = this._appearance;
    if (ap.magnifierEnabled === false || !ev || ev.pointerType === "mouse" || page == null || page < 0) return;
    const canvas = this._pageCanvases[page];
    if (!canvas) return;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const w = Math.max(16, num(ap.magnifierWidthDp, 100)), h = Math.max(16, num(ap.magnifierHeightDp, 48));
    const zoom = Math.max(1, num(ap.magnifierZoom, 1.25));
    const el = this.loupeEl;
    const pr = this._pageRect(page), cr = canvas.getBoundingClientRect();
    const ox = pr.left - cr.left, oy = pr.top - cr.top;         // client -> strip
    let lx = cx + ox + num(ap.magnifierOffsetXDp, 0) - w / 2;
    let ly = cy + oy + num(ap.magnifierOffsetYDp, -42) - h / 2;
    if (ap.magnifierClippingEnabled !== false) {                 // keep it inside the visible area
      const sc = this.scroller, vx0 = sc.scrollLeft - (this._stripLeft || 0), vy0 = sc.scrollTop - (this._stripTop || 0);
      lx = Math.min(Math.max(lx, vx0 + 2), vx0 + sc.clientWidth - w - 2);
      ly = Math.min(Math.max(ly, vy0 + 2), vy0 + sc.clientHeight - h - 2);
    }
    el.style.display = "block";
    el.style.left = `${lx}px`; el.style.top = `${ly}px`;
    el.style.width = `${w}px`; el.style.height = `${h}px`;
    el.style.borderRadius = `${num(ap.magnifierCornerRadiusDp, 2)}px`;
    const elev = num(ap.magnifierElevationDp, 4);
    el.style.boxShadow = elev > 0 ? `0 ${elev / 2}px ${elev * 2}px #0006` : "none";
    if (!el.firstChild) el.append(this._doc.createElement("canvas"), this._doc.createElement("div"));
    el.lastChild.style.background = ap.magnifierOverlayColor || "transparent";
    // what to render: the region of the displayed page around the point, at zoom x the page's scale
    const dpr = this._dpr || 1, scale = this._k(page) * zoom * dpr;
    const vx = (cx - cr.left) / this._k(page), vy = (cy - cr.top) / this._k(page);   // view points
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    this._loupeWant = { page, scale, x: Math.round(vx * scale - pw / 2), y: Math.round(vy * scale - ph / 2), w: pw, h: ph };
    this._loupePump();
  }
  _loupePump() {
    if (this._loupeBusy || !this._loupeWant) return;
    const want = this._loupeWant;
    this._loupeWant = null;
    this._loupeBusy = true;
    this._loupeSeq = (this._loupeSeq || 0) + 1;
    this._post({ type: "loupe", seq: this._loupeSeq, ...want });
  }
  _onLoupe(msg) {
    this._loupeBusy = false;
    const el = this.loupeEl;
    if (msg.ok && el.style.display !== "none" && el.firstChild) {
      const c = el.firstChild;
      if (c.width !== msg.bitmap.width) c.width = msg.bitmap.width;
      if (c.height !== msg.bitmap.height) c.height = msg.bitmap.height;
      const ctx = c.getContext("2d");
      ctx.filter = this._nightMode ? "invert(1)" : "none";
      ctx.drawImage(msg.bitmap, 0, 0);
    }
    if (msg.bitmap) msg.bitmap.close?.();
    this._loupePump();
  }
  _loupeHide() {
    this._loupeWant = null;
    if (this.loupeEl) this.loupeEl.style.display = "none";
  }

  // ---- INSERT A PICTURE (W5a — Android's names, PdfeEditorView.insertImage*) -------------

  /** The point in the middle of what the reader sees: {page, xPt, yPt} in that page's own PDF
   *  points (clamped into the page), or null with no document. */
  visibleCenter() {
    if (!this._pages.length) return null;
    const v = this.scroller.getBoundingClientRect();
    const cx = v.left + v.width / 2, cy = v.top + v.height / 2;
    let page = -1, best = Infinity;
    this._pageCanvases.forEach((c, p) => {
      if (!c) return;
      const r = c.getBoundingClientRect();
      const d = this._scrollDirection === "horizontal"     // W6b: sideways, the page across the middle
        ? (cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0)
        : (cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0);
      if (d < best) { best = d; page = p; }
    });
    if (page < 0) return null;
    const r = this._pageCanvases[page].getBoundingClientRect(), k = this._k(page);
    const [x, y] = this._viewToPt(page, (cx - r.left) / k, (cy - r.top) / k);
    const box = this._pageUserBox(page);
    return { page, xPt: Math.min(Math.max(x, box[0]), box[2]), yPt: Math.min(Math.max(y, box[1]), box[3]) };
  }
  /** Put a picture on the page in view, centred on what the reader sees: half the page, upright,
   *  selected, one undo step; switches to text mode. ImageData, a canvas, an ImageBitmap or a
   *  loaded <img>; a side over 2048 px is scaled down; the pixels are copied. False when nothing
   *  could be placed. Until a save the picture is NOT in the document, so deleting it leaves no
   *  pixels anywhere. @since 3.15.0 */
  insertImage(image) {
    const c = this.visibleCenter();
    return !!c && this.insertImageAt(image, c.page, c.xPt, c.yPt);
  }
  /** insertImageAt(image, xPt, yPt) on the page in view, or insertImageAt(image, page, xPt, yPt):
   *  the picture centred there (moved inside the page, never shrunk for it). @since 3.15.0 */
  insertImageAt(image, a, b, c) {
    let page, xPt, yPt;
    if (c === undefined) { const v = this.visibleCenter(); if (!v) return false; page = v.page; xPt = a; yPt = b; }
    else { page = a; xPt = b; yPt = c; }
    if (!Number.isInteger(page) || page < 0 || page >= this._pages.length || !Number.isFinite(xPt) || !Number.isFinite(yPt)) return false;
    const img = this._fittedImage(image);
    return !!img && this._insertAt(img, page, xPt, yPt);
  }
  /** Arm a picture: the next tap in text mode places it there (switches to text mode now).
   *  A picture that cannot be read → `error` insert-failed. Reports `imageinserting`. @since 3.15.0 */
  armInsertImage(image) {
    const img = this._fittedImage(image);
    if (!img) { this._emit("error", errorEvent("insert-failed", "Couldn't add this picture")); return; }
    if (this._mode !== "text") this.setMode("text");
    this._setInsertArmed(img);
  }
  /** Drop an armed picture. Safe when nothing is armed. @since 3.15.0 */
  cancelInsertImage() { this._setInsertArmed(null); }
  /** A picture is armed and waiting for a tap. @since 3.15.0 */
  get isInsertingImage() { return !!this._armedImage; }

  _setInsertArmed(img) {
    const was = !!this._armedImage;
    this._armedImage = img;
    if (was === !!img) return;
    this._post({ type: "armInsertImage", armed: !!img });
    this._emit("imageinserting", { armed: !!img });
  }
  /** A copy of |image| as ImageData, its longer side at most 2048 px (MAX_INSERT_SIDE_PX). */
  _fittedImage(image) {
    const d = this._imageDataOf(image);
    if (!d || !d.width || !d.height) return null;
    const side = Math.max(d.width, d.height);
    if (side <= 2048) return d;
    const k = 2048 / side, w = Math.max(1, Math.floor(d.width * k)), h = Math.max(1, Math.floor(d.height * k));
    const src = this._doc.createElement("canvas"); src.width = d.width; src.height = d.height;
    src.getContext("2d").putImageData(d, 0, 0);
    const dst = this._doc.createElement("canvas"); dst.width = w; dst.height = h;
    const g = dst.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }
  /** PdfPageView.insertMatrix + PdfeEditorView.insertSnapshotAt: half the DISPLAYED page, upright,
   *  centred on the point and moved inside the page. */
  _insertAt(img, page, xPt, yPt) {
    const pg = this._pages[page];
    if (!pg) return false;
    const k = Math.min(pg.w / img.width, pg.h / img.height) / 2;
    const hw = img.width * k / 2, hh = img.height * k / 2;
    const [cx, cy] = this._ptToView(page, xPt, yPt);
    const vx = Math.min(Math.max(cx, hw), Math.max(hw, pg.w - hw));
    const vy = Math.min(Math.max(cy, hh), Math.max(hh, pg.h - hh));
    const bl = this._viewToPt(page, vx - hw, vy + hh), br = this._viewToPt(page, vx + hw, vy + hh),
          tl = this._viewToPt(page, vx - hw, vy - hh);
    const m = [br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]];
    if (this._mode !== "text") this.setMode("text");
    this.getOutOfBoxEditing();
    const px = new Uint8ClampedArray(img.data);
    this._post({ type: "insertImage", page, m, width: img.width, height: img.height, pixels: px }, [px.buffer]);
    return true;
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
  deleteSelection() {
    if (this._selectedInk) { this._deleteSelectedInk(); return; }
    if (this._selectedStamp) { this._deleteSelectedStamp(); return; }
    if (this._selectedMark) { this._deleteSelectedMark(); return; }
    if (this._selected || this._selectedImage) this._post({ type: "deleteSelected" });
  }
  /** Drop the selection (the tap-on-empty-space gesture) — a mark and page text too. */
  clearSelection() {
    if (this._selectedInk) this._setSelectedInk(null);
    if (this._selectedMark) this._setSelectedMark(null);
    if (this._selectedStamp) this._setSelectedStamp(null);
    if (this._pageSel) this._clearPageSel();
    if (this._selected || this._selectedImage) this._post({ type: "deselect" });
  }
  /**
   * Select ALL the text of the box being typed in (the open run) — the host's
   * "Select all" button. Text mode only, and only while a box is open; an empty
   * box has nothing to select. The keyboard is left exactly as it is (focus is not
   * touched, so iOS does not drop it) and the selection gets the usual highlight
   * and start/end handles, because it takes the same path as Ctrl/Cmd+A and a
   * long-press. Returns true when a selection was made. Since 3.1.0.
   */
  selectAllText() {
    if (this._mode !== "text" || this._editingPage < 0) return false;
    return this._selectAllInRun();
  }
  /** The one select-all path: Ctrl/Cmd+A and selectAllText() both land here. */
  _selectAllInRun() {
    const len = this.sink.value.length;
    if (!len) return false;                 // empty run: stay a collapsed caret
    this.sink.setSelectionRange(0, len);
    this._post({ type: "selectRange", start: 0, end: len });
    return true;
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
  /** Where the rotate control lives: "both" | "handle" | "bar" | "none". */
  get imageRotateControl() { return this._imageRotateControl; }

  /**
   * Move the rotate control, or take it away. An unrecognised value is ignored
   * rather than thrown — nothing crosses this SDK's boundary as an exception.
   */
  setImageRotateControl(where) {
    if (!PDFE_ROTATE_CONTROLS.includes(where)) return;
    this._imageRotateControl = where;
    // Hide it NOW rather than at the next render: a host that switches the control
    // off while a picture is selected must not be left looking at the old one.
    if (this.rotateBtn) this.rotateBtn.style.display = "none";
    this._renderBoxes();
  }

  /** Does the selected picture's action bar offer Delete? Default true. 3.1.0. */
  get imageDeleteControl() { return this._imageDeleteControl; }

  /**
   * Show or hide Delete in a PICTURE's action bar (3.1.0). `deleteSelection()`
   * works either way; a text box's bar keeps its Delete. With neither Delete nor a
   * bar Rotate left, the picture gets no bar at all.
   */
  setImageDeleteControl(on) {
    this._imageDeleteControl = !!on;
    this._renderBoxes();
  }

  // ---- the client's own design: buttons and look (3.3.0) -------------------

  /** The look last given to setAppearance (only the fields that were set). */
  get appearance() { return { ...this._appearance }; }

  /**
   * THE LOOK of what the SDK draws over the page — box outlines, the selection, the
   * knobs, the move ghost, the rotate control and the action bar. Every field is
   * optional and defaults to today's look; the names are Android's PdfeAppearance's.
   * Colours are CSS colours ("#7c3aed", "#7c3aed1a"); sizes are CSS pixels.
   * Replaces the whole look (pass the same object with one field changed to tweak one).
   */
  setAppearance(a) {
    this._appearance = { ...(a || {}) };
    const st = this.root.style;
    for (const [field, v] of Object.entries(PDFE_APPEARANCE_VARS)) {
      const val = this._appearance[field];
      if (val === undefined || val === null) { st.removeProperty(v); continue; }
      st.setProperty(v, typeof val === "number" ? `${val}px` : String(val));
    }
    const ap = this._appearance;
    if (ap.boxBorderDashed === false) st.setProperty("--pdfe-box-style", "solid");
    else st.removeProperty("--pdfe-box-style");
    if (ap.editingBorderDashed === true) st.setProperty("--pdfe-edit-style", "dashed");   // W7a
    else st.removeProperty("--pdfe-edit-style");
    this._drawEditBox(this._lastEditBounds);      // the open box's knobs / move button follow the look
    this._drawCaret(this._lastCaretGeom);
    if (ap.barTextBold === false) st.setProperty("--pdfe-bar-weight", "400");
    else st.removeProperty("--pdfe-bar-weight");
    this.root.classList.toggle("pdfe-nooutlines", ap.showBoxOutlines === false);
    for (const el of [this.actionsEl, this.selMenuEl]) {
      el.classList.toggle("pdfe-icontop", ap.barIconPosition === "top");
      el.classList.toggle("pdfe-dividers", ap.barDividers === true);
    }
    this._menuKey = null;
    this._actionsKey = null;
    this._renderBoxes();
  }

  /**
   * WHICH BUTTONS the action bar shows for one kind — "text" or "image" — in this
   * order (a repeated id is dropped). Each is {id, label?, icon?}: the SDK's own ids
   * are "edit", "copy", "delete", "rotate"; any other id is the app's own button
   * (e.g. {id: "ai", label: "Edit with AI", icon: "<svg …>"} — icon is SVG markup or an
   * image URL). A tap on any of them emits "action" first. A built-in shows only where
   * it can act; an empty list hides the bar for that kind.
   */
  setActions(kind, actions) {
    const seen = new Set();
    this._actionsByKind.set(String(kind), (actions || []).filter((a) => {
      const id = a && String(a.id || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map((a) => ({ id: String(a.id), label: a.label ?? null, icon: a.icon ?? null })));
    this._actionsKey = null;
    this._menuKey = null;
    this._renderBoxes();
    this._syncSelectionMenu();
  }

  /** The buttons |kind|'s bar offers: what setActions set, or the default
   *  (text: edit, delete · image: rotate, delete). */
  actions(kind) {
    if (kind === "pagetext") {
      const own = this._mode === "annotate" ? this._annotateSelectionMenuActions : this._viewSelectionMenuActions;
      const list = own || this._actionsByKind.get("pagetext") ||
        this._selectionMenuItems.map((id) => ({ id, label: null, icon: null }));
      return list.map((a) => ({ ...a }));
    }
    const set = this._actionsByKind.get(String(kind));
    if (set) return set.map((a) => ({ ...a }));
    // "markup" (a selected mark) falls to the last case: Delete, as on Android.
    // ActionPolicy.defaults: a picture offers Left · Right · Delete; a host that chose the bar's
    // one Rotate button (imageRotateControl "bar" / "both") keeps Rotate · Delete.
    return (kind === "text" ? ["edit", "delete"]
      : kind === "image" ? (this._rotateBarShown() ? ["rotate", "delete"] : ["rotate_left", "rotate_right", "delete"]) : ["delete"])
      .map((id) => ({ id, label: null, icon: null }));
  }

  /** Does the SDK draw its action bar over a selected item? Default true. */
  get actionBarEnabled() { return this._actionBarEnabled; }
  /** Off: the SDK draws no bar; the app draws its own at selectionScreenRect and calls
   *  performAction for the SDK's actions. */
  setActionBarEnabled(on) {
    this._actionBarEnabled = !!on;
    this._renderBoxes();
  }

  /**
   * The app's OWN action bar element, or null for the SDK's. The SDK only places it
   * over the selection and hides it; each button with data-pdfe-action="<id>" is
   * shown for the kinds whose actions list it, and a tap emits "action" first.
   */
  setActionBarElement(el) {
    this._actionBarElement = el || null;
    this._actionsKey = null;
    this._renderBoxes();
  }

  /**
   * Run one of the SDK's own actions on what is selected now: "edit", "delete",
   * "rotate", "copy". Emits no "action" event. Returns false when it does not apply.
   */
  performAction(id) {
    // Selected WORDS (view / annotate): Copy, or a tool — Android's runWordsAction.
    if (!this.selectionKind && this._pageSel && this._pageSel.settled && PDFE_SELECTION_MENU_ITEMS.includes(id)) {
      this._runWordsAction(id);
      return true;
    }
    const kind = this.selectionKind;
    if (!kind) return false;
    switch (id) {
      case "edit": if (kind !== "text") return false; this.editSelection(); return true;
      case "delete": this.deleteSelection(); return true;
      case "rotate": return kind === "image" && this.rotateSelection(1);
      case "rotate_left": return kind === "image" && this.rotateSelection(-1);
      case "rotate_right": return kind === "image" && this.rotateSelection(1);
      case "copy": {
        const t = this.selectedTextBoxText;
        if (t == null) return false;
        try { navigator.clipboard?.writeText(t); } catch (e) { /* no clipboard here */ }
        return true;
      }
      default: return false;
    }
  }

  /**
   * WHERE THE SELECTION IS ON SCREEN, in CSS pixels relative to the editor's own
   * box: {left, top, width, height}, or null when nothing is selected. Read it on
   * "select"; scrolling and zooming move it.
   */
  get selectionScreenRect() {
    // A selected MARK counts too (annotate mode), so an app's own bar can follow it.
    const sel = this._selectedStamp ? { page: this._selectedStamp.page, bounds: this._selectedStamp.stamp.rect }
      : this._selectedMark ? { page: this._selectedMark.page, bounds: this._selectedMark.mark.rect }
      : this._selectedImage || this._selected ||
        (this._pageSel && this._pageSel.bounds ? { page: this._pageSel.page, bounds: this._pageSel.bounds } : null);
    if (!sel) return null;
    const rect = this._pageRect(sel.page);
    if (!rect) return null;
    const k = this._k(sel.page);
    const v = this._viewBox(sel.page, sel.bounds);
    // Page rects are STRIP coordinates; the strip's own box carries the scroll.
    const box = this.root.getBoundingClientRect();
    const strip = this.strip.getBoundingClientRect();
    return {
      left: strip.left - box.left + rect.left + v.left * k,
      top: strip.top - box.top + rect.top + v.top * k,
      width: v.width * k, height: v.height * k,
    };
  }

  /**
   * IS THE KEYBOARD THE SDK'S NOW — its typing target has focus. On a phone or tablet that
   * is exactly when the on-screen keyboard is up; a desktop has none. The `keyboard` event
   * reports every change.
   */
  get keyboardVisible() { return !!this.sink && this._doc.activeElement === this.sink; }

  /** Bring the keyboard back while a box is open for typing (call it from a tap — iOS raises
   *  a keyboard only inside a user gesture). false when no box is open. */
  showKeyboard() {
    if (this._editingPage < 0) return false;
    this._setSinkFocus(true);
    return true;
  }

  /** Put the keyboard away and STAY in the box (caret and selection kept). To leave the box
   *  too, call getOutOfBoxEditing(). */
  hideKeyboard() { this._setSinkFocus(false); }

  /** Emit "selectionrect" when the selection's place on screen changed — at most once a frame. */
  _reportSelectionRect() {
    if (this._rectFrame) return;
    const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
    this._rectFrame = raf(() => {
      this._rectFrame = 0;
      const r = this.selectionScreenRect;
      const key = r ? `${r.left}|${r.top}|${r.width}|${r.height}` : "";
      if (key === this._rectKey) return;
      this._rectKey = key;
      this._emit("selectionrect", { rect: r });
    });
  }

  /** Is built-in |id| able to act on |kind| now? An app id always shows. */
  _actionOffered(kind, id) {
    switch (id) {
      case "edit": return kind === "text";
      case "copy": return kind === "text" && this.selectedTextBoxText != null;
      case "rotate": return kind === "image" && this._rotateBarShown();
      case "rotate_left": case "rotate_right": return kind === "image";
      case "delete": return kind !== "image" || this._imageDeleteControl;
      default: return true;
    }
  }

  /** Fill the bar for |kind|; false = show no bar. */
  _fillActions(kind) {
    if (!this._actionBarEnabled) return false;
    const items = this.actions(kind).filter((a) => this._actionOffered(kind, a.id));
    const host = this._actionBarElement;
    const key = kind + "|" + items.map((a) => a.id).join(",") + "|" + (host ? "host" : "sdk");
    if (key === this._actionsKey) return host ? true : items.length > 0;
    this._actionsKey = key;
    this._actionsSize = null;               // a different set of buttons is a different size
    this.actionsEl.classList.toggle("pdfe-hostbar", !!host);
    if (host) {
      if (host.parentNode !== this.actionsEl) this.actionsEl.replaceChildren(host);
      for (const el of host.querySelectorAll("[data-pdfe-action]"))
        el.style.display = items.some((a) => a.id === el.dataset.pdfeAction) ? "" : "none";
      return true;
    }
    this.actionsEl.replaceChildren(...items.map((a) => this._actionButton(a)));
    return items.length > 0;
  }

  /** One SDK-drawn button for |a| ({id, label?, icon?}) — the bar's and the words menu's. */
  _actionButton(a) {
    {
      const b = this._doc.createElement("button");
      b.type = "button";
      b.dataset.pdfeAction = a.id;
      const cls = PDFE_ACTION_CLASS[a.id];
      if (cls) b.className = cls;
      // The SDK's own labels carry a glyph as their icon; with the app's icon, drop it.
      const own = PDFE_ACTION_LABEL[a.id];
      const label = a.label ?? (own && a.icon ? own.replace(/^\S+\s/, "") : own) ?? a.id;
      if (a.icon) {
        b.classList.add("pdfe-has-icon");
        const i = this._doc.createElement("span");
        i.className = "pdfe-act-icon";
        if (/^\s*<svg/i.test(a.icon)) i.innerHTML = a.icon;
        else {
          const img = this._doc.createElement("img");
          img.src = a.icon;
          img.alt = "";
          i.append(img);
        }
        const t = this._doc.createElement("span");
        t.textContent = label;
        b.append(i, t);
      } else {
        b.textContent = label;
      }
      return b;
    }
  }

  /** A bar button was tapped: the app is asked first ("action"), then the SDK acts. */
  _onActionPick(id) {
    const kind = this.selectionKind;
    if (!kind) return;
    const sel = this._selectedStamp
      ? { page: this._selectedStamp.page, bounds: this._selectedStamp.stamp.rect }
      : this._selectedMark
      ? { page: this._selectedMark.page, bounds: this._selectedMark.mark.rect }
      : this._selectedImage || this._selected;
    let handled = false;
    this._emit("action", {
      id, kind, page: sel.page, boundsPt: sel.bounds ? [...sel.bounds] : null,
      text: kind === "text" ? this.selectedTextBoxText : null,
      preventDefault() { handled = true; },
    });
    if (!handled && PDFE_BUILT_IN_ACTIONS.has(id)) this.performAction(id);
  }

  _rotateHandleShown() {
    return this._imageRotateControl === "both" || this._imageRotateControl === "handle";
  }

  _rotateBarShown() {
    return this._imageRotateControl === "both" || this._imageRotateControl === "bar";
  }

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
  armAddText(text) {
    if (!this.editMode) this.setEditMode(true);   // placing text IS editing
    // W7a (Android 3.14.0): with |text| the box placed by the next tap HOLDS it ("\n" a new line)
    // and closes — one undo step, as a box the user typed. Without, an empty box to type in.
    this._post({ type: "armAddText", text: typeof text === "string" && text ? text : null });
    return true;
  }

  /** Disarm Add Text without placing anything. Safe to call when not armed. */
  cancelAddText() { this._post({ type: "cancelAddText" }); }

  /** Place a box holding |text| at a page point right away, no tap (e.g. where the user
   *  long-pressed — `pagelongpress` gives the point). False, placing nothing, for an empty text or
   *  a page that does not exist; a point the page refuses is an `error` (add-text-refused). Turns
   *  edit mode on. One undo step. @since 3.15.0 */
  addTextAt(text, page, xPt, yPt) {
    const p = Math.trunc(Number(page));
    if (typeof text !== "string" || !text || !(p >= 0 && p < this._pages.length) ||
        !Number.isFinite(Number(xPt)) || !Number.isFinite(Number(yPt))) return false;
    if (!this.editMode) this.setEditMode(true);
    this._post({ type: "addTextAt", text, page: p, xPt: Number(xPt), yPt: Number(yPt) });
    return true;
  }
  /** Place a box holding |text| in the MIDDLE OF WHAT THE USER SEES now, no tap. False for an
   *  empty text or no document. Turns edit mode on. @since 3.15.0 */
  addTextAtCenter(text) {
    const c = this.visibleCenter();
    return !!c && this.addTextAt(text, c.page, c.xPt, c.yPt);
  }
  /** THE WORDS AN EMPTY TEXT BOX SHOWS while it is open for typing ("Type here"), or null (the
   *  default) for none. Drawn by the SDK, never written into the document; they go with the
   *  first letter. Their colour is the appearance's placeholderColor. @since 3.15.0 */
  get addTextPlaceholder() { return this._addTextPlaceholder ?? null; }
  set addTextPlaceholder(v) {
    this._addTextPlaceholder = typeof v === "string" && v ? v : null;
    this._drawEditBox(this._lastEditBounds);
  }
  /** THE SIZE A NEW ADD TEXT BOX'S TEXT LOOKS ON SCREEN, in CSS px at the zoom it is placed —
   *  or 0 (the default) for setNewTextStyle's point size. Wins over `size` when set. @since 3.15.0 */
  get addTextScreenSizeDp() { return this._addTextScreenSizeDp || 0; }
  set addTextScreenSizeDp(v) {
    const n = Number(v);
    this._addTextScreenSizeDp = Number.isFinite(n) && n > 0 ? n : 0;
    this._post({ type: "addTextScreenSize", dev: this._addTextScreenSizeDp * (this._dpr || 1) });
  }

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
   * A loaded face is written into the saved file only once text uses it.
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
  // The ONE button follows the mode (12-VOCABULARY §7): typing in "text", marks in
  // "annotate", nothing in "view".
  undo() { const scope = this.undoScope; if (scope !== "none") this._post({ type: "undo", scope }); }
  /** Redo the last undone change. No-op when empty. */
  redo() { const scope = this.undoScope; if (scope !== "none") this._post({ type: "redo", scope }); }
  /** True when there is something to undo — drives an Undo button's enabled state.
   *  Answers for the journal `undoScope` names. */
  get canUndo() {
    const s = this.undoScope;
    return s === "text" ? !!this._history?.canUndo : s === "markup" ? this._history?.markupUndoPage >= 0 : false;
  }
  /** True when there is something to redo. */
  get canRedo() {
    const s = this.undoScope;
    return s === "text" ? !!this._history?.canRedo : s === "markup" ? this._history?.markupRedoPage >= 0 : false;
  }
  /**
   * WHICH HISTORY undo()/redo() drive now: "text" in text mode (with recording on),
   * "markup" in annotate mode, "none" in view mode. Pure shell state. Android's twin is
   * `undoScope` (pdf/HistoryScope.kt). @since 3.15.0
   */
  get undoScope() {
    if (this._mode === "annotate") return "markup";
    if (this._mode === "text") return this._history?.recording ? "text" : "none";
    return "none";
  }
  /** The `history` event: the button state for the CURRENT scope, plus the scope. */
  _emitHistory() {
    const h = this._history || {};
    this._emit("history", { canUndo: this.canUndo, canRedo: this.canRedo,
                            undoPage: h.undoPage ?? -1, redoPage: h.redoPage ?? -1,
                            recording: !!h.recording, scope: this.undoScope });
  }

  /**
   * EVERY STATE IN ONE CALL (V2, 2026-09-29) — what a host reads after its own UI was
   * rebuilt (a route change, a web-view reload) instead of asking a dozen getters one by one.
   * The native bridge's `state` command returns exactly this object, so an iOS shell reads
   * what a web host reads. Pure: it reads cached state only, never the worker, and it answers
   * with no document open (`pageCount: 0`, `mode: "view"`). A fresh object each call.
   */
  state() {
    return {
      pageCount: this.pageCount, page: this.currentPage,
      zoom: this.zoom, editMode: this.editMode, blockMove: this.blockMove,
      mode: this.mode,
      dirty: this.dirty, editing: this.editing, selection: this.selection,
      textSelection: this.textSelection, textStyle: this.textStyle,
      addingText: this.addingText,
      selectionKind: this.selectionKind,
      isTextBoxSelected: this.isTextBoxSelected,
      isAnythingSelected: this.isAnythingSelected,
      isImageSelected: this.isImageSelected,
      selectedTextBoxText: this.selectedTextBoxText,
      imageSelection: this.imageSelection,
      imageRotateControl: this.imageRotateControl,
      imageHandles: this.imageHandles, signatureHandles: this.signatureHandles, drawingHandles: this.drawingHandles,
      imageDeleteControl: this.imageDeleteControl,
      capabilities: this.capabilities,
      documentName: this.documentName, documentBytes: this.documentBytes,
      suggestedName: this.suggestedName(),
      canUndo: this.canUndo, canRedo: this.canRedo,
      keyboardVisible: this.keyboardVisible,
      search: this.searchState(),
      // annotate mode (step 19) — the keys Android's PdfeState and the bridge carry
      undoScope: this.undoScope, canDiscard: this.canDiscard,
      markupTool: this.markupTool, markupColor: this.markupColor, markupColors: this.markupColors,
      markupAuthor: this.markupAuthor, markupLineRatio: this.markupLineRatio,
      markupLineMinWidth: this.markupLineMinWidth,
      pageTextSelection: this.pageTextSelection, selectedMarkup: this.selectedMarkup,
      signatureTool: this.signatureTool, selectedSignature: this.selectedSignature,
      // DR3 — drawing
      drawingTool: this.drawingTool, drawingColor: this.drawingColor, drawingWidthDp: this.drawingWidthDp,
      eraserWidthDp: this.eraserWidthDp, isDrawing: this.isDrawing, selectedDrawing: this.selectedDrawing,
      textCheck: this.textCheck(),
      textCheckState: this.textCheckState(), textCheckInProgress: this.textCheckInProgress,
    };
  }
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
    this._stopZoomAnim?.();   // a host's own zoom wins over a glide in flight
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
  goToPage(page, animated = false) {
    const i = Math.trunc(Number(page));
    if (!Number.isFinite(i) || i < 0 || i >= this._pageCanvases.length) return false;
    if (!this._pageOffsets.length) this._measurePageOffsets();
    // W6b: sideways, the page's left edge (centred when it fits) — else its top edge.
    const h = this._scrollDirection === "horizontal";
    const [start, len] = this._pageSpan(i);
    const at = h ? start - Math.max(8, (this.scroller.clientWidth - len) / 2) : start - 8;
    // 3.3.0: `animated` glides there (the go-to-page sheet, a bookmark, read-aloud).
    if (animated) this.scroller.scrollTo({ [h ? "left" : "top"]: at, behavior: "smooth" });
    else if (h) this.scroller.scrollLeft = at;
    else this.scroller.scrollTop = at;
    // Announce the new page now instead of waiting for the browser's scroll event,
    // so a host that shows a page label sees it update in the same task.
    this._updateCurrentPage();
    return true;
  }

  // ---- the reader (3.3.0): where the user is, and the scroll's state -----------------

  /** How far down the document the view is: 0 = the very top, 1 = the very bottom (0 when it
   *  all fits). The `scroll` event reports every change. */
  get scrollPosition() {
    const sc = this.scroller;
    if (!sc) return 0;                  // a reader never throws, even before the view exists
    const h = this._scrollDirection === "horizontal";   // W6b: along the way the pages run
    const range = h ? sc.scrollWidth - sc.clientWidth : sc.scrollHeight - sc.clientHeight;
    return range > 0 ? Math.min(1, Math.max(0, (h ? sc.scrollLeft : sc.scrollTop) / range)) : 0;
  }

  /** Is the user scrolling now? The `scrollstate` event reports every change. */
  get isScrolling() { return !!this._scrolling; }

  /** Scroll to |position| (0..1, the scrollPosition scale); |animated| glides there. */
  scrollToPosition(position, animated = false) {
    const sc = this.scroller, h = this._scrollDirection === "horizontal";
    const range = h ? sc.scrollWidth - sc.clientWidth : sc.scrollHeight - sc.clientHeight;
    if (!(range > 0)) return;
    const at = Math.min(1, Math.max(0, Number(position) || 0)) * range;
    if (animated) sc.scrollTo({ [h ? "left" : "top"]: at, behavior: "smooth" });
    else if (h) sc.scrollLeft = at;
    else sc.scrollTop = at;
  }

  /** After the scroller moved: `scroll` {position, page}, `scrollstate` on a start and (150 ms
   *  after the last movement) a stop, and `scrolledge` once per arrival at the top or bottom. */
  _reportScroll() {
    if (!this.scroller) return;
    const pos = this.scrollPosition;
    if (pos === this._reportedScroll) return;
    this._reportedScroll = pos;
    this._emit("scroll", { position: pos, page: this._currentPage });
    const sc = this.scroller;
    const fits = this._scrollDirection === "horizontal" ? sc.scrollWidth <= sc.clientWidth : sc.scrollHeight <= sc.clientHeight;
    const at = fits || pos <= 0.0005 ? "top" : pos >= 0.9995 ? "bottom" : null;
    if (at && at !== this._reportedEdge) this._emit("scrolledge", { edge: at });
    this._reportedEdge = at;
  }

  _scrollMoved() {
    if (!this._scrolling) { this._scrolling = true; this._emit("scrollstate", { scrolling: true }); }
    clearTimeout(this._scrollStopTimer);
    this._scrollStopTimer = setTimeout(() => {
      this._scrolling = false;
      this._emit("scrollstate", { scrolling: false });
    }, 150);
    this._reportScroll();
  }

  // ---- TEXT CHECK (3.16.0, docs/api/text-check.md) ------------------------------------

  /** Work the text check out as soon as a document opens (and send `textcheck`). Default
   *  false. Set it before open(); a document already open is not checked. @since 3.16.0 */
  get textCheckOnOpen() { return this._textCheckOnOpen; }
  set textCheckOnOpen(v) { this._textCheckOnOpen = !!v; }

  /** The text check's answer for the open document, `{ hasText }`, or null until it has been
   *  worked out. Never touches the engine. @since 3.16.0 */
  textCheck() { return this._textCheck ? { ...this._textCheck } : null; }

  /** true from the moment a check starts until its answer or failure arrives. @since 3.16.0 */
  get textCheckInProgress() { return !!this._textCheckWaiters; }

  /** Where the text check stands: "checking" while one runs (forced ones too), else the saved
   *  answer "hasText" / "noText", else "notChecked". Never touches the engine. @since 3.16.0 */
  textCheckState() {
    if (this._textCheckWaiters) return "checking";
    if (!this._textCheck) return "notChecked";
    return this._textCheck.hasText ? "hasText" : "noText";
  }

  /** Does the document have text a highlight can land on (visible text or a scan's OCR layer),
   *  or only pictures? Resolves `{ hasText }`. The first call works it out in the worker; later
   *  calls answer from the saved answer unless `force` is true. Rejects with a PdfeError
   *  `no-document` or `superseded`. A NEW answer is also sent as `textcheck`. @since 3.16.0 */
  checkText({ force = false } = {}) {
    if (!this._pages || !this._pages.length) {
      return Promise.reject(new PdfeError("no-document", "No document is open"));
    }
    if (this._textCheck && !force) return Promise.resolve({ ...this._textCheck });
    return new Promise((resolve, reject) => {
      if (this._textCheckWaiters) { this._textCheckWaiters.push({ resolve, reject }); return; }
      this._textCheckWaiters = [{ resolve, reject }];
      this._post({ type: "textCheck", gen: ++this._textCheckGen });
    });
  }

  /** What page `page` (0-based) holds: "text" | "scanned" | "scannedWithOcr" | "noText", or
   *  null when nothing is open or the page is out of range. Worked out in the worker each call.
   *  @since 3.16.0 */
  pageKind(page) {
    const n = this._pages ? this._pages.length : 0;
    if (!Number.isInteger(page) || page < 0 || page >= n) return Promise.resolve(null);
    return new Promise((resolve) => {
      const seq = ++this._pageKindSeq;
      this._pageKindWaiters.set(seq, resolve);
      this._post({ type: "pageKind", seq, page });
    });
  }

  _onTextChecked(msg) {
    if (msg.gen !== this._textCheckGen || !this._textCheckWaiters) return;
    const waiters = this._textCheckWaiters;
    this._textCheckWaiters = null;
    if (msg.error) {
      for (const w of waiters) w.reject(new PdfeError(msg.error, msg.error === "superseded"
        ? "A different document was opened before the text check finished" : "No document is open"));
      return;
    }
    this._textCheck = { hasText: !!msg.hasText };
    this._emit("textcheck", { ...this._textCheck });
    for (const w of waiters) w.resolve({ ...this._textCheck });
  }

  /** A new document (or destroy): the saved answer and any running check named the old one. */
  _resetTextCheck(code) {
    this._textCheck = null;
    this._textCheckGen++;
    const waiters = this._textCheckWaiters;
    this._textCheckWaiters = null;
    for (const w of waiters || []) w.reject(new PdfeError(code, code === "superseded"
      ? "A different document was opened before the text check finished" : "The editor was destroyed"));
    for (const r of this._pageKindWaiters?.values() ?? []) r(null);
    this._pageKindWaiters?.clear();
  }

  // ---- TEXT SEARCH (3.3.0) ------------------------------------------------------------
  // Pages are searched in the worker one per task, starting at the page on screen and
  // wrapping; results are NUMBERED in document order. The Android twin of the walking rule is
  // pdf/SearchRun.kt — keep the two in step (web/sdk/search_test.mjs, SearchRunTest).

  /** Where the text search stands — the same snapshot the `search` event carries. */
  searchState() {
    const s = this._search;
    if (!s) return { query: "", searching: false, pagesSearched: 0, pageCount: 0,
                     resultCount: 0, currentIndex: -1, currentPage: -1 };
    let idx = -1;
    if (s.curPage >= 0) {
      idx = s.curOnPage;
      for (let p = 0; p < s.curPage; p++) idx += (s.hits.get(p) || []).length;
    }
    return { query: s.query, searching: s.pagesSearched < s.pageCount,
             pagesSearched: s.pagesSearched, pageCount: s.pageCount, resultCount: s.resultCount,
             currentIndex: idx, currentPage: s.curPage };
  }

  /** Search the document's text, in view or annotate mode. Every result is highlighted, the
   *  first one found is shown, and `search` reports after every page. A blank query clears. */
  search(query, { matchCase = false, wholeWord = false } = {}) {
    const q = String(query ?? "");
    if (!q.trim()) { this.clearSearch(); return; }
    if (!this._pages || !this._pages.length) {
      this._emit("error", { code: "no-document", detail: "No document is open" }); return;
    }
    if (this._mode === "text") {
      this._emit("error", { code: "search-unavailable", detail: "Search works in view or annotate mode" });
      return;
    }
    const n = this._pages.length;
    const start = Math.min(n - 1, Math.max(0, this._currentPage | 0));
    const gen = (this._searchGen = (this._searchGen || 0) + 1);
    this._search = { query: q, gen, pageCount: n, pagesSearched: 0, resultCount: 0,
                     hits: new Map(), curPage: -1, curOnPage: -1 };
    this._renderSearch();
    this._emit("search", this.searchState());
    const order = Array.from({ length: n }, (_, i) => (start + i) % n);
    this._post({ type: "search", gen, query: q, flags: (matchCase ? 1 : 0) | (wholeWord ? 2 : 0), order });
  }

  /** A page's results arrived from the worker. */
  _onSearchPage(msg) {
    const s = this._search;
    if (!s || msg.gen !== s.gen || s.hits.has(msg.page)) return;   // replaced or cleared
    s.hits.set(msg.page, msg.hits);
    s.pagesSearched++;
    s.resultCount += msg.hits.length;
    const first = s.curPage < 0 && msg.hits.length > 0;
    if (first) { s.curPage = msg.page; s.curOnPage = 0; }
    this._renderSearch();
    if (first) this._revealSearchHit();
    this._emit("search", this.searchState());
  }

  /** Show the next result (wrapping after the last). false when there is none. */
  goToNextResult() { return this._stepSearch(true); }
  /** Show the previous result (wrapping before the first). false when there is none. */
  goToPreviousResult() { return this._stepSearch(false); }

  _stepSearch(forward) {
    const s = this._search;
    if (!s || s.resultCount === 0 || s.curPage < 0) return false;
    const on = (p) => (s.hits.get(p) || []).length;
    if (forward && s.curOnPage + 1 < on(s.curPage)) s.curOnPage++;
    else if (!forward && s.curOnPage > 0) s.curOnPage--;
    else {
      let p = s.curPage, moved = false;
      for (let k = 0; k < s.pageCount; k++) {
        p = forward ? (p + 1) % s.pageCount : (p - 1 + s.pageCount) % s.pageCount;
        if (on(p) > 0) { s.curPage = p; s.curOnPage = forward ? 0 : on(p) - 1; moved = true; break; }
      }
      if (!moved) return false;
    }
    this._renderSearch();
    this._revealSearchHit();
    this._emit("search", this.searchState());
    return true;
  }

  /** End the search: the highlights go and one last `search` event says query "". Also done
   *  when text mode is entered or a new document opens. */
  clearSearch() {
    this._searchGen = (this._searchGen || 0) + 1;
    if (this._worker) this._post({ type: "clearSearch", gen: this._searchGen });
    if (!this._search) return;
    this._search = null;
    this._renderSearch();
    this._emit("search", this.searchState());
  }

  /** The highlights, in strip space like the boxes (they scroll and zoom with the pages). */
  _renderSearch() {
    if (!this.searchEl) return;
    this.searchEl.innerHTML = "";
    const s = this._search;
    if (!s) return;
    for (const [page, hits] of s.hits) {
      const scaleCss = this._k(page);
      const rect = this._pageRect(page);
      if (!rect || !this._pages[page]) continue;
      hits.forEach((q, i) => {
        for (let o = 0; o + 8 <= q.length; o += 8) {
          const xs = [q[o], q[o + 2], q[o + 4], q[o + 6]], ys = [q[o + 1], q[o + 3], q[o + 5], q[o + 7]];
          const v = this._viewBox(page, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
          const div = this._doc.createElement("div");
          div.className = page === s.curPage && i === s.curOnPage ? "pdfe-search-hit pdfe-current" : "pdfe-search-hit";
          div.style.left = (rect.left + v.left * scaleCss) + "px";
          div.style.top = (rect.top + v.top * scaleCss) + "px";
          div.style.width = (v.width * scaleCss) + "px";
          div.style.height = (v.height * scaleCss) + "px";
          this.searchEl.appendChild(div);
        }
      });
    }
  }

  /** Scroll the current result into view (centred) when it is not already well inside it. */
  _revealSearchHit() {
    const s = this._search;
    const el = this.searchEl && this.searchEl.querySelector(".pdfe-current");
    if (!s || !el || !this.scroller) return;
    const top = parseFloat(el.style.top), h = parseFloat(el.style.height);
    const left = parseFloat(el.style.left), w = parseFloat(el.style.width);
    const sc = this.scroller, margin = 48;
    const inY = top >= sc.scrollTop + margin && top + h <= sc.scrollTop + sc.clientHeight - margin;
    const inX = left >= sc.scrollLeft && left + w <= sc.scrollLeft + sc.clientWidth;
    if (inY && inX) return;
    sc.scrollTo({ top: inY ? sc.scrollTop : top + h / 2 - sc.clientHeight / 2,
                  left: inX ? sc.scrollLeft : left + w / 2 - sc.clientWidth / 2, behavior: "smooth" });
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
    if (this._scrollDirection === "horizontal") {   // W6b: sideways, the pages run along x
      const x0 = (this._stripLeft || 0) + topLeft.x, x1 = (this._stripLeft || 0) + botRight.x, sL = this.scroller.scrollLeft;
      if (x1 > sL && x0 < sL + this.scroller.clientWidth) return;
      this.scroller.scrollLeft = Math.max(0, x0 - margin);
      return;
    }
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
    this._resetTextCheck("no-document");   // 3.16.0: nobody will answer a running check now
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
    this.root.style.setProperty("--pdfe-gap", `${this._pageSpacingDp}px`);
    this.root.classList.toggle("pdfe-night", this._nightMode);
    this.root.classList.toggle("pdfe-noscroll", !this._scrollEnabled);
    this.strip = mk("div", "pdfe-strip");
    this._applyLayoutClasses();
    this.boxesEl = mk("div", "pdfe-layer pdfe-boxes");
    this.searchEl = mk("div", "pdfe-layer pdfe-search");
    this.selEl = mk("div", "pdfe-layer pdfe-sel");
    this.caretEl = mk("div", "pdfe-caret");
    this.editBoxEl = mk("div", "pdfe-editbox");
    this.moveBtnEl = mk("div", "pdfe-movebtn");   // W7a: drags the box being typed in
    this.barPtrEl = this._doc.createElement("div");   // W7b: lives INSIDE the bar (re-attached on place)
    this.barPtrEl.className = "pdfe-barptr";
    this.loupeEl = mk("div", "pdfe-loupe");        // W7b: the magnifier
    this.moveGhostEl = mk("div", "pdfe-moveghost");   // block-drag preview
    // W5c: the dragged picture/signature ITSELF (its own pixels), over the visible area.
    this.liveEl = mk("canvas", "pdfe-live");
    this.handleEls = [mk("div", "pdfe-handle"), mk("div", "pdfe-handle")];
    // Annotate mode's page selection and its two knobs (step 19) — their own elements, so
    // text mode's selection overlay keeps exactly the behaviour it had.
    this.annotSelEl = mk("div", "pdfe-layer pdfe-annotsel");
    this.annotHandleEls = [mk("div", "pdfe-handle"), mk("div", "pdfe-handle")];
    // The SDK's words menu over a page selection — the action bar's look (same classes, so
    // setAppearance styles both), its own element so the two never fight over one node.
    this.selMenuEl = mk("div", "pdfe-actions pdfe-selmenu");
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
    // The action bar's BUTTONS are built from setActions(kind) at every show (3.3.0) —
    // see _fillActions. Rotate in the bar is imageRotateControl "bar" / "both".
    this.sink = mk("textarea", "pdfe-sink");
    for (const [k, v] of Object.entries({
      autocapitalize: "off", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", "aria-hidden": "true", tabindex: "-1",
    })) this.sink.setAttribute(k, v);

    this.strip.append(this.searchEl, this.liveEl, this.boxesEl, this.editBoxEl, this.moveBtnEl, this.loupeEl, this.moveGhostEl, this.selEl,
      this.annotSelEl, ...this.annotHandleEls,
      this.caretEl, ...this.handleEls, this.caretHandleEl, this.actionsEl, this.selMenuEl,
      this.rotateBtn, this.sink);
    this.root.appendChild(this.strip);
    this.container.appendChild(this.root);

    this._wireSink();
    this._wireHandles();
    this._wireAnnotHandles();
    this._wireCaretHandle();
    this._wireMoveButton();
    this._wireActions();
    this._wireViewportGestures();
    this._wireHistoryKeys();
    // A TAP IN READING MODE (3.3.0) — the canvas router returns at its edit-mode gate, so a
    // view-mode tap never reaches it; this reports it as "pagetap" (a reader toggles its bars).
    this._listen(this.scroller, "click", (ev) => {
      if (this._mode !== "view" || this._pinchActive || performance.now() - this._lastPinchEnd < 350) return;
      if (performance.now() - (this._swallowPageTapAt || 0) < 400) return;   // it cleared a selection
      if (this._pageSel) return;   // a long-press / drag that ended in a selection is not a tap
      const canvas = ev.target?.closest?.("canvas[data-page]");
      if (!canvas) return;
      const page = Number(canvas.dataset.page);
      const rect = canvas.getBoundingClientRect();
      const k = this._k(page);
      const [xPt, yPt] = this._viewToPt(page, (ev.clientX - rect.left) / k, (ev.clientY - rect.top) / k);
      this._emit("pagetap", { page, xPt, yPt });
    });

    // Live page number. Safe to do synchronously: the browser already coalesces
    // scroll events to one per frame per element, and the work reads only CACHED
    // page offsets (a per-page getBoundingClientRect here would be a forced
    // layout per page per frame). Passive, so it never blocks scrolling.
    // The scroll also arms the (throttled) far-page eviction sweep.
    this._listen(this.scroller, "scroll", () => {
      this._updateCurrentPage();
      this._scrollMoved();   // the reader's reports (3.3.0)
      this._scheduleEvictSweep();
      // The rotate handle is clamped into the VISIBLE area, so it has to follow a
      // scroll (a few style writes; nothing else re-renders on scroll).
      if (this._selectedImage && this.rotateBtn.style.display === "flex" && !this._draggingBox)
        this._placeRotate(this._selectedImage, this._k(this._selectedImage.page));
      this._reportSelectionRect();   // an app's own bar follows the selection (3.3.0)
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
    if (this._onAnnotateMessage(msg)) return;
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
      case "searchPage": this._onSearchPage(msg); break;
      case "textChecked": this._onTextChecked(msg); break;
      case "pageKindIs": {
        const r = this._pageKindWaiters.get(msg.seq);
        this._pageKindWaiters.delete(msg.seq);
        if (r) r(PDFE_PAGE_KIND_NAMES[msg.kind] ?? null);
        break;
      }
      case "opened": {
        this._pages = msg.pages;
        this._resetTextCheck("superseded");   // 3.16.0
        this._pageMatrices.clear();
        // Annotate state named the previous document's marks and text (the worker dropped
        // its snapshots in its own open). The mode and the armed tool survive, as on Android.
        this._pageMarks?.clear();
        this._pageStamps?.clear();
        this._pageInks?.clear();
        this._selectedInk = null;
        if (this._armedImage) this._setInsertArmed(null);   // an arm belongs to the document it was made on
        this._pageLinks?.clear();          // W6: links belong to the document they were read from
        this._linksAsked?.clear();
        // A gesture or live copy of the old document goes with it (W5c).
        if (this._itemGesture) { this._itemGesture.unhook?.(); this._itemGesture = null; }
        this._liveEnd();
        this._livePrefetch = null;
        clearTimeout(this._settleTimer);
        this._draggingBox = false;
        this._endSelectionGesture();
        this._selectedStamp = null;
        this._selectedMark = null;
        this._pageSel = null;
        this._reportPageSel();
        this._buildStrip();
        const info = {
          pages: msg.pages.length, pageSizes: this.pages, bytes: msg.bytes,
          tier: msg.tier, openMs: msg.openMs, heapMB: msg.heapMB, io: msg.io,
          name: this._docName,
        };
        // The new document starts with no mark: inside a mode, "entered" is now (W2).
        this._markModeEntry();
        this._settle("open", true, info);
        // 3.16.0: started BEFORE "opened", so a host reading textCheckState() there sees "checking".
        if (this._textCheckOnOpen) this.checkText().catch(() => {});
        this._emit("opened", info);
        this._reportedScroll = undefined; this._reportedEdge = undefined;
        this._reportScroll();   // a reader is told where it starts: the top
        this.clearSearch();     // 3.3.0: results named the previous document
        break;
      }
      case "painted":
        // Text pixels just landed: NOW the page may grow its faint boxes
        // (no-op outside edit mode / already cached / already pending).
        this._requestGroups(msg.page);
        // W6: the page's links, once per page (read-only; a tap needs them at once).
        if (this._linksEnabled && !this._linksAsked.has(msg.page)) {
          this._linksAsked.add(msg.page);
          this._post({ type: "links", page: msg.page });
        }
        // Annotate mode hit-tests marks from a per-page list; fetch it with the pixels.
        if (this._mode === "annotate" && !this._pageMarks.has(msg.page))
          this._post({ type: "marks", page: msg.page });
        this._emit("painted", { page: msg.page, baseMs: msg.baseMs, tiles: msg.tiles });
        break;
      case "tile":
        this._emit("tile", { page: msg.page, ms: msg.ms, left: msg.left });
        break;
      case "paraSelected":
        this._selected = { page: msg.page, index: msg.index, bounds: msg.bounds,
                           blockIndex: msg.blockIndex ?? -1, text: msg.text ?? null };
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
      case "imageArmTap": {
        const img = this._armedImage;
        this._setInsertArmed(null);
        if (img) this._insertAt(img, msg.page, msg.xPt, msg.yPt);
        break;
      }
      case "imageInserted":
        if (msg.images) this._pageImages.set(msg.page, msg.images);
        if (!msg.ok) { this._emit("error", errorEvent("insert-failed", "Couldn't add this picture")); break; }
        if (!this._history.recording) this._setDirty(true);
        this._renderBoxes();
        break;
      case "imageDeleted": {
        // The picture is gone and the strip it occupied has already been
        // repainted by the worker. Adopt the fresh list BEFORE re-rendering, or
        // the deleted picture keeps its faint outline (the same trap
        // imageMoved/imageRotated document below).
        if (Array.isArray(msg.images)) this._pageImages.set(msg.page, msg.images);
        this._selectedImage = null;
        this._renderBoxes();
        if (msg.ok) this._setDirty(true);
        // THE SAME `deleted` EVENT AS A PARAGRAPH, carrying `kind` — the pattern
        // `select` already set for both selection kinds. A host that only knows
        // about text keeps working unchanged.
        this._emit("deleted", { page: msg.page, ok: !!msg.ok, kind: "image" });
        break;
      }
      case "imageDeselected":
        if (!this._selectedImage) break;
        this._selectedImage = null;
        this._renderBoxes();
        if (!this._selected) this._emit("select", { selection: null });
        break;
      case "imageMoved":
      case "imageRotated": {
        this._settleItemGesture();
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
        this._emit("deleted", { page: msg.page, ok: !!msg.ok, kind: "text" });
        break;
      }
      case "history":
        this._history = {
          canUndo: !!msg.canUndo, canRedo: !!msg.canRedo,
          undoPage: msg.undoPage ?? -1, redoPage: msg.redoPage ?? -1,
          recording: !!msg.recording,
          markupUndoPage: msg.markupUndoPage ?? -1, markupRedoPage: msg.markupRedoPage ?? -1,
        };
        // canDiscard's inputs (W2) — unless a mark was set after this read was posted: it
        // then measures the PREVIOUS mode's mark and would light Discard on entry (M4).
        if (msg.markGen === this._markGen) {
          this._markSteps = { text: msg.textMarkSteps | 0, markup: msg.markupMarkSteps | 0 };
        }
        // I103 (2026-09-29): the engine's caps DROPPED a text step. From here on an empty
        // stack no longer proves "unmodified" — undoing what is left still leaves the evicted
        // edits in the document — so latch exactly as a truncation (-3) does below.
        if (msg.evicted > 0) this._dirtyUntracked = true;
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
        // A mark on the markup journal is a change too (HistoryScope.dirty): either
        // journal holding a step means "modified".
        const markupUndoable = this._history.markupUndoPage >= 0;
        if (this._history.recording) {
          this._setDirty(this._history.canUndo || markupUndoable || this._dirtyUntracked);
        } else if (markupUndoable) {
          this._setDirty(true);
        }
        this._emitHistory();
        break;
      case "discarded":
        this._onDiscarded(msg);
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
          this._emit("error", errorEvent(
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
                blockIndex: msg.selection.blockIndex ?? -1,
                text: msg.selection.text ?? null }
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
      case "liveItem":
        this._onLiveItem(msg);
        break;
      case "links":
        this._pageLinks.set(msg.page, msg.links || []);
        break;
      case "loupe":
        this._onLoupe(msg);
        break;
      case "blockMoved": {
        this._settleItemGesture();
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
              blockIndex: msg.selection.blockIndex ?? -1,
              text: msg.selection.text ?? null }
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
        this._lastCaretGeom = msg.caret || null;   // the placeholder (W7a) sizes itself from the caret
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
        if (msg.generation === -1) break;   // W7a: the app's own text — no keystroke to time
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
        if (this.editMode) {
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
        // The page's display map rides with its groups (I99): null for an ordinary page.
        // Kept OUT of this._pages on purpose: the public `pages` getter copies those
        // objects, and a private field must not leak into a host's payload.
        if (msg.matrix) this._pageMatrices.set(msg.page, msg.matrix);
        else this._pageMatrices.delete(msg.page);
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
        // A SAVE IS A FRESH START (Android's clearHistories): inside a mode the save point
        // becomes the new entry point, so a later discard reverts only what came after it.
        this._markModeEntry();
        const info = {
          file: msg.file, bytes: msg.bytes, ms: msg.ms, flat: !!msg.flat,
          heapMB: msg.heapMB, tier: msg.tier, io: msg.io,
          suggestedName: this.suggestedName(),
        };
        this._settle("save", true, info);
        this._emit("saved", info);
        break;
      }
      case "flattened": {
        // The worker committed the open box before copying (as a save does), so the
        // edit UI is put away the same way — but NOTHING about dirty or history moves:
        // an export is not a save.
        this._closeEditUiState();
        this._renderBoxes();
        this._settle("exportFlattened", true, msg.bytes);
        break;
      }
      case "flattenFailed": {
        this._settle("exportFlattened", false, new PdfeError(msg.code, msg.detail));
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
        this._pageMatrices.clear();
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
        // NOT exportFlattened: the worker answers every export with its own
        // flattened/flattenFailed message, and this generic `error` is also how unrelated
        // refusals arrive (add-text-refused) — settling here would reject an export whose
        // copy is still coming.
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
    this._markModeEntry();   // the journals were cleared: the save is the new entry point
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
    this._runTyped = false;
    this._editingPage = -1;
    this._editingParaIndex = -1;
    this._editingBlockIndex = -1;
    this._editingIsParagraph = false;
    this._editingLinePreserve = false;
    this._editingChars = 0;
    this._selRange = null;
    this.sink.value = "";
    this._drawEditBox(null);
    if (this.moveBtnEl) this.moveBtnEl.style.display = "none";
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
    const [pos, size] = this._scrollAxis();
    const keep = Math.max(2400, size * 3);
    const top = pos - keep;
    const bot = pos + size + keep;
    let boxesStale = false;
    for (const page of [...this._livePages]) {
      if (page === this._editingPage) continue;   // never evict the open run's page
      if (!this._pageOffsets[page]) continue;
      const off = this._pageSpan(page);
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
    if (!this.editMode || this._pageGroups.has(page) || this._groupsPending.has(page)) return;
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
      if (this._dragSelects() || this._draws("touch")) canvas.style.touchAction = "none";
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
    const [top, size] = this._scrollAxis();
    const bot = top + size;
    let best = 0, bestCover = -1;
    for (let i = 0; i < this._pageOffsets.length; i++) {
      const [t, h] = this._pageSpan(i);
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
    const [pos, size] = this._scrollAxis();
    const top = pos - margin;
    const bot = pos + size + margin;
    for (let i = 0; i < this._pageOffsets.length; i++) {
      const [t, h] = this._pageSpan(i);
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
    let availH = this.scroller.clientHeight - 24;
    if (availH <= 0) availH = 800;
    // W6b — ONE SCALE PER PAGE (zoom 1 = fit): sideways or snapping, each page fits the whole view;
    // else uniformPageWidth makes every page as wide as the view (Android's default), or one
    // document-wide scale lets the widest page fit and narrower ones look narrower.
    const fitsView = this._scrollDirection === "horizontal" || this._pageSnap;
    this._fitScales = this._pages.map((p) => fitsView ? Math.min(avail / p.w, availH / p.h)
      : this._uniformPageWidth ? avail / p.w : avail / maxWpt);
    this._fitScale = this._fitScales[0];
  }

  /** Re-measure the container and repaint at the new fit width (keeps zoom). */
  _refit() {
    if (this._destroyed || !this._pages.length) return;
    const before = this._fitScales.slice();
    this._computeFitScale();
    if (before.length === this._fitScales.length && before.every((k, i) => Math.abs(k - this._fitScales[i]) < 1e-6)) {
      this._measurePageOffsets();  // the container may have re-centered the strip
      this._repositionOverlays();
      this._updateCurrentPage();   // the visible band may have shrunk (keyboard)
      return;
    }
    // W6b: sideways or snapping, a page's fit follows the view's HEIGHT too, so a resize (a toolbar
    // row, the keyboard) re-sizes every page — keep the reader on the same place of the same page.
    // Vertical free scrolling keeps its old behaviour (conditioned, not a general change).
    const keep = (this._scrollDirection === "horizontal" || this._pageSnap) && this._pageOffsets.length;
    let page = 0, frac = 0;
    if (keep) {
      page = this._currentPage;
      const [start, len] = this._pageSpan(page);
      frac = len > 0 ? (this._scrollAxis()[0] - start) / len : 0;
    }
    this._applyZoom();
    this._repositionOverlays();
    if (keep && this._pageOffsets[page]) {
      const [start, len] = this._pageSpan(page);
      if (this._scrollDirection === "horizontal") this.scroller.scrollLeft = start + frac * len;
      else this.scroller.scrollTop = start + frac * len;
      this._updateCurrentPage();
    }
  }

  // Zoom (§5): CSS rescales instantly; sharp tiles refill async.
  _applyZoom() {
    for (const canvas of this._pageCanvases) {
      const p = this._pages[Number(canvas.dataset.page)];
      const scaleCss = this._k(Number(canvas.dataset.page));   // CSS px per point (W6b: per page)
      const scaleDev = scaleCss * this._dpr;                    // device px per point
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
    this._renderSearch();
    this._reportSelectionRect();
    this.boxesEl.innerHTML = "";
    this.actionsEl.style.display = "none";
    this.rotateBtn.style.display = "none";
    if (!this.editMode) {
      if (this._mode === "annotate") {
        this._renderSelectedMark(this._k(this._selectedMark?.page));
        this._renderSelectedStamp(this._k(this._selectedStamp?.page));
        this._renderSelectedInk(this._k(this._selectedInk?.page));
        this._renderItemHandles();
        this._liveSchedulePrefetch();
      }
      return;
    }
    const sel = this._selected;
    // All geometry comes from the CACHED page rects: zero layout reads in this
    // loop (a read after each append re-laid-out the whole strip per box).
    const boxEl = (page, b, cls) => {
      const rect = this._pageRect(page), scaleCss = this._k(page);
      if (!rect) return null;
      const div = this._doc.createElement("div");
      div.className = cls;
      const v = this._viewBox(page, b);
      div.style.left = `${rect.left + v.left * scaleCss}px`;
      div.style.top = `${rect.top + v.top * scaleCss}px`;
      div.style.width = `${v.width * scaleCss}px`;
      div.style.height = `${v.height * scaleCss}px`;
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
        && !this._draggingBox && this._fillActions("text")) {
      this._placeActions(sel.page, sel.bounds, this._k(sel.page));
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
      const scaleCss = this._k(page);
      const pw = this._pages[page].w * scaleCss;
      const ph = this._pages[page].h * scaleCss;
      const pts = [];
      for (let i = 0; i < 8; i += 2) {
        const v = this._ptToView(page, quad[i], quad[i + 1]);
        pts.push(`${v[0] * scaleCss},${v[1] * scaleCss}`);
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
      // While the picture itself is dragged (W5c) its live copy carries the outline.
      if (!this._live) imgSvg(selImg.page, selImg.quad, "pdfe-imagebox pdfe-imagebox-selected");
      // …and the rotate handle on it. Hidden during a drag for the same reason
      // the action bar is: any re-render mid-drag would strand it on the old rect.
      if (!this._draggingBox && this._rotateHandleShown()) {
        this._placeRotate(selImg, this._k(selImg.page));
      }
      // A DELETE-ONLY ACTION BAR (user, 2026-08-28). The first image-edit pass
      // hid this bar entirely, because NEITHER of its actions existed for a
      // picture. Delete now does, so the bar is back with Edit hidden — there
      // is still nothing to open for typing. Hidden mid-drag for the same
      // reason it is for a text box: a re-render would strand it on the old
      // rect. Turning a picture stays HOST chrome (rotateSelection).
      if (!this._draggingBox) {
        // Nothing left to offer: no bar at all, rather than an empty pill.
        if (this._fillActions("image")) {
          this._placeActions(selImg.page, selImg.bounds, this._k(selImg.page));
        } else {
          this.actionsEl.style.display = "none";
        }
      }
      this._renderItemHandles();
      this._liveSchedulePrefetch();
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
    const scaleCss = this._k(page);
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
    const v = this._viewBox(page, bounds, dx, dy);
    el.style.left = `${rect.left + v.left * scaleCss}px`;
    el.style.top = `${rect.top + v.top * scaleCss}px`;
    el.style.width = `${v.width * scaleCss}px`;
    el.style.height = `${v.height * scaleCss}px`;
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
    const v = this._viewBox(page, b);
    const boxLeft = rect.left + v.left * scaleCss;
    const boxTop = rect.top + v.top * scaleCss;
    const boxBot = this._pageMatrix(page)
      ? boxTop + v.height * scaleCss
      : rect.top + (this._pages[page].h - b[1]) * scaleCss;
    // The bar's own size is content-static: measure it once (ONE layout flush),
    // then reuse — re-reading it after the writes above would flush again.
    // ...keyed by WHICH buttons show: a picture's bar (no Edit, maybe no Delete) is a
    // different width from a text box's, and a size measured for one parked the other
    // off-centre.
    // (_fillActions clears the cached size whenever the buttons or their look change.)
    if (!this._actionsSize) this._actionsSize = [bar.offsetWidth, bar.offsetHeight];
    const [bw, bh] = this._actionsSize;
    // W7b (PdfeEditorView.positionBar): with barPointer (Android's default since 3.11.0) the bar is
    // CENTRED over the item and a pointer under the item's middle aims at it; the gap is 8 + the
    // pointer + the item's knobs (selectedKnobReach), or exactly barGapDp when the host set one.
    const ap = this._appearance, ptr = ap.barPointer !== false;
    let itemTop = boxTop, itemBot = boxBot, itemCx = boxLeft + v.width * scaleCss / 2;
    const t = this._transformTarget(), c = t && t.page === page && this._itemCorners(t);
    if (c) {   // a turned picture/signature: its own corners, not its bounding rect
      const cr = this._pageCanvases[page].getBoundingClientRect(), ox = rect.left - cr.left, oy = rect.top - cr.top;
      const ys = [c[1], c[3], c[5], c[7]].map((y) => y + oy);
      itemTop = Math.min(...ys); itemBot = Math.max(...ys);
      itemCx = (c[0] + c[2] + c[4] + c[6]) / 4 + ox;
    }
    const fixed = Number.isFinite(ap.barGapDp) ? Math.max(0, ap.barGapDp) : null;
    const gap = fixed ?? (8 + (ptr ? 7 : 0) + this._selectedKnobReach());
    let top = itemTop - bh - gap;
    const below = top < rect.top;
    if (below) top = itemBot + gap;
    const maxLeft = rect.left + rect.width - bw;
    const left = Math.max(rect.left, Math.min(ptr ? itemCx - bw / 2 : boxLeft, maxLeft));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    const p = this.barPtrEl;
    if (!ptr) { p.remove(); return; }
    if (p.parentNode !== bar) bar.appendChild(p);
    p.className = `pdfe-barptr ${below ? "pdfe-up" : "pdfe-down"}`;
    const inset = 10;
    p.style.left = `${Math.min(Math.max(itemCx - left - 7, inset), Math.max(inset, bw - inset - 14))}px`;
  }

  // The rotate handle sits just outside the picture's TOP-RIGHT corner, clamped
  // into the page so a picture at the very edge (monetary.pdf has one starting at
  // x = -2) still shows it. The corner comes from the QUAD, not the axis-aligned
  // box: on a turned picture those differ, and anchoring to the box would leave
  // the handle floating away from the corner it belongs to.
  _placeRotate(sel, scaleCss) {
    const rect = this._pageRect(sel.page);
    if (!rect || !sel.quad) return;
    let bestX = -Infinity, bestY = Infinity;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const v = this._ptToView(sel.page, sel.quad[i], sel.quad[i + 1]);
      const x = v[0] * scaleCss;
      const y = v[1] * scaleCss;
      // "top-right" in SCREEN terms: largest x, smallest y, decided together so
      // a turned picture's handle lands on the corner the user sees as top-right.
      if (x - y > bestX - bestY) { bestX = x; bestY = y; }
      l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y);
    }
    const SIZE = 28, GAP = 6, PAD = 2;
    const btn = this.rotateBtn;
    btn.style.display = "flex";
    const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(v, hi)));
    let left = clamp(rect.left + bestX - SIZE / 2 + GAP, rect.left, rect.left + rect.width - SIZE);
    let top = clamp(rect.top + bestY - SIZE / 2 - GAP, rect.top, rect.top + rect.height - SIZE);
    // KEEP THE WHOLE HANDLE IN VIEW (3.1.0). The page clamp above is not enough: a
    // zoomed page is wider than the viewport, and a client's layout can hand us a
    // page box wider than what is on screen — either way the corner sits past the
    // visible edge and the handle was cut in half (client report, iOS, a quarter
    // turn of a tall picture on a narrow page). So also clamp into the scroller's
    // visible area, pulled in along the picture's own box so it still reads as "on
    // this picture". A picture wholly out of view keeps its true corner and
    // scrolls away with it. Strip-relative, like everything else here.
    const sc = this.scroller;
    const vx0 = sc.scrollLeft - (this._stripLeft || 0), vx1 = vx0 + sc.clientWidth;
    const vy0 = sc.scrollTop - (this._stripTop || 0), vy1 = vy0 + sc.clientHeight;
    const pl = rect.left + l, pr = rect.left + r, pt = rect.top + t, pb = rect.top + b;
    if (pr > vx0 && pl < vx1 && pb > vy0 && pt < vy1) {
      left = clamp(left, Math.max(vx0 + PAD, pl - SIZE / 2), Math.min(vx1 - SIZE - PAD, pr - SIZE / 2));
      top = clamp(top, Math.max(vy0 + PAD, pt - SIZE / 2), Math.min(vy1 - SIZE - PAD, pb - SIZE / 2));
    }
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
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
    // EVERY bar button — the SDK's and the app's own element's — by its data-pdfe-action.
    this._listen(this.actionsEl, "click", (ev) => {
      const b = ev.target.closest?.("[data-pdfe-action]");
      if (!b || !this.actionsEl.contains(b)) return;
      swallow(ev);
      this._onActionPick(b.dataset.pdfeAction);
    });
    // The words menu: the same contract — every [data-pdfe-action] button, SDK's or app's.
    this._listen(this.selMenuEl, "pointerdown", swallow);
    this._listen(this.selMenuEl, "click", (ev) => {
      const b = ev.target.closest?.("[data-pdfe-action]");
      if (!b || !this.selMenuEl.contains(b)) return;
      swallow(ev);
      this._onMenuPick(b.dataset.pdfeAction);
    });
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
    const scaleCss = this._k(page);
    const v = this._ptToView(page, xPt, yPt);
    return {
      x: rect.left + v[0] * scaleCss,
      y: rect.top + v[1] * scaleCss,
    };
  }

  // ---- the page transform (docs/KNOWN_ISSUES.md I99, annotations step 13a) ----------
  // Every piece of geometry the core hands us is in the page's UNROTATED user space; the
  // page is DISPLAYED rotated (its size here is the rotated one). So every overlay goes
  // through the engine's own map, pdfe_page_view_matrix, which the worker sends with a
  // page's groups. `m` is null for an ORDINARY page (/Rotate 0, origin (0, 0)) and each
  // helper then evaluates the old `x, H - y` expression literally — nothing on an existing
  // document moves. The Android twin is pdf/PageTransform.kt.
  _pageMatrix(page) { return this._pageMatrices.get(page) || null; }

  /** User point -> display point [vx, vy], in points from the displayed top-left. */
  _ptToView(page, x, y) {
    const m = this._pageMatrix(page);
    if (!m) return [x, this._pages[page].h - y];
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** Display point -> user point [x, y]. The linear part is a quarter-turn, so its
   *  inverse is its transpose. */
  _viewToPt(page, vx, vy) {
    const m = this._pageMatrix(page);
    if (!m) return [vx, this._pages[page].h - vy];
    return [m[0] * (vx - m[4]) + m[1] * (vy - m[5]), m[2] * (vx - m[4]) + m[3] * (vy - m[5])];
  }

  /** A user box [l, b, r, t] shifted by (dx, dy) -> {left, top, width, height} in display
   *  points. On a rotated page the box's width and height swap. */
  _viewBox(page, b, dx = 0, dy = 0) {
    const m = this._pageMatrix(page);
    if (!m) {
      return { left: b[0] + dx, top: this._pages[page].h - (b[3] + dy),
               width: b[2] - b[0], height: b[3] - b[1] };
    }
    const p1 = this._ptToView(page, b[0] + dx, b[1] + dy);
    const p2 = this._ptToView(page, b[2] + dx, b[3] + dy);
    const left = Math.min(p1[0], p2[0]), top = Math.min(p1[1], p2[1]);
    return { left, top, width: Math.max(p1[0], p2[0]) - left, height: Math.max(p1[1], p2[1]) - top };
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
    // W7a (PdfeAppearance.caretColor): the host's colour, else the colour of the text it sits in.
    const tc = this._textStyle && this._textStyle.colorArgb;
    const ap = this._appearance;
    this.caretEl.style.background = ap.caretColor || (Number.isFinite(tc) ? argbCss(tc) : "");
    if (top.x === bot.x) {
      this.caretEl.style.width = "";
      this.caretEl.style.left = `${top.x - 1}px`;
      this.caretEl.style.top = `${top.y}px`;
      this.caretEl.style.height = `${Math.max(2, bot.y - top.y)}px`;
    } else {
      // A rotated page (I99): the caret lies along the displayed line.
      this.caretEl.style.left = `${Math.min(top.x, bot.x)}px`;
      this.caretEl.style.top = `${(top.y + bot.y) / 2 - 1}px`;
      this.caretEl.style.width = `${Math.max(2, Math.abs(bot.x - top.x))}px`;
      this.caretEl.style.height = "2px";
    }
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
    // min/max: on a rotated page the user box's corners swap places on screen (I99).
    const x0 = Math.min(tl.x, br.x), x1 = Math.max(tl.x, br.x);
    const y0 = Math.min(tl.y, br.y), y1 = Math.max(tl.y, br.y);
    el.style.left = `${x0 - 2}px`;
    el.style.top = `${y0 - 2}px`;
    el.style.width = `${Math.max(1, x1 - x0 + 4)}px`;
    el.style.height = `${Math.max(1, y1 - y0 + 4)}px`;
    this._drawOpenBoxExtras(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
  }

  /** W7a — the open box's extras (PdfPageView's editing look): the placeholder words in an empty
   *  box (the box grows to hold them), the four decorative corner knobs, and the move button. */
  _drawOpenBoxExtras(l, t, r, b) {
    const el = this.editBoxEl, ap = this._appearance;
    el.replaceChildren();
    // the placeholder: only while the box is empty; never written into the document
    const words = this._addTextPlaceholder;
    if (words && !this.sink.value && this._lastCaretGeom) {
      const top = this._pageToCss(this._lastCaretGeom[0], this._lastCaretGeom[1]);
      const bot = this._pageToCss(this._lastCaretGeom[0], this._lastCaretGeom[2]);
      const h = top && bot ? Math.abs(bot.y - top.y) : 16;
      const span = this._doc.createElement("span");
      span.className = "pdfe-placeholder";
      span.textContent = words;
      span.style.fontSize = `${Math.max(8, h * 0.8)}px`;
      span.style.top = `${Math.max(0, (b - t - h) / 2) + h * 0.1}px`;
      el.append(span);
      const w = span.offsetWidth + 6;          // one layout read, only for an EMPTY box
      if (w > r - l) { el.style.width = `${w}px`; r = l + w; }
      if (h + 4 > b - t) { el.style.height = `${h + 4}px`; b = t + h + 4; }
    }
    if (ap.editingCornerKnobs === true) {      // for the look only: they do not resize the box
      const L = this._knobLook();
      for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const k = this._doc.createElement("span");
        k.className = "pdfe-editknob";
        k.style.width = k.style.height = `${2 * L.radius}px`;
        k.style.left = `${x * (r - l) - L.radius - 1}px`;
        k.style.top = `${y * (b - t) - L.radius - 1}px`;
        k.style.background = L.filled ? L.fill : "transparent";
        k.style.boxShadow = `inset 0 0 0 ${L.stroke}px ${L.filled ? L.border : L.fill}`;
        el.append(k);
      }
    }
    // the MOVE button, centred above the box (below it when there is no room), off by default
    const btn = this.moveBtnEl;
    if (ap.moveHandleEnabled !== true || this._editingPage < 0) { btn.style.display = "none"; return; }
    if (btn.dataset.icon !== (ap.moveHandleIcon || "")) {
      btn.dataset.icon = ap.moveHandleIcon || "";
      btn.replaceChildren(ap.moveHandleIcon ? this._iconEl(ap.moveHandleIcon, 18)
        : Object.assign(this._doc.createElement("span"), { innerHTML:
          '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round" d="M0-9V9M-9 0H9M-3-6L0-9 3-6M-3 6L0 9 3 6M-6-3L-9 0-6 3M6-3L9 0 6 3"/></svg>' }));
    }
    const gap = 22, rect = this._pageRect(this._editingPage);
    const y = rect && t - gap - 14 < rect.top ? b + gap : t - gap;
    btn.style.display = "flex";
    btn.style.left = `${(l + r) / 2 - 14}px`;
    btn.style.top = `${y - 14}px`;
  }

  /** The move button's drag: an outline follows, ONE move on the lift, and the box stays open
   *  (PdfeEditorView.moveOpenBox). */
  _wireMoveButton() {
    const btn = this.moveBtnEl;
    this._listen(btn, "pointerdown", (ev) => {
      if (ev.button > 0 || this._editingPage < 0 || !this._lastEditBounds) return;
      ev.preventDefault();
      ev.stopPropagation();
      const page = this._editingPage, bounds = this._lastEditBounds.slice();
      const p0 = this._clientToPt(page, ev.clientX, ev.clientY);
      let d = [0, 0];
      this._moveLimits = null;
      const win = this._win;
      const move = (mv) => {
        if (mv.pointerId !== ev.pointerId) return;
        const p = this._clientToPt(page, mv.clientX, mv.clientY);
        d = [p[0] - p0[0], p[1] - p0[1]];
        this._showMoveGhost(page, bounds, d[0], d[1]);
      };
      const up = (uv) => {
        if (uv.pointerId !== ev.pointerId) return;
        win.removeEventListener("pointermove", move);
        win.removeEventListener("pointerup", up);
        win.removeEventListener("pointercancel", up);
        const [dx, dy] = this._ghostDelta || d;
        this._hideMoveGhost();
        if (uv.type === "pointerup" && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
          this._post({ type: "moveOpenBox", dx, dy });
          this._setSinkFocus(true);              // the box reopens: keep the keyboard
        }
      };
      win.addEventListener("pointermove", move);
      win.addEventListener("pointerup", up);
      win.addEventListener("pointercancel", up);
    });
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
      const x0 = Math.min(tl.x, br.x), y0 = Math.min(tl.y, br.y);
      div.style.left = `${x0}px`;
      div.style.top = `${y0}px`;
      div.style.width = `${Math.max(tl.x, br.x) - x0}px`;
      div.style.height = `${Math.max(tl.y, br.y) - y0}px`;
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
    this._renderAnnotate();
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
          const scaleCss = this._k(this._editingPage);
          // The finger is on the knob BELOW the line — sample ~a knob height
          // above it so the boundary lookup lands on the dragged line.
          const [xPt, yPt] = this._viewToPt(this._editingPage,
            (mv.clientX - rect.left) / scaleCss,
            (mv.clientY - HANDLE_TOUCH_LIFT - rect.top) / scaleCss);
          this._loupeAt(mv, this._editingPage, mv.clientX, mv.clientY - HANDLE_TOUCH_LIFT);   // W7b
          this._post({
            type: "dragHandle", which,
            start: this._selRange[0], end: this._selRange[1], xPt, yPt,
          });
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          this._loupeHide();
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
        const scaleCss = this._k(this._editingPage);
        const [xPt, yPt] = this._viewToPt(this._editingPage,
          (mv.clientX - rect.left) / scaleCss,
          (mv.clientY - HANDLE_TOUCH_LIFT - rect.top) / scaleCss);
        this._loupeAt(mv, this._editingPage, mv.clientX, mv.clientY - HANDLE_TOUCH_LIFT);   // W7b
        this._post({ type: "dragCaret", page: this._editingPage, xPt, yPt });
      };
      const up = () => {
        this._draggingCaret = false;
        this._loupeHide();
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
    // ANNOTATE: while a finger selects text (or a tool is armed for one-finger marking) the
    // page must not scroll under it. Non-passive so preventDefault works on iOS, which
    // ignores touch-action; two fingers are left to the pinch/scroll.
    this._listen(canvas, "touchmove", (ev) => {
      if (ev.touches.length === 1 && (this._annotSelecting || this._dragSelects())) ev.preventDefault();
    }, { passive: false });
    this._listen(canvas, "pointerdown", (ev) => {
      // Recorded before the edit-mode gate: the caret thumb is touch-only, and
      // the input type is a property of the DEVICE, not of the mode.
      // [tap-precedence: BEGIN web-pointer-down]
      // ── WHAT MAY CLAIM THE GESTURE BEFORE IT IS A TAP ──────────────────
      // Declared once in scripts/tap_precedence.data.mjs, rendered in
      // docs/TAP_PRECEDENCE.md, checked by scripts/check_tap_precedence.mjs.
      this._lastPointerType = ev.pointerType || "mouse";
      if (this._mode !== "text") { this._pagePointerDown(ev, canvas); if (this._mode === "annotate") return; }
      // [tap-rung: edit-mode-gate]
      if (!this.editMode) return;
      // I9: killing the default action stops the browser from moving focus to
      // <body> after this handler (a mousedown on a non-focusable canvas blurs
      // the sink). Without it every caret-reposition tap silently disconnected
      // the keyboard.
      ev.preventDefault();
      const page = Number(canvas.dataset.page);
      const startX = ev.clientX, startY = ev.clientY;
      const toPt = (cx, cy) => {
        const rect = canvas.getBoundingClientRect();
        const scaleCss = this._k(page);
        const [xPt, yPt] = this._viewToPt(page, (cx - rect.left) / scaleCss,
                                          (cy - rect.top) / scaleCss);
        return { xPt, yPt };
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
      // [tap-rung: box-drag-grab]
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
      // [tap-rung: long-press-arm]
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
      // [tap-precedence: END web-pointer-down]
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
      const abort = () => {
        const was = movingBox;
        cleanup();
        // A pinch that took the item over (W5c) keeps its own live copy and gesture.
        if (was && !this._itemGesture) { this._liveEnd(); this._draggingBox = false; this._endSelectionGesture(); }
        if (was) this._renderBoxes();
      };
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
            // W5c: a picture moves ITSELF (its own pixels), a box its outline; the host hears it.
            this._beginSelectionGesture(movableImage ? "image" : "text");
            if (movableImage) {
              const t = this._transformTarget();
              this._liveBegin(t, this._itemCorners(t));
              this._renderBoxes();
            }
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
          if (movableImage) this._liveMove(page, ...(this._ghostDelta || [c.xPt - down.xPt, c.yPt - down.yPt]));
          return;
        }
        // Anchor = press point, head = current point; the core clamps both to
        // the open run (desktop mouse-drag selection).
        const a = toPt(startX, startY);
        const c = toPt(mv.clientX, mv.clientY);
        this._post({ type: "dragSelect", page, ax: a.xPt, ay: a.yPt, xPt: c.xPt, yPt: c.yPt });
      };
      const up = (uv) => {
      // [tap-precedence: BEGIN web-pointer-up]
      // ── IS THIS STILL A TAP, AND WHICH KIND ─────────────────────────
      // Same table, same checker. The rungs Android reaches through separate
      // GestureDetector callbacks are declared there as `by-framework`.
        // [tap-rung: pinch-wins]
        const wasMoving = movingBox;
        const drop = wasMoving ? toPt(uv.clientX, uv.clientY) : null;
        cleanup();
        // A finger lifting off a pinch must not read as a tap (I17).
        if (this._pinchActive || performance.now() - this._lastPinchEnd < 350) return;
        // Drop: translate for real, ONCE. The worker re-resolves the block from
        // a fresh grouping, so it can never act on a stale index.
        // [tap-rung: box-drag-drop]
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
            if (movableImage) this._liveMove(page, dx, dy);   // the copy waits where it was dropped
            this._itemCommitPending();
          }
          else {                          // nothing moved: nothing will restore the bar
            this._liveEnd();
            this._renderBoxes();
            this._endSelectionGesture();
          }
          return;
        }
        // [tap-rung: long-press-consumed]
        if (lpFired) return;
        // A drag that ended: keep the keyboard only if a run is actually open
        // (a pan with nothing open must not raise one on iOS — S39).
        // [tap-rung: pan-consumed]
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
        // [tap-rung: shift-click-extend]
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
        // [tap-rung: double-tap-word]
        const dbl = this._editingPage === page &&
          this._lastTapPage === page &&
          performance.now() - this._lastTapAt < DOUBLE_TAP_MS &&
          Math.hypot(uv.clientX - this._lastTapX, uv.clientY - this._lastTapY) <= DOUBLE_TAP_SLOP;
        this._lastTapAt = dbl ? 0 : performance.now();   // a third tap starts over
        this._lastTapX = uv.clientX;
        this._lastTapY = uv.clientY;
        this._lastTapPage = page;
        // [tap-rung: single-tap-post]
        // The hand-off: everything below this point is the L3 chain, and on this
        // platform it runs in the WORKER (pdfe-worker.js), not here.
        this._post(dbl ? { type: "selectWord", page, xPt, yPt }
                       : { type: "tap", page, xPt, yPt });
        // Focus inside the user gesture — browsers only show a keyboard then —
        // but ONLY when this tap opens or continues an edit. Focusing on every
        // tap made a plain select-tap raise the keyboard on iOS, where focus and
        // keyboard are the same thing (S39). A double tap is a word-select and
        // only fires inside an open run, so it always wants one.
        this._setSinkFocus(dbl || this._tapWantsKeyboard(page, { xPt, yPt }));
      };
      // [tap-precedence: END web-pointer-up]
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
      // W5c: two fingers ON the selected picture/signature resize (and turn) it, unless its
      // pinch job is "none" — then they zoom the page, as everywhere else.
      if (this._maybeItemPinch(ev.touches)) return;
      let anchor = this._pagePointAt(mid.x, mid.y);
      if (!anchor) anchor = this._nearestPagePoint(mid.x, mid.y);
      this._stopZoomAnim();
      this._pinch = { last: touchDist(ev.touches), anchor, mid };
      this._applyLayoutClasses();   // no snapping under a pinch
      this._pinchSamples = [{ t: performance.now(), z: this._zoom }];
    }, { passive: false });

    this._listen(this.scroller, "touchmove", (ev) => {
      const g = this._itemGesture;
      if (g && g.how === "pinch") {
        if (ev.touches.length === 2) { ev.preventDefault(); g.move(ev.touches); }
        return;
      }
      if (!this._pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      const mid = touchMid(ev.touches);
      // W6: zoomConfig's rubber band (PinchZoom.next) — resisted past the resting limits, never
      // past the stretch; the lift springs back or coasts (_endPinchZoom).
      const zc = this.zoomConfig, over = zc.stretchBeyondLimits;
      const lo = over ? zc.stretchMin : zc.minZoom, hi = over ? zc.stretchMax : zc.maxZoom, d = touchDist(ev.touches);
      this._setZoomRaw(PinchZoom.next(this._zoom, d / this._pinch.last, zc.minZoom, zc.maxZoom, lo, hi), lo, hi);
      this._pinch.last = d;
      this._pinch.mid = mid;
      this._pinchSamples.push({ t: performance.now(), z: this._zoom });
      if (this._pinchSamples.length > 12) this._pinchSamples.shift();
      if (this._pinch.anchor) this._scrollPagePointTo(this._pinch.anchor, mid.x, mid.y);
    }, { passive: false });

    const endPinch = (ev) => {
      if (!this._pinchActive) return;
      if (ev.touches && ev.touches.length >= 2) return;   // still pinching
      const g = this._itemGesture;
      if (g && g.how === "pinch") this._finishItemGesture(g, ev.type !== "touchcancel");
      const pinch = this._pinch;
      this._pinchActive = false;
      this._pinch = null;
      this._lastPinchEnd = performance.now();
      if (pinch && ev.type !== "touchcancel") this._endPinchZoom(pinch.mid.x, pinch.mid.y);
      this._applyLayoutClasses();
    };
    this._listen(this.scroller, "touchend", endPinch);
    this._listen(this.scroller, "touchcancel", endPinch);

    // iOS Safari/WKWebView ignore touch-action and the viewport meta for their
    // page zoom, but these proprietary gesture events are cancelable and DO
    // block it.
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
      this._listen(this.scroller, t, (ev) => ev.preventDefault(), { passive: false });
    }

    // W6: DOUBLE-TAP ZOOM (zoomConfig.doubleTap*) — view and annotate; text mode's double-tap
    // acts on the text. Away from fit-width it goes home first (PinchZoom.doubleTapTarget).
    this._listen(this.scroller, "dblclick", (ev) => {
      const zc = this.zoomConfig;
      if (this._mode === "text" || !zc.doubleTapEnabled || !this._pages.length) return;
      if (!ev.target?.closest?.("canvas[data-page]")) return;
      ev.preventDefault();
      this._animateZoom(PinchZoom.doubleTapTarget(this._zoom, zc.minZoom, zc.doubleTapZoom), zc.doubleTapDurationMs,
        ev.clientX, ev.clientY, PinchZoom.spring);
    });
    this._listen(this.scroller, "wheel", (ev) => {
      if (!this._scrollEnabled && !ev.ctrlKey) { ev.preventDefault(); return; }   // W6: the pages stay still
      if (!ev.ctrlKey) return;                 // trackpad pinch / ctrl+wheel
      this._stopZoomAnim();
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
    const scaleCss = this._k(Number(el.dataset.page));
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
    const scaleCss = this._k(Number(best.canvas.dataset.page));
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
    const scaleCss = this._k(pt.page);
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
      if (this._editingPage >= 0) this._runTyped = true;   // canDiscard counts it at once (W2)
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
    this._listen(this.sink, "blur", () => {
      this._post({ type: "sealHistory" });
      this._emit("keyboard", { visible: false });     // 3.3.0: the typing target let go
    });
    this._listen(this.sink, "focus", () => this._emit("keyboard", { visible: true }));
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
        this._selectAllInRun();               // the same path selectAllText() takes
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
// The pure knob rules, for web/sdk/handle_policy_test.mjs (no DOM needed).
PdfeEditor._HandlePolicy = HandlePolicy;
// …and the pinch's rules + the zoom config's corrections, for web/sdk/reader_test.mjs.
PdfeEditor._PinchZoom = PinchZoom;
/** DR3: the shell's ink hit test (pdfe_ink_distance's rule in JS), for web/sdk/drawing_test.mjs. */
PdfeEditor._inkHit = inkHit;
PdfeEditor._inkDistance = inkDistance;
PdfeEditor._inkBoxMatrix = inkBoxMatrix;
PdfeEditor._normalizeZoomConfig = normalizeZoomConfig;

export default PdfeEditor;
