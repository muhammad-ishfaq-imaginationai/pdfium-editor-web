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

import { PdfeEditor } from "./pdfe-editor.js?v=1.7.5-a4c7117-wd323618";

const SAMPLE_PDF = "./sample.pdf";   // build_site.sh → ./sample.pdf
const ENGINE_URL = "./editor.js";            // build_site.sh → ./editor.js

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

const editor = new PdfeEditor({
  container: $("editor"),
  engineUrl: ENGINE_URL,
  version,                                     // cache-buster (build_site stamps it)
  simulateNoOpfs: forceInHeap,
  blockMove: blockMoveOn,
});
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
  if (!editor.typingColorFollowsCaret) return;
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

// Faces are registered once per OPENED DOCUMENT: the handles belong to the document,
// so they do not survive opening another file.
editor.on("opened", async () => {
  const results = await Promise.all(HOST_FACES.map((name) => editor.loadFont({ name })));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length) setHint("Fonts", `could not register: ${failed.join(", ")}`);
});

fontSelect.addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (v.startsWith("__")) return;              // a placeholder is not a choice
  editor.applyFont(v === "" ? null : v);
});
boldBtn.addEventListener("click", () => editor.applyBold(!boldBtn.classList.contains("active")));
italicBtn.addEventListener("click", () =>
  editor.applyItalic(!italicBtn.classList.contains("active")));

// Paint the font controls from the ENGINE's answer — never from what we last sent.
// Three separate MIXED cases, and they are independent: the FAMILY can be uniform
// while bold-ness is not (Arial + Arial-Bold), which is exactly why the SDK reports
// them as separate fields.
function showFontStyle(style) {
  if (!style) return;
  // The picker matches on the FAMILY KEY, not on the display name: the text under the
  // cursor reads "Helvetica-Bold" while the family the user picked is "Helvetica".
  const fam = style.fontFamily;
  const opt = fam == null ? null : PICKER_FAMILIES.find(([, , key]) => key === fam);
  fontSelect.value = fam == null ? "__mixed" : (opt ? opt[0] : "__other");
  // PRESSED state from `bold`/`italic`; ENABLED state from `canBold`/`canItalic`.
  // Two different questions: "is it bold" and "could it be". A family with no bold
  // face is refused by the SDK, and a disabled button is how the user learns that
  // without clicking.
  boldBtn.classList.toggle("active", style.bold === true);
  italicBtn.classList.toggle("active", style.italic === true);
  boldBtn.disabled = !style.canBold;
  italicBtn.disabled = !style.canItalic;
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
colorInput.addEventListener("change", (ev) => editor.applyTextColor(ev.target.value));

// STICKY vs FOLLOW-THE-CARET — host chrome for the SDK's own switch (§2). Checked means
// the pick is fixed until cleared; unchecked (default) means the caret decides.
const stickyColor = $("stickycolor");
stickyColor.addEventListener("change", () => {
  const sticky = stickyColor.checked;
  editor.setTypingColorFollowsCaret(!sticky);
  setHint("Typing", sticky
    ? "Sticky colour ON — the picked colour survives cursor moves; the swatch stops following"
    : "Sticky colour OFF — the picked colour is dropped when the cursor moves");
});

// The cursor moved or the range changed — the engine reports the colour there, and
// per the agreed UX the swatch follows the cursor. The SDK owns the override's
// LIFETIME (drop on a real cursor move, keep on a click back to the same index
// after a pick — docs/STYLING.md §2); a host that also called clearTypingColor()
// here would defeat that same-index rule, which is exactly what this handler did
// until 2026-08-13. Hosts only paint.
editor.on("selection", ({ start, end, style }) => {
  showTextStyle(style);
  showFontStyle(style);
});
editor.on("styled", ({ what, style, following, fontName }) => {
  showTextStyle(style);
  if (what === "typingFont") {
    // Arming a font paints nothing, so there is no style to read back — the event
    // names the face the next keystroke takes, and the picker shows that.
    if (fontName != null) fontSelect.value = fontName;
    setHint("Typing", `Font armed: ${fontName || "Original"} — it applies to what you ` +
      "type next, and is dropped when you move the cursor");
  } else {
    showFontStyle(style);
  }
  if (what === "color") setHint("Typing", "Colour applied — Ctrl+Z undoes it");
  if (what === "font") setHint("Typing", "Font applied — Ctrl+Z undoes it");
  if (what === "face") setHint("Typing", "Face applied — Ctrl+Z undoes it");
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
editor.on("editclose", () => { colorMixed.hidden = true; });

// Select-then-act: the SDK draws the selected box and its Edit/Delete bar; the
// host only reports it (and could drive the same actions from its own chrome).
editor.on("select", ({ selection }) => {
  setHint(selection ? "Selected" : "Edit", selection
    ? `Selected p${selection.page + 1} box #${selection.index} — Edit, Delete, ` +
      "or tap it again to type"
    : "Edit mode — tap a paragraph to select it, then Edit or Delete");
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
