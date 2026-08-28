// demo.js — the HOST side of the demo page (docs/EDITOR_SDK.md).
//
// This file is a worked example of everything a host owns: open, save (+ its
// dialogs and destination picking), the edit-mode toggle, zoom buttons, the
// line-mode toggle and its config checkbox, status text and telemetry. The
// editor itself contributes no chrome; it is created once here and driven
// entirely through its API + events.
//
// The chrome was redesigned 2026-08-03 (this page IS the published tester site,
// so it is a product surface): stage states, drag-and-drop open, the theme-driven
// canvas colour, the ⋯ menu and the status bar all live here. Only presentation —
// every SDK call and event below is the same one a third-party host makes. The
// patterns are written up in docs/EDITOR_SDK.md §4a.
//
// It is also our browser test harness, so the window.* hooks earlier sessions'
// verification scripts use are re-exported verbatim (window.worker,
// window.lastOpen, window.lastSave, window.lastSavedFile, window.latencySamples,
// window.showWarning) plus window.pdfe for the instance itself.

import { PdfeEditor } from "./pdfe-editor.js?v=2.1.0-364d0e6-w7a5ee33";

const SAMPLE_PDF = "./sample.pdf";   // build_site.sh → ./sample.pdf
const ENGINE_URL = "./editor.js";            // build_site.sh → ./editor.js
// The ONE canonical font set (docs/FONTS.md §2bis). The SDK's default is `./fonts/` next
// to the WORKER, which is the npm layout; this page serves the repo tree instead, so it
// says where they really are — exactly what a host on a bespoke layout has to do.
const FONTS_URL = "./fonts/";                          // build_site.sh → ./fonts/

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const imeLog = $("imelog");
const setStatus = (s) => { statusEl.textContent = s; };

// ---- chrome state (host-owned presentation only) ----------------------------
// The stage has three looks and CSS picks between them off this one attribute:
// "loading" (engine starting), "empty" (no document — what a tester sees first
// on the published site, which ships no sample PDF), "doc" (the editor).
const stage = $("stage");
const setStage = (s) => { stage.dataset.state = s; };
// The edit/save buttons carry an icon, so their label lives in a <span> — never
// assign to button.textContent here or the icon goes with it.
const label = (btn, text) => { btn.querySelector("span").textContent = text; };
const modeChip = $("modechip");
const setHint = (mode, text) => {
  modeChip.textContent = mode;
  modeChip.classList.toggle("editing", mode !== "View");
  imeLog.textContent = text;
};

// Dev knobs kept from the old viewer: ?tier=1|2 forces a load tier, ?block=KB
// sets the lazy cache block size, ?noopfs pretends this browser cannot stream
// saves (exercises the §7 consent path where OPFS exists).
// ?v=anything overrides the version stamp, i.e. the cache-buster the SDK appends
// to the worker + engine URLs. Local dev needs it: a rebuilt pdfe-worker.js /
// editor.wasm keeps its URL, and browsers cache worker scripts hard enough that
// a plain reload — even a forced one — can keep running the OLD engine. Pass
// ?v=<anything new> (e.g. the time) to be certain you are testing your build.
const params = new URLSearchParams(location.search);
const forcedTier = Number(params.get("tier")) || 0;
// ?pdf=<url> — DEV ONLY: open a specific document instead of the built-in sample,
// so a test link can point straight at the file a bug was reported on. The dev
// server serves the repo root, so ?pdf=../wasm/testdata/cvtemplate.pdf works.
const forcedPdf = params.get("pdf");
const blockKB = Number(params.get("block")) || 0;
const forceInHeap = params.has("noopfs");
// In the DEV tree the stamp is the literal "dev" (build_site.sh replaces it for
// the published site), so the worker/engine cache-buster never changed and a
// plain reload kept running a PREVIOUS engine build from the browser cache —
// twice in one day that produced a "bug still happening" report against an
// engine that no longer existed (2026-08-03). Dev now busts on every load;
// ?v= still overrides for reproducing a specific stamp.
const stamped = $("appver").textContent.trim();
const version = params.get("v") || (stamped === "dev" ? `dev-${Date.now()}` : stamped);
if (version !== stamped) $("appver").textContent = version;

// ---- configuration ---------------------------------------------------------
// This page is the public tester site, so it opens as exactly what a consumer
// gets. The constant is the whole truth at load time — there is no UI to change
// it and nothing is remembered per browser, so every load is identical.
// BOX MOVING IS ON HERE, AND ONLY HERE (user directive 2026-08-10: "box moving will
// be enabled in local host demo").
//
// This page is a DEVELOPER host: it is served raw from `web/` by dev_server.py on
// localhost, and deployed as `/dev/` — the site whose banner says UNRELEASED. It stopped
// being the tester site on 2026-08-07, when the release demo moved to
// `examples/react-demo`, which is built by INSTALLING the published package
// (docs/DEMO_SITES.md). Testers use THAT site. Nobody reaches this one by accident.
//
// ⚠️ THIS IS NOT THE CONSUMER DEFAULT, and turning it on here does not move it.
// The promise in CONSUMER_CONTRACT.md §2bis is that the PACKAGE defaults box moving
// off, which is `this._blockMove = !!opts.blockMove` in the SDK — absent means off.
// A host switching it on is exactly the opt-in that promise describes, the same way a
// consuming product may switch it on. The release demo passes no such option, so it
// stays off there; whether it ever should is the user's call at release time, and is
// deliberately still open.
//
// Parity-gate rule 6 still enforces the real promise on the SDK and on Android; it no
// longer asserts against this file, and says why. Do NOT re-add an assertion here —
// it would be guarding a page no consumer can see.
const BLOCK_MOVE_DEFAULT = true;

// ?move=0 turns it back OFF for a single load, so the shipped default can still be
// observed from this page without editing it. (This is the inverse of the old
// ?move=1 opt-in, which existed while the default was off.)
const blockMoveOn = params.get("move") === "0" ? false : BLOCK_MOVE_DEFAULT;

// DOCUMENT REFLOW (docs/DOCUMENT_REFLOW.md) — EXPERIMENTAL, off unless asked for.
// ?documentReflow=1 turns it on for a load. Off by default because enabling it builds a
// model over EVERY page at open time, and because it is not finished: the destination
// page is not itself re-settled, so a big enough insertion can hang past the bottom of
// the page it lands on.
const documentReflowOn = params.get("documentReflow") === "1" || params.get("flow") === "1";

const editor = new PdfeEditor({
  container: $("editor"),
  engineUrl: ENGINE_URL,
  fontsUrl: FONTS_URL,
  version,                                     // cache-buster (build_site stamps it)
  simulateNoOpfs: forceInHeap,
  blockMove: blockMoveOn,
  documentReflow: documentReflowOn,
});
if (documentReflowOn) {
  // The host's own readout, so what the feature did is visible rather than inferred
  // from the pixels — which is the whole reason this page exists.
  editor.on("documentReflowed", (e) => {
    const bits = [];
    if (e.nudged) bits.push(`${e.nudged} item(s) nudged`);
    if (e.linesMigrated) bits.push(`${e.linesMigrated} line(s) moved to the next page`);
    if (e.itemsMigrated) bits.push(`${e.itemsMigrated} whole item(s) moved`);
    if (e.pagesAdded) bits.push(`${e.pagesAdded} page(s) added`);
    if (e.cascadedPages && e.cascadedPages.length > 1)
      bits.push(`rippled across pages ${e.cascadedPages.map((p) => p + 1).join(", ")}`);
    setStatus(e.undone
      ? `documentReflow: UNDONE — the reflow was reversed (now ${e.pages} pages)`
      : e.redone
      ? `documentReflow: REDONE — the reflow was replayed (now ${e.pages} pages)`
      : `documentReflow: ${bits.join(", ") || "nothing to do"} (now ${e.pages} pages)`);
    console.log("[demo] documentReflowed", e);
  });
  editor.on("pagesChanged", (e) => console.log("[demo] pagesChanged", e));
}
window.pdfe = editor;
window.worker = editor.worker;                 // verification hook (drive the worker directly)
window.latencySamples = editor.latencySamples; // the latency-gate harness reads this

// The surround behind the pages follows this page's theme. The host owns the
// colour (setBackgroundColor) and takes it straight from the --canvas token, so
// the chrome and the editor can never drift apart in light or dark mode.
const darkQ = matchMedia("(prefers-color-scheme: dark)");
function syncCanvasColor() {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
  if (c) editor.setBackgroundColor(c);
}
darkQ.addEventListener("change", syncCanvasColor);
syncCanvasColor();

// ---- password-protected documents (HOST chrome) -----------------------------
// The SDK never prompts: open() rejects with 'password-required' (encrypted, we
// sent no password) or 'password-wrong' (the one we sent was refused), and the
// host decides what to ask and how. This little loop IS the worked example —
// ask, retry the SAME source with the password, repeat until it opens or the
// user gives up. Nothing keeps the password afterwards.
const pwEl = $("pw"), pwInput = $("pwinput"), pwErr = $("pwerr");

function askPassword({ name, wrong }) {
  $("pwname").textContent = name || "";
  pwErr.textContent = wrong ? "That password was not accepted. Try again." : "";
  pwInput.value = "";
  pwEl.classList.add("show");
  pwInput.focus();
  return new Promise((resolve) => {
    const ok = $("pwok"), cancel = $("pwcancel");
    const done = (v) => {
      pwEl.classList.remove("show");
      ok.onclick = null; cancel.onclick = null; pwInput.onkeydown = null;
      pwInput.value = "";          // never leave it sitting in the DOM
      resolve(v);
    };
    ok.onclick = () => done(pwInput.value);
    cancel.onclick = () => done(null);
    pwInput.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); done(pwInput.value); }
      if (ev.key === "Escape") { ev.preventDefault(); done(null); }
    };
  });
}

// Every open in this page goes through here, so protected files work from the
// picker AND from the corpus auto-load without either caring.
async function openDocument(source, opts = {}) {
  let password;
  for (;;) {
    try {
      const info = await editor.open(source, { ...opts, password });
      window.lastOpenError = null;   // verification hook
      return info;
    } catch (e) {
      window.lastOpenError = e.code; // verification hook
      if (e.code !== "password-required" && e.code !== "password-wrong") throw e;
      password = await askPassword({
        name: typeof source === "string" ? source : source.name,
        wrong: e.code === "password-wrong",
      });
      if (password === null) {       // user cancelled: leave the viewer empty
        if (!editor.pageCount) setStage("empty");
        setStatus("locked document — no password given");
        return null;
      }
    }
  }
}
window.openDocument = openDocument;  // verification hook (the browser harness drives it)

// WHICH ENGINE IS THIS TAB ACTUALLY RUNNING? Shown in the version badge's
// tooltip and logged once. A rebuilt editor.wasm keeps its URL, so a browser
// can serve a cached one and present a fixed bug as unfixed — that happened
// twice on 2026-08-03 and cost two debugging rounds. The engine's
// Last-Modified is the one fact that settles it; if it predates your rebuild,
// the tab is stale, not the code. (The dev server now sends no-store, so this
// is a check, not a workaround — scripts/dev_server.py.)
fetch(ENGINE_URL.replace(/\.js$/, ".wasm"), { method: "HEAD" })
  .then((r) => {
    const built = r.headers.get("last-modified");
    if (!built) return;
    const badge = $("appver");
    badge.title = `engine built ${built}`;
    // Also readable without hovering: the overflow menu states it in words, so a
    // tester filing "this is stale" can quote the engine's build time.
    $("enginenote").textContent = `engine built ${built}`;
    console.log(`[pdfe] engine editor.wasm built ${built} — version stamp "${version}"`);
  })
  .catch(() => { $("enginenote").textContent = "engine build time unavailable"; });

// ---- engine ready → load the corpus sample ---------------------------------
editor.on("ready", (caps) => {
  $("opfsbadge").hidden = caps.canStreamSave;
  setStatus("engine ready — loading corpus PDF…");
  // The published site ships no sample (build_site.sh), so this normally fails
  // there and the empty state takes over — that is the intended first screen.
  openDocument(forcedPdf || SAMPLE_PDF).catch(() => {
    setStage("empty");
    setStatus("engine ready");
  });
});

editor.on("opened", (info) => {
  window.lastOpen = info;                      // verification hook (tier / io / heap)
  setStage("doc");
  const name = editor.documentName || "";
  $("docname").textContent = name;
  $("docname").hidden = !name;
  $("docname").title = name;
  setStatus(`${info.pages} ${info.pages === 1 ? "page" : "pages"} — ${describeLoad(info)}`);
});

// Unsaved-changes dot on the Save button.
editor.on("dirty", ({ dirty }) => { $("save").classList.toggle("dirty", dirty); });

// ---- undo / redo (dev testing of true text undo, 2026-08-05) ---------------
// The history lives in the ENGINE (docs/UNDO_REDO.md), so the button state is
// MIRRORED from it and never computed here — the host cannot know what is
// undoable. Ctrl+Z / Ctrl+Y are bound by the editor itself (undoShortcuts:
// "auto"); these buttons are the same two calls for a tester with a trackpad.
$("undo").addEventListener("click", () => editor.undo());
$("redo").addEventListener("click", () => editor.redo());
editor.on("history", (h) => {
  $("undo").disabled = !h.canUndo;
  $("redo").disabled = !h.canRedo;
  $("undo").title = h.canUndo ? `undo (Ctrl+Z) — page ${h.undoPage + 1}` : "nothing to undo";
  $("redo").title = h.canRedo ? `redo (Ctrl+Y) — page ${h.redoPage + 1}` : "nothing to redo";
});
// Every step LEAVES the editing box by design (a step is a document-level action,
// not something that happens under the caret), so say what happened: the box comes
// back selected and the user taps to type again.
// The SDK emits the STEP KIND ("undo" / "redo"), not a generic event.
for (const kind of ["undo", "redo"]) {
  editor.on(kind, (r) => {
    setStatus(r.ok
      ? `${kind} applied on page ${r.page + 1} — the box is selected again, tap to type`
      : `nothing left to ${kind} here`);
    // AND STOP THE STYLING CONTROLS ASSERTING A VALUE. A step leaves the editing box
    // (the line above says so), and with no run open there is nothing to read a style
    // from — so a control still showing the last pick is claiming something the
    // document does not say. Found while testing I65 here: pick 20 pt, press undo, and
    // the page went correctly back to 9.96 pt while the dropdown still read "20",
    // which reads as "the undo did not work".
    //
    // Hooked to the STEP events, not to `editclose` — measured 2026-08-18: an
    // undo closes the run (editing goes false) WITHOUT emitting editclose, so a
    // host listening only to that never learns the box went away.
    if (!editor.editing) resetStyleControls();
    if (r.ok) setHint("Typing", `${kind} applied — size, text and line positions all ` +
      "come from the restored objects");
  });
}

function describeLoad(info) {
  const mb = (info.bytes / (1024 * 1024)).toFixed(1);
  if (info.tier !== 2) return `${mb} MB copied into the heap (tier 1) in ${info.openMs} ms`;
  const io = info.io || {};
  return `${mb} MB LAZY (tier 2) in ${info.openMs} ms — ${io.calls} reads, ` +
    `${((io.readBytes || 0) / (1024 * 1024)).toFixed(1)} MB fetched, heap ${info.heapMB} MB`;
}

editor.on("painted", (p) =>
  setStatus(`${editor.pageCount} pages @ ${Math.round(editor.zoom * 100)}% — ` +
            `p${p.page + 1} base ${p.baseMs} ms, ${p.tiles} tiles queued`));
editor.on("tile", (t) => {
  if (t.left === 0) setStatus(`${editor.pageCount} pages @ ${Math.round(editor.zoom * 100)}% — tiles sharp (last ${t.ms} ms)`);
});
editor.on("error", (e) => setStatus(`error: ${e.detail}`));

// ---- open (host-owned file picking) ----------------------------------------
function openFile(f) {
  if (!f) return;
  openDocument(f, { tier: forcedTier, blockKB }).catch((e) => {
    if (!editor.pageCount) setStage("empty");
    setStatus(`error: ${e.message}`);
  });
}
$("file").addEventListener("change", (ev) => openFile(ev.target.files[0]));

// ---- DEV-ONLY: quick-open from test-files/ ----------------------------------
// This page is served from the repo root (dev_server.py), so the local corpus in
// test-files/ is reachable at ../test-files/ from here. The plain http.server
// subclass we run offers no JSON listing API, only the directory-index HTML it
// already renders — so we parse the <a href> list out of that instead of adding
// a server endpoint for dev tooling. Off the published site (which ships no
// test-files/) the fetch 404s and the control just stays hidden.
const testFilesBox = $("testfilesbox"), testFilesSelect = $("testfiles");
async function loadTestFiles() {
  let hrefs;
  try {
    const res = await fetch("../test-files/");
    if (!res.ok) return;
    hrefs = [...(await res.text()).matchAll(/<a href="([^"]+\.pdf)">/gi)].map((m) => m[1]);
  } catch {
    return;
  }
  if (!hrefs.length) return;
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = "Test files…";
  testFilesSelect.appendChild(placeholder);
  for (const href of hrefs) {
    const o = document.createElement("option");
    o.value = `../test-files/${href}`;
    o.textContent = decodeURIComponent(href);
    testFilesSelect.appendChild(o);
  }
  testFilesBox.hidden = false;
}
loadTestFiles();
testFilesSelect.addEventListener("change", (ev) => {
  const url = ev.target.value;
  testFilesSelect.value = "";   // reset so re-picking the same file still fires `change`
  if (!url) return;
  openDocument(url).catch((e) => {
    if (!editor.pageCount) setStage("empty");
    setStatus(`error: ${e.message}`);
  });
});

// Drag-and-drop onto the stage — host chrome, same one call as the picker. The
// window-level handlers exist because a drop that misses the stage would
// otherwise make the browser NAVIGATE to the PDF and throw the tab away.
["dragenter", "dragover"].forEach((t) => stage.addEventListener(t, (ev) => {
  if (![...(ev.dataTransfer?.types || [])].includes("Files")) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
  stage.classList.add("drag");
}));
stage.addEventListener("dragleave", (ev) => {
  if (!ev.relatedTarget || !stage.contains(ev.relatedTarget)) stage.classList.remove("drag");
});
stage.addEventListener("drop", (ev) => {
  ev.preventDefault();
  stage.classList.remove("drag");
  openFile(ev.dataTransfer?.files?.[0]);
});
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => { ev.preventDefault(); stage.classList.remove("drag"); });

// ---- overflow menu (keeps the dev-only knobs out of a tester's way) --------
const menu = $("menu"), moreBtn = $("more");
const closeMenu = () => { menu.classList.remove("show"); moreBtn.setAttribute("aria-expanded", "false"); };
moreBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = !menu.classList.contains("show");
  menu.classList.toggle("show", open);
  moreBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (ev) => { if (!menu.contains(ev.target)) closeMenu(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });

// ---- edit mode + line mode -------------------------------------------------
const editBtn = $("editmode");
editBtn.addEventListener("click", () => editor.toggleEditMode());
editor.on("editmode", ({ editMode }) => {
  label(editBtn, editMode ? "Done" : "Edit");
  editBtn.classList.toggle("active", editMode);
  setHint(editMode ? "Edit" : "View", editMode
    ? "Edit mode — tap a paragraph to select it, then Edit or Delete"
    : "View mode — press Edit to enable editing");
  $("colorbox").hidden = !editMode;
  $("fontbox").hidden = !editMode;
  $("addtext").hidden = !editMode;      // placing text is editing
});

// ---- ADD TEXT (docs/ADD_TEXT.md) -------------------------------------------
// A TOGGLE, not an action: the mode is armed until a tap spends it. Three host
// rules, and they are the same three the Android demo will need:
//
//  1. NEVER un-press this button ourselves. The SDK owns the arm's lifetime — the
//     placing tap disarms it — so the button is painted from `addtextarmed` and
//     from nothing else. A host that cleared it on click would be lying whenever
//     the arm survived (a tap that lands off-page, say).
//  2. Seed the new text from the toolbar the user can see, so what they placed
//     looks like what the controls said. This is `setNewTextStyle`, the host-side
//     default the feature is designed around.
//  3. Escape disarms, because an armed mode with no way out is a trap.
const addTextBtn = $("addtext");
addTextBtn.addEventListener("click", () => {
  if (editor.addingText) { editor.cancelAddText(); return; }
  // Rule 2: hand over what the toolbar is showing. The family select carries a
  // familyKey in its value; an empty value means "Original", which for NEW text has
  // no meaning — there is no original — so we let the SDK use its own floor.
  const fam = $("fontfamily").value || null;
  const size = Number($("fontsize").value) || 0;
  editor.setNewTextStyle({ font: fam, size, color: colorInput.value });
  editor.armAddText();
});
editor.on("addtextarmed", ({ armed }) => {
  addTextBtn.classList.toggle("active", armed);
  addTextBtn.setAttribute("aria-pressed", armed ? "true" : "false");
  if (armed) setHint("Add text", "Tap the page where the new text should go");
});
// Rule 3: an armed mode needs an exit that is not "guess".
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && editor.addingText) editor.cancelAddText();
});


// ---- text colour (HOST chrome) ---------------------------------------------
// The SDK owns no palette: it takes any 0xAARRGGBB (or a hex string) and reports
// what the engine finds. Everything here — the control, and what "mixed" looks
// like — is ours.
const colorInput = $("textcolor"), colorMixed = $("colormixed");
const hex2 = (n) => n.toString(16).padStart(2, "0");

// Paint the swatch from the ENGINE's answer. A NULL colorArgb means the selection
// spans more than one colour, and <input type="color"> cannot render indeterminate
// — hence the separate "mixed" chip rather than a lie in the swatch.
function showTextStyle(style) {
  // STICKY MODE: DO NOT REPAINT (user decision 2026-08-13, docs/STYLING.md §2). The
  // report is the colour UNDER the cursor, and while a sticky pick is armed that is not
  // what the next keystroke takes — so a swatch painted from it would say "black" while
  // typing produces red. The host, which owns the switch, is the one that knows; the
  // Android harness does exactly this in onTextSelectionChanged.
  // …AND WHEN ONE IS ARMED, SHOW IT — the swatch keeps the picked colour through a box
  // close, for the reason spelled out at stickyFamilyValue above. With sticky merely
  // ENABLED and nothing picked, the report is still the truth and is painted as usual.
  if (stickyColour()) { colorInput.value = stickyColorHex; colorMixed.hidden = true; return; }
  const argb = style && style.colorArgb;
  colorMixed.hidden = !(style && style.colorArgb === null);
  if (argb == null) return;
  colorInput.value =
    "#" + hex2((argb >>> 16) & 0xff) + hex2((argb >>> 8) & 0xff) + hex2(argb & 0xff);
}

// ---- font family + bold/italic (HOST chrome, and HOST-SUPPLIED FACES) -------
// THE HOST PROVIDES THE VARIANTS (user decision 2026-08-13, docs/FONTS.md §2). The SDK
// bundles no font catalog, so this list is ours and so are the bytes behind it. This
// page offers the standard-14 ladder because those need no bytes at all — a product
// would ship its own faces and pass them as ArrayBuffers instead.
//
// WHY BOTH FACES OF EACH FAMILY ARE REGISTERED, and this is the part a real host has
// to copy: bold/italic resolve the SIBLING FACE of the family under the cursor. If
// only "Helvetica" were registered, B on Helvetica text would be refused — correctly,
// because nothing supplied a bold face. Registering the whole family is what makes the
// B button light up.
const HOST_FACES = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
];
// What the PICKER offers is deliberately narrower than what is REGISTERED: a user
// picks a family, and the bold/italic buttons reach the rest. Offering
// "Helvetica-BoldOblique" as a family would be a UI that asks the user to do the
// engine's job.
// Each entry carries the FAMILY KEY the SDK reports for it, because the picker must
// match on that and not on the display name: text under the cursor reads
// "Helvetica-Bold" while the family the user chose is "Helvetica". The keys are the
// SDK's normalized form (lowercase, style suffix and spaces gone), which for the
// standard-14 ladder is just the leading word.
const PICKER_FAMILIES = [
  ["", "Original", null],
  ["Helvetica", "Helvetica (sans)", "helvetica"],
  ["Times-Roman", "Times (serif)", "times"],
  ["Courier", "Courier (mono)", "courier"],
];
const fontSelect = $("fontfamily"), boldBtn = $("bold"), italicBtn = $("italic");
for (const [value, text] of PICKER_FAMILIES) {
  const o = document.createElement("option");
  o.value = value; o.textContent = text;
  fontSelect.appendChild(o);
}

// THE SDK'S OWN BUNDLED FAMILIES, appended to the picker as the SDK reports them
// (docs/FONTS.md §2bis). They register themselves on every open, so this is not delivery —
// it is discovery: `prepareFonts()` tells the host WHICH families exist and WHEN they are
// usable, which is exactly what a picker needs and what a spinner waits on.
//
// The family KEY is what `applyFont` takes here, not a face name: the SDK resolves the
// family's regular face itself, and B/I then reach the rest of the ladder.
// Keyed by the family key (what a style report matches on); the option's VALUE is the
// family's regular FACE name, because that is what applyFont() takes.
const bundledOptions = new Map();
function addBundledFamilies(families) {
  for (const f of families) {
    if (!f.regular || bundledOptions.has(f.key)) continue;
    const o = document.createElement("option");
    o.value = f.regular; o.textContent = f.label;
    bundledOptions.set(f.key, o);
    fontSelect.appendChild(o);
  }
}
// A MIXED selection needs a blank option to select — <select> cannot render
// indeterminate, and showing one of several families would be the lie the SDK's own
// MIXED rule exists to prevent.
const mixedOption = document.createElement("option");
mixedOption.value = "__mixed"; mixedOption.textContent = "(mixed)";
mixedOption.hidden = true;
fontSelect.appendChild(mixedOption);
// A SECOND placeholder, because there are two different truths a <select> cannot show
// and collapsing them would misinform. The one above is the SDK's MIXED (several
// families, where naming one would be the lie its MIXED rule exists to prevent); this
// one is ONE family that this page does not offer -- which every document in the
// corpus is, since they embed Arial and Calibri and this page ships standard-14.
const otherOption = document.createElement("option");
otherOption.value = "__other"; otherOption.textContent = "(document font)";
otherOption.hidden = true;
fontSelect.appendChild(otherOption);

// …AND IT SHOWS THE FONT'S REAL NAME (user, 2026-08-18). The label above was a fixed
// string, so a CV set in Arial read "(document font)" — the SDK had reported "ArialMT"
// all along and this host threw it away. It is a placeholder for a family this PAGE
// does not offer, not for a font nobody can name.
//
// Two details the fallback chain has to get right:
//   * the SUBSET TAG is display noise. The SDK keeps it deliberately (it is part of the
//     font's identity in the file), so stripping it is the host's call, not the SDK's.
//   * `fontName` is null as soon as the range spans two NAMES — which is exactly the
//     "Forename SURNAME" case, where the FAMILY is still uniform. Falling back to the
//     family key there is what keeps the picker reading "Arial" instead of "(mixed)".
const stripSubsetTag = (n) => String(n || "").replace(/^[A-Z]{6}\+/, "");
const titleCaseKey = (k) => k ? k.charAt(0).toUpperCase() + k.slice(1) : "";
function labelDocumentFont(style) {
  const named = stripSubsetTag(style && style.fontName);
  if (named) return named;
  const fam = style && style.fontFamily;
  return fam ? titleCaseKey(fam) : "(document font)";
}

// Faces are registered once per OPENED DOCUMENT: the handles belong to the document,
// so they do not survive opening another file.
editor.on("opened", async () => {
  const results = await Promise.all(HOST_FACES.map((name) => editor.loadFont({ name })));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length) setHint("Fonts", `could not register: ${failed.join(", ")}`);

  // AND WAIT FOR THE SDK'S OWN SET. This is the host-visible loading step: the faces are
  // already registering by themselves, and `prepareFonts()` is how a host knows when to
  // stop saying "loading". Showing that state is the point of the API.
  setHint("Fonts", "loading the bundled families…");
  const bundled = await editor.prepareFonts();
  addBundledFamilies(bundled.families);
  setHint("Fonts", bundled.families.length
    ? `${bundled.families.length} bundled families ready` +
      (bundled.failed.length ? ` (${bundled.failed.length} failed)` : "")
    : "no bundled families available");
});

fontSelect.addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (v.startsWith("__")) return;              // a placeholder is not a choice
  editor.applyFont(v === "" ? null : v);
  // "" is Original — the END of a sticky pick, not a new one. A family pick at a bare
  // caret arms the family's REGULAR face (I72, by design), so the B/I memory goes with it.
  if (!editor.typingFontFollowsCaret) {
    stickyFamilyValue = v === "" ? null : v;
    stickyFace = v === "" ? null : { bold: false, italic: false };
  }
});

// ---- font SIZE (phase 3) ----------------------------------------------------
// Presets the user picked, plus "Custom…" — a dropdown cannot express 11.5 pt and the
// property is continuous, so refusing the odd value would make the control lie about
// what the SDK accepts.
const SIZE_PRESETS = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
// What the size control reads before the user has selected any text — and
// therefore what NEW text is created at (see buildSizeOptions).
const DEFAULT_SIZE_PT = 11;
const sizeSelect = $("fontsize");
// The engine's most recent answer, kept only so the "Custom…" prompt can put the
// control back if the user cancels — never as the source of truth for painting.
let lastTextStyle = null;
// MIXED and the document's own size get their own options, for the family picker's
// reason: a range spanning two sizes has no single answer, and snapping the closed
// <select> to the nearest preset would report a size the document does not have.
const sizeMixedOption = document.createElement("option");
sizeMixedOption.value = "__mixed";
sizeMixedOption.textContent = "mixed";
sizeMixedOption.hidden = true;
const sizeOtherOption = document.createElement("option");
sizeOtherOption.value = "__other";
sizeOtherOption.hidden = true;
function buildSizeOptions() {
  sizeSelect.textContent = "";
  for (const pt of SIZE_PRESETS) {
    const o = document.createElement("option");
    o.value = String(pt);
    o.textContent = String(pt);
    sizeSelect.appendChild(o);
  }
  const custom = document.createElement("option");
  custom.value = "__custom";
  custom.textContent = "Custom…";
  sizeSelect.appendChild(custom);
  sizeSelect.appendChild(sizeMixedOption);
  sizeSelect.appendChild(sizeOtherOption);
  // START ON A SENSIBLE BODY SIZE, not on whatever happens to be first in the
  // list. A <select> with no value selects its first <option>, which was 6 —
  // and that is not cosmetic: the Add-text button SEEDS THE NEW BOX from this
  // control (rule 2 above), so a new text box was created at 6 pt unless the
  // user thought to change the picker first.
  sizeSelect.value = String(DEFAULT_SIZE_PT);
}
buildSizeOptions();

sizeSelect.addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (v === "__custom") {
    const typed = prompt("Font size in points:", "");
    // Restore the control before applying: if the user cancels or types nonsense the
    // dropdown must not be left reading "Custom…", which is not a size.
    const pt = Number(typed);
    if (!(pt > 0)) { showSizeStyle(lastTextStyle); return; }
    editor.applyFontSize(pt);
    return;
  }
  if (v.startsWith("__")) return;               // a placeholder is not a choice
  editor.applyFontSize(Number(v));
});

// THE SIZE CONTROL MUST NOT CLAIM A SIZE WHEN THERE IS NO RUN TO READ ONE FROM.
// Painting from the engine's answer is the rule, and with no run open there is no
// answer — so the honest state is the blank placeholder, not the user's last pick.
function resetSizeControl() {
  lastTextStyle = null;
  sizeOtherOption.textContent = "";
  sizeSelect.value = "__other";
}

// …AND NEITHER MUST ANY OF THE OTHERS (2026-08-19). The rule above was written for the
// size dropdown and then applied only to it, so after an undo the family select still
// read "Times (serif)" and B/I still looked pressed while the page had gone back to
// plain Arial — the very confusion the size fix existed to stop ("the undo did not
// work"), just three controls over. GENERAL, not conditioned: the honest state with no
// run open is "no answer" for every styling control, so they all reset together.
//
// Android already did this (its readout row goes to `font: —` / Size `—` / Colour `—`
// and greys B/I), so this was also a one-platform drift — the asymmetry CLAUDE.md warns
// about, where the same version behaves differently depending on which app you open.
function resetStyleControls() {
  resetSizeControl();
  // ⚠️ A STICKY PICK SURVIVES THE CLOSE — this reset is what blanked the picker while
  // the pick was still applying to new text (user-reported 2026-08-20). Size is never
  // sticky (it has one lifetime), so it resets above regardless.
  if (!stickyTypeface()) {
    otherOption.textContent = "";
    fontSelect.value = "__other";
    boldBtn.classList.remove("active");
    italicBtn.classList.remove("active");
  }
  // Disabled, because with no run open pressing them would do nothing — the same
  // "would this change anything" question `canBold`/`canItalic` answer while editing.
  boldBtn.disabled = true;
  italicBtn.disabled = true;
  colorMixed.hidden = true;
}

// Paint the size control from the ENGINE's answer, never from what we last sent — the
// same rule the font controls follow. `sizePt` is null when the range mixes sizes.
function showSizeStyle(style) {
  if (!style) return;
  const pt = style.sizePt;
  if (pt == null) { sizeSelect.value = "__mixed"; return; }
  // Round for the MATCH only, never for the apply: the document's size is a float and
  // 9.96 pt is a real value (cvtemplate's body text is exactly that). Matching on a
  // rounded number is what lets 9.96 select the "10" preset instead of falling through
  // to "__other" on every single caret move.
  const near = SIZE_PRESETS.find((p) => Math.abs(p - pt) < 0.05);
  if (near != null) { sizeSelect.value = String(near); return; }
  // Not a preset: name the document's actual size, so the closed control tells the
  // truth. Two decimals, trimmed — "9.96", not "9.960000038146973".
  sizeOtherOption.textContent = `${Math.round(pt * 100) / 100}`;
  sizeSelect.value = "__other";
}
boldBtn.addEventListener("click", () => {
  const on = !boldBtn.classList.contains("active");
  editor.applyBold(on);
  if (!editor.typingFontFollowsCaret)
    stickyFace = { bold: on, italic: !!(stickyFace && stickyFace.italic) };
});
italicBtn.addEventListener("click", () => {
  const on = !italicBtn.classList.contains("active");
  editor.applyItalic(on);
  if (!editor.typingFontFollowsCaret)
    stickyFace = { bold: !!(stickyFace && stickyFace.bold), italic: on };
});

// Paint the font controls from the ENGINE's answer — never from what we last sent.
// Three separate MIXED cases, and they are independent: the FAMILY can be uniform
// while bold-ness is not (Arial + Arial-Bold), which is exactly why the SDK reports
// them as separate fields.
// ---- WHAT THIS HOST HAS ARMED, AND WHY IT HAS TO REMEMBER (user-reported twice,
// 2026-08-20) ------------------------------------------------------------------------
//
// A STICKY PICK MUST STAY VISIBLE UNTIL THE HOST TURNS STICKY OFF. That is the user's
// rule, in their words: *"a sticky font and colour will always show after the user
// selects one, and it should still show if we re-enter a box."*
//
// Two things stood in the way, and both are the HOST's, which is why they are fixed
// here and not in the SDK (docs/STYLING.md §2 settled that ownership):
//   1. the style report describes the character UNDER the cursor, which is not what the
//      next keystroke takes while a pick is armed — so painting from it would lie;
//   2. `resetStyleControls()` blanks the controls when the box closes, and *nothing was
//      allowed to fill them in again* — the reported symptom exactly: the pick kept
//      applying to new text while the picker showed nothing.
//
// So the rule is not "do not repaint" but **"repaint from the PICK"**, and the pick
// survives a box close. Null means nothing is armed, and then the report is the truth.
let stickyFamilyValue = null;   // the <select> value the host applied ("" = Original)
let stickyFace = null;          // { bold, italic } once B or I armed one
const stickyTypeface = () => !editor.typingFontFollowsCaret &&
                             (stickyFamilyValue !== null || stickyFace !== null);
let stickyColorHex = null;      // the swatch value the host applied
const stickyColour = () => !editor.typingColorFollowsCaret && stickyColorHex !== null;

// Paint the font controls from what the HOST armed. Only ever called while
// stickyTypeface() — the report is ignored on purpose, except for the two ENABLED flags,
// which are about the caret's family and not about the pick.
function showStickyTypeface(style) {
  if (stickyFamilyValue !== null) fontSelect.value = stickyFamilyValue || "__other";
  boldBtn.classList.toggle("active", !!(stickyFace && stickyFace.bold));
  italicBtn.classList.toggle("active", !!(stickyFace && stickyFace.italic));
  if (style) {
    boldBtn.disabled = !style.canBold;
    italicBtn.disabled = !style.canItalic;
  }
}

function showFontStyle(style) {
  if (!style) return;
  // STICKY MODE, WHILE A PICK IS ARMED: show the PICK, not the report. The report
  // describes the character under the cursor, which is not what the next keystroke takes
  // while a pick is armed (docs/STYLING.md §2bis).
  //
  // ⚠️ TWO HALVES ARE LOAD-BEARING, and each was reported by the user in turn: it fires
  // only while a pick is ARMED (with sticky merely enabled and nothing picked, the report
  // IS the truth), and it PAINTS THE PICK rather than skipping the repaint — skipping left
  // the picker blank after a box close while the pick kept applying.
  if (stickyTypeface()) { showStickyTypeface(style); return; }
  // The picker matches on the FAMILY KEY, not on the display name: the text under the
  // cursor reads "Helvetica-Bold" while the family the user picked is "Helvetica".
  const fam = style.fontFamily;
  const opt = fam == null ? null : PICKER_FAMILIES.find(([, , key]) => key === fam);
  // A bundled family is matched the same way — on the KEY the SDK reports, never on the
  // display name — and its option carries the regular face as its value.
  const bundled = fam == null ? null : bundledOptions.get(fam);
  // Name the document's own font before selecting the placeholder, so the closed
  // <select> reads "Arial" rather than a generic label.
  otherOption.textContent = labelDocumentFont(style);
  fontSelect.value = fam == null ? "__mixed"
    : opt ? opt[0]
    : bundled ? bundled.value
    : "__other";
  // PRESSED state from `boldPressed`/`italicPressed`; ENABLED state from
  // `canBold`/`canItalic`. Two different questions: "should the button look pressed"
  // and "would pressing it do anything". A family with no bold face is refused by the
  // SDK, and a disabled button is how the user learns that without clicking.
  //
  // NOT from `bold`/`italic` (2026-08-18). Those go null over a mix and stay null after
  // a partial apply, so painting from them leaves the button un-pressed while the SDK
  // considers the range bold — press it again and this host would send "on" a second
  // time and the toggle would never come back off.
  boldBtn.classList.toggle("active", style.boldPressed === true);
  italicBtn.classList.toggle("active", style.italicPressed === true);
  boldBtn.disabled = !style.canBold;
  italicBtn.disabled = !style.canItalic;
  // AND WHETHER PRESSING IT WOULD CHANGE THE TYPEFACE. The family may have no such
  // face, in which case a metric-compatible sibling serves it — Arial's bold italic
  // comes from Helvetica's. The SDK reports that so a host can be honest about it, and
  // a reference host that ignored its own report would be setting the wrong example.
  // A title + a marker class, because the button must still read as available.
  const subBold = !!style.boldWouldSubstitute, subItalic = !!style.italicWouldSubstitute;
  boldBtn.classList.toggle("substitutes", subBold);
  italicBtn.classList.toggle("substitutes", subItalic);
  boldBtn.title = subBold ? "Bold — from a metric-compatible family (this one has no bold face)" : "Bold";
  italicBtn.title = subItalic ? "Italic — from a metric-compatible family (this one has no italic face)" : "Italic";
  if (subBold || subItalic) {
    setHint("Fonts", `${[subBold && "bold", subItalic && "italic"].filter(Boolean).join(" and ")} ` +
      `would come from a metric-compatible family — this one has no such face`);
  }
  // AND WHETHER THE PRESS WILL REACH EVERYTHING. Same contract as the substitution
  // report above and disclosed the same way: before the click, from the same read that
  // enables the button. A selection crossing a symbolic bullet is the everyday cause —
  // the words bold and the bullet cannot, which is correct and needs saying.
  const partBold = !!style.boldPartial, partItalic = !!style.italicPartial;
  boldBtn.classList.toggle("partial", partBold);
  italicBtn.classList.toggle("partial", partItalic);
  if (partBold || partItalic) {
    setHint("Fonts", `${[partBold && "bold", partItalic && "italic"].filter(Boolean).join(" and ")} ` +
      `will not reach every character — some fonts in this selection have no such face`);
  }
}

// The refusal, as a host sees it. It is an `error` event with its own code rather than
// a silent no-op precisely so this message can exist.
editor.on("error", ({ code }) => {
  if (code === "no-such-face")
    setHint("Fonts", "this family has no such face — the SDK refuses rather than faking it");
  if (code === "mixed-fonts")
    setHint("Fonts", "the selection spans two fonts — select text in one font");
});

// LIVE while the user drags inside the picker (user requirement 2026-08-11: "it must
// reflect live on the selected text"), so `input` — which fires continuously — not
// just `change`, which only fires when the picker closes.
//
// Two things make that safe, and both are needed:
//   * the CORE coalesces consecutive style applies to the same range into ONE undo
//     step, so a whole drag is a single Ctrl+Z (undo.cpp, pdfeUndoRecordStyle);
//   * this throttle keeps us off the every-frame path — each apply is a real
//     split/coalesce/rebuild/re-render, and the picker can fire far faster than that
//     is worth doing. A trailing call guarantees the LAST colour always lands, which
//     is the one the user actually chose.
let colorPending = null, colorTimer = 0;
const COLOR_THROTTLE_MS = 60;
function applyColorThrottled(value) {
  colorPending = value;
  if (colorTimer) return;
  const fire = () => {
    colorTimer = 0;
    if (colorPending === null) return;
    const v = colorPending;
    colorPending = null;
    editor.applyTextColor(v);
    colorTimer = setTimeout(fire, COLOR_THROTTLE_MS);   // trailing edge
  };
  fire();
}
colorInput.addEventListener("input", (ev) => applyColorThrottled(ev.target.value));
// The authoritative final value when the picker closes — the throttle may have
// dropped the last `input`, and this is the colour the user committed to.
colorInput.addEventListener("change", (ev) => {
  editor.applyTextColor(ev.target.value);
  if (!editor.typingColorFollowsCaret) stickyColorHex = ev.target.value;
});

// STICKY vs FOLLOW-THE-CARET — host chrome for the SDK's own switch (§2). Checked means
// the pick is fixed until cleared; unchecked (default) means the caret decides.
const stickyColor = $("stickycolor");
stickyColor.addEventListener("change", () => {
  const sticky = stickyColor.checked;
  editor.setTypingColorFollowsCaret(!sticky);
  stickyColorHex = null;      // nothing armed yet in either direction
  setHint("Typing", sticky
    ? "Sticky colour ON — the picked colour survives cursor moves; the swatch stops following"
    : "Sticky colour OFF — the picked colour is dropped when the cursor moves");
});

// The TYPEFACE twin of the switch above (docs/STYLING.md §2bis). Checked means a family
// pick or a B/I press survives cursor moves and box changes until it is turned back off.
const stickyFont = $("stickyfont");
stickyFont.addEventListener("change", () => {
  const sticky = stickyFont.checked;
  editor.setTypingFontFollowsCaret(!sticky);
  // Either direction starts with nothing armed — and turning sticky OFF is the "stop"
  // switch the client asked for: from here everything follows the caret again.
  stickyFamilyValue = null;
  stickyFace = null;
  setHint("Typing", sticky
    ? "Sticky typeface ON — the picked font and bold/italic survive cursor moves and box changes; the picker stops following"
    : "Sticky typeface OFF — the pick is dropped when the cursor moves");
});

// The cursor moved or the range changed — the engine reports the colour there, and
// per the agreed UX the swatch follows the cursor. The SDK owns the override's
// LIFETIME (drop on a real cursor move, keep on a click back to the same index
// after a pick — docs/STYLING.md §2); a host that also called clearTypingColor()
// here would defeat that same-index rule, which is exactly what this handler did
// until 2026-08-13. Hosts only paint.
editor.on("selection", ({ start, end, style }) => {
  lastTextStyle = style;
  showTextStyle(style);
  showFontStyle(style);
  showSizeStyle(style);
});
editor.on("styled", ({ what, style, following, fontName, partial }) => {
  showTextStyle(style);
  if (what === "typingFont") {
    // Arming a font paints nothing, so there is no style to read back — the event
    // names the face the next keystroke takes, and the picker shows that.
    if (fontName != null) fontSelect.value = fontName;
    setHint("Typing", `Font armed: ${fontName || "Original"} — it applies to what you ` +
      "type next, and is dropped when you move the cursor");
  } else {
    showFontStyle(style);
    showSizeStyle(style);
  }
  if (what === "color") setHint("Typing", "Colour applied — Ctrl+Z undoes it");
  if (what === "size") {
    // The one property that moves geometry, so say what to look at: the lines below
    // ride down, and the whole point of I65 is that ONE Ctrl+Z puts them back.
    setHint("Typing", style && style.sizePt != null
      ? `Size ${Math.round(style.sizePt * 100) / 100} pt applied — Ctrl+Z restores the ` +
        "old size AND the line positions"
      : "Size applied — Ctrl+Z undoes it");
  }
  if (what === "font") setHint("Typing", "Font applied — Ctrl+Z undoes it");
  if (what === "face")
    // `partial` is on the event as well as on the style report, because the two answer
    // it at different moments: the report warns BEFORE the click, this confirms what
    // actually happened. Either way it is one undo step.
    setHint("Typing", partial
      ? "Face applied where it could — some characters' fonts have no such face. Ctrl+Z undoes it all"
      : "Face applied — Ctrl+Z undoes it");
  // The cursor moved to text of a different colour: the swatch follows it, so the
  // user sees what the next character will be before typing it. `following` is
  // false when the host asked for a sticky picked colour instead.
  if (what === "caret" && following && style && style.colorArgb != null) {
    setHint("Typing", "Cursor moved — the swatch now shows the colour here");
  }
});
// A freshly opened run reports the style AT ITS CARET by itself (a `styled`
// event with what:"caret"), so there is nothing to ask for here. This used to
// call requestTextStyle(0, 0) — the style at the START of the run — which showed
// the first word's colour no matter where the user actually put the cursor.
editor.on("editclose", () => resetStyleControls());

// Select-then-act: the SDK draws the selected box and its Edit/Delete bar; the
// host only reports it (and could drive the same actions from its own chrome).
editor.on("select", ({ selection }) => {
  if (!selection) {
    setHint("Edit", "Edit mode — tap a paragraph or a picture to select it");
    return;
  }
  // A PICTURE IS NOT A PARAGRAPH, and the hint must not offer what it cannot do:
  // neither Edit nor Delete applies to one, and the rotate control is the handle
  // the SDK draws on the picture itself.
  if (selection.kind === "image") {
    setHint("Selected", `Selected a picture on p${selection.page + 1}` +
      (selection.quarterTurns ? ` (turned ${selection.quarterTurns * 90}°)` : "") +
      " — drag it, or use the round button on its corner to rotate");
    return;
  }
  setHint("Selected",
    `Selected p${selection.page + 1} box #${selection.index} — Edit, Delete, ` +
    "or tap it again to type");
});
editor.on("rotated", ({ page, ok, quarterTurns }) => {
  setHint("Selected", ok
    ? `Rotated the picture on p${page + 1} to ${(quarterTurns ?? 0) * 90}°`
    : `Could not rotate that picture on p${page + 1}`);
});
editor.on("deleted", ({ page, ok }) => {
  setHint("Edit", `Deleted a paragraph on p${page + 1} (${ok ? "ok" : "FAILED"})`);
});

// The ¶/≡ line-mode toggle was REMOVED from this page 2026-08-05 (user
// decision: "we should remove toggles if visually appearing"). Since a block
// whose lines are all hard breaks now grows sideways instead of reflowing into
// its own width, the mode the toggle exposed is no longer something a tester
// needs to reach for. The SDK still HAS the control -- editor.toggleLineMode()
// and setLineMode(), plus both bridge commands -- because consumers ship
// against it; only this page's button is gone.

editor.on("editopen", (ed) => {
  // A NEW box says so, because the advice differs: an empty one is discarded rather
  // than committed, which is the opposite of what "tap outside to commit" implies.
  // Handled HERE and not in a second listener — there was one, registered earlier,
  // and this handler silently overwrote its message every time.
  if (ed.created) {
    setHint("Typing",
      `New text box on p${ed.page + 1} — type here. Tap outside to keep it; ` +
      "leave it empty and it is discarded.");
    return;
  }
  setHint("Typing",
    `Editing p${ed.page + 1} (${ed.isParagraph
      ? (ed.linePreserve ? "paragraph, lines kept" : "paragraph, reflow")
      : "line"}, ${ed.chars} chars) — type; tap outside to commit`);
});
editor.on("editclose", ({ page, ok }) => {
  setHint("Edit", `Committed p${page + 1} (${ok ? "ok" : "REJECTED"})`);
});
editor.on("edit", (m) => {
  setHint("Typing",
    `edit#${m.generation}: engine ${m.engineMs} ms, strip blit ${m.blitMs} ms, ` +
    `keystroke→blit ${m.totalMs.toFixed(1)} ms — p95 ${m.p95.toFixed(1)} ms over ` +
    `${m.samples} (gate ≤ 16 ms)`);
});
editor.on("echo", (m) =>
  setHint("Edit", `No run open — latch echo: ${m.chars} chars, round-trip ${m.rttMs.toFixed(1)} ms`));

// ---- live page number + go to page -----------------------------------------
// The SDK reports which page is being read (`page`, 0-based) and performs the
// jump (`goToPage`); the label, the input and its validation are host chrome,
// like the zoom label. A host with a different design (a slider, a thumbnail
// rail, a dialog) drives exactly the same one call.
const pageBox = $("pagebox");
const pageLabel = $("pagelabel");
const pageNum = $("pagenum");
editor.on("page", ({ page, pageCount }) => {
  pageBox.hidden = pageCount === 0;
  pageLabel.textContent = `Page ${page + 1} / ${pageCount}`;
  pageNum.max = pageCount;
  // Don't fight the user while they are typing a page number.
  if (document.activeElement !== pageNum) pageNum.value = String(page + 1);
});

function goToTypedPage() {
  // Leave the open run before jumping away from it: the SDK deliberately does
  // not do it for a page jump (that is a host decision), and the next keystroke
  // would scroll the caret — and the view — right back to it. This also drops
  // the keyboard, which matters on a phone. No-op if nothing is open.
  editor.getOutOfBoxEditing();
  // The input is 1-based (what the user reads); the SDK is 0-based.
  const ok = editor.goToPage(Number(pageNum.value) - 1);
  pageNum.classList.toggle("bad", !ok);
  if (!ok) {
    setStatus(`no page ${pageNum.value} — this document has ${editor.pageCount}`);
    return;
  }
  pageNum.blur();          // hand the keyboard back to the editor
}
$("pagego").addEventListener("click", goToTypedPage);
pageNum.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); goToTypedPage(); }
});
pageNum.addEventListener("input", () => pageNum.classList.remove("bad"));

// ---- zoom ------------------------------------------------------------------
$("zin").addEventListener("click", () => editor.zoomIn());
$("zout").addEventListener("click", () => editor.zoomOut());
editor.on("zoom", ({ zoom }) => { $("zoomlabel").textContent = Math.round(zoom * 100) + "%"; });

// ---- saving: warning gate, destination, delivery (docs/WEB_IO.md §6–§7) ----
// All of this is HOST work. The SDK only reports whether saves can stream
// (capabilities) and hands back a File; where it goes is our business.
let pickedHandle = null;

const warnEl = $("warn");
function showWarning({ title, body, okLabel = "Save anyway" }) {
  $("warntitle").textContent = title;
  $("warntext").textContent = body;
  const ok = $("warnok"), cancel = $("warncancel");
  ok.hidden = okLabel === null;
  ok.textContent = okLabel || "";
  cancel.textContent = okLabel === null ? "OK" : "Cancel";
  warnEl.classList.add("show");
  return new Promise((resolve) => {
    const done = (v) => {
      warnEl.classList.remove("show");
      ok.onclick = null; cancel.onclick = null;
      resolve(v);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}
window.showWarning = showWarning;   // verification hook

$("save").addEventListener("click", async () => {
  const caps = editor.capabilities;
  const sizeMB = editor.documentBytes / (1024 * 1024);
  let allowInMemory = false;
  if (!caps.canStreamSave) {
    if (caps.inHeapMaxMB && sizeMB > caps.inHeapMaxMB) {
      await showWarning({
        title: "Too large to save in this browser",
        body: `This document is ${sizeMB.toFixed(0)} MB. This browser has no ` +
              `streaming storage (private browsing?), so the entire saved file ` +
              `would sit in memory — saving is limited to ${caps.inHeapMaxMB} MB here.`,
        okLabel: null,
      });
      return;
    }
    const ok = await showWarning({
      title: "Saving without streaming",
      body: `This browser has no Origin Private File System handle (private ` +
            `browsing?), so the save cannot stream to disk: the whole ${sizeMB.toFixed(1)} MB ` +
            `document will be held in memory while it is written. It should work, ` +
            `but a large file may make the tab run out of memory.`,
    });
    if (!ok) { setStatus("save cancelled"); return; }
    allowInMemory = true;
  }
  // Ask for the destination NOW, while the click's user activation is fresh:
  // showSaveFilePicker requires it, and a 110 MB save takes seconds — asking
  // afterwards would throw (§6). Chromium only; elsewhere we download.
  pickedHandle = null;
  if (window.showSaveFilePicker) {
    try {
      pickedHandle = await window.showSaveFilePicker({
        suggestedName: editor.suggestedName(),
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (e.name === "AbortError") { setStatus("save cancelled"); return; }
      pickedHandle = null;   // picker unavailable/blocked: fall back to download
    }
  }
  setStatus("saving…");
  let res;
  try {
    res = await editor.save({ allowInMemory });
  } catch (e) {
    if (e.code === "save-too-large") {
      await showWarning({
        title: "Too large to save in this browser",
        body: `This document is ${Math.round(e.sizeMB)} MB. Without streaming storage the ` +
              `whole saved file would have to be held in memory, so saving is limited to ` +
              `${e.limitMB} MB here. Open it in a browser with Origin Private File System ` +
              `support (or outside private browsing) to save it.`,
        okLabel: null,
      });
      setStatus("save refused — too large for the in-memory fallback");
    } else {
      setStatus(`save failed: ${e.message}`);
    }
    return;
  }
  window.lastSavedFile = res.file;   // verification hook
  window.lastSave = res;             // verification hook (ms / io stats / heap)
  const how = await deliver(res.file);
  setStatus(`saved ${res.bytes.toLocaleString()} bytes in ${res.ms} ms` +
    (res.flat ? " (streamed via OPFS, flat memory)" : " (IN-HEAP FALLBACK — no OPFS)") +
    ` — heap ${res.heapMB} MB` +
    (res.tier === 2 ? `, ${res.io.calls} source reads` : "") + ` — ${how}`);
});

// Deliver the finished PDF. The File is OPFS-backed, so BOTH paths stream it
// from disk rather than materializing it in memory — the flat-memory property
// survives the last mile (§6).
async function deliver(file) {
  if (pickedHandle) {
    const handle = pickedHandle;
    pickedHandle = null;
    try {
      const w = await handle.createWritable();
      await file.stream().pipeTo(w);   // async is fine: the sync save is over
      // The File System Access API writes to a temp file and atomically moves it
      // on close(), so a crashed tab never leaves a half-written user file.
      editor.releaseSaved();
      return `written to ${handle.name}`;
    } catch (e) {
      return `delivery failed: ${e.message}`;   // the staged file stays for retry
    }
  }
  // Firefox/Safari (and Chromium if the picker was unavailable): classic anchor
  // download of an object URL. Also streams from disk — which is why this path
  // does NOT release the staged file: the browser is still reading it. The
  // worker's startup reap collects it next session (§9).
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = editor.suggestedName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return "downloaded";
}
