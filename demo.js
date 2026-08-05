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

import { PdfeEditor } from "./pdfe-editor.js?v=1.7.4-af9a20e";

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
// Box dragging is EXPERIMENTAL and ships OFF (docs/BLOCK_MOVE.md). This page is the
// tester site, so it must open as what a consumer gets: FALSE.
//
// This used to be remembered per browser in localStorage, and that was a mistake
// (user directive 2026-08-04: "do not keep the box moving as local pref, instead
// keep this a configuration boolean in default as false"). Hidden per-browser state
// makes the page behave differently in two browsers with the same URL and the same
// build — which is exactly how it was hit: dragging worked in one browser and looked
// broken in Chrome, and nothing on screen explained why.
//
// So the default is this constant, and it is the whole truth at load time. The ⋯ menu
// switch is still there for a tester, but it only toggles the LIVE session through
// the SDK's runtime kill switch — it persists nothing, so every reload is a clean,
// predictable "off".
const BLOCK_MOVE_DEFAULT = false;

const editor = new PdfeEditor({
  container: $("editor"),
  engineUrl: ENGINE_URL,
  version,                                     // cache-buster (build_site stamps it)
  simulateNoOpfs: forceInHeap,
  blockMove: BLOCK_MOVE_DEFAULT,
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
  openDocument(SAMPLE_PDF).catch(() => {
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

// The experimental box-drag switch — a LIVE-SESSION toggle only. It takes effect
// immediately through setBlockMove (the SDK's runtime kill switch) and deliberately
// persists NOTHING: the page always opens at BLOCK_MOVE_DEFAULT, so what a tester
// sees on load is what a consumer gets. Reloading is the way back to off.
const bmConf = $("bmtoggleconf");
bmConf.checked = BLOCK_MOVE_DEFAULT;
bmConf.addEventListener("change", () => {
  editor.setBlockMove(bmConf.checked);
  setStatus(bmConf.checked
    ? "box dragging ON for this session only (experimental) — drag a selected box; " +
      "this cannot be undone, and a reload turns it back off"
    : "box dragging off");
});

// ---- edit mode + line mode -------------------------------------------------
const editBtn = $("editmode");
editBtn.addEventListener("click", () => editor.toggleEditMode());
editor.on("editmode", ({ editMode }) => {
  label(editBtn, editMode ? "Done" : "Edit");
  editBtn.classList.toggle("active", editMode);
  setHint(editMode ? "Edit" : "View", editMode
    ? "Edit mode — tap a paragraph to select it, then Edit or Delete"
    : "View mode — press Edit to enable editing");
});

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
  // Finish any open run before leaving it behind: a jump deliberately does not
  // commit (that is a host decision, like save), and the next keystroke would
  // scroll the caret — and the view — right back to it. No-op if nothing is open.
  editor.commit();
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

// ---- undo / redo -----------------------------------------------------------
// UNDO IS OFF IN THIS BUILD. The engine's history is opt-in
// (pdfe_history_set_enabled) and this host never opts in, so nothing is
// recorded — see UNDO_REDO.md §6 for the text-undo work that has to land first.
// ONE FLAG so this file stays otherwise identical to the undo branch and merges
// back cleanly: flip it to true when the SDK enables history again.
//
// The SDK's Ctrl+Z interception deliberately stays wired even here. It is not
// about undo: without it the hidden textarea's OWN native undo fires, reverts
// the sink and emits `input`, which posts a full-buffer edit to the core — a
// silent corruption. Suppressing that is a fix this build carries regardless.
const UNDO_UI = false;

if (UNDO_UI) {
  // Host chrome driven entirely by the `history` event: the ENGINE owns the
  // stack, so there is nothing to track here.
  $("undo").addEventListener("click", () => editor.undo());
  $("redo").addEventListener("click", () => editor.redo());
  editor.on("history", (h) => {
    $("historyseg").hidden = false;
    $("undo").disabled = !h.canUndo;
    $("redo").disabled = !h.canRedo;
    $("undo").title = h.canUndo
      ? `Undo (Ctrl+Z) — page ${h.undoPage + 1}` : "Nothing to undo";
    $("redo").title = h.canRedo
      ? `Redo (Ctrl+Y) — page ${h.redoPage + 1}` : "Nothing to redo";
  });
  // A one-line status note, so a tester can see undo fire even when the change
  // is off-screen. `live` = it patched the run being typed in without closing it.
  for (const kind of ["undo", "redo"]) {
    editor.on(kind, ({ page, ok, live }) => {
      setStatus(ok
        ? `${kind === "undo" ? "Undid" : "Redid"} a change on page ${page + 1}${live ? " (while typing)" : ""}`
        : `Nothing to ${kind}`);
    });
  }
} else {
  // Leave no dead chrome: the buttons stay hidden and the debug panel's menu row
  // goes away, rather than offering controls that can never do anything.
  $("historyseg").hidden = true;
  $("dbgconfig").hidden = true;
}

// ---- history debug panel (DEV ONLY) ----------------------------------------
// A window onto the ENGINE's journal via editor.historyDump() — which reads
// pdfe_history_describe, so what you see is what the core will actually apply,
// not what this page believes it recorded. That distinction is the whole point:
// a shell-side mirror agrees with the core right up until the moment a bug makes
// them differ.
//
// Off by default and remembered per browser, because web/index.html IS the
// published tester site — a tester must never meet a debug panel by accident.
// Pull-only: nothing is computed while the panel is closed.
const dbgEl = $("dbg"), dbgConf = $("dbgtoggleconf");
const DBG_PREF = "pdfe.historyPanel";
let lastDump = null;

const shortNum = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// Text previews are already capped by the core (previewChars); this only keeps a
// long one from dominating the row.
const clip = (s, n = 34) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Whitespace has to be VISIBLE here: a trailing space is exactly the kind of
// thing an undo bug turns on (S27), and it is invisible in a plain span.
const showWs = (s) => s.replace(/\n/g, "⏎").replace(/\t/g, "⇥").replace(/ /g, "·");
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// |cut| = the core windowed the preview (previewFrom > 0), so mark the missing
// left side — otherwise the row reads as if the run started mid-word.
const txt = (s, cut) => `<span class="txt">${cut ? "…" : ""}${esc(showWs(clip(s)))}</span>`;

// One journal entry. |isNext| = the step the next undo/redo will apply.
function entryRow(e, isNext) {
  const delta = e.afterLen - e.beforeLen;
  const deltaStr = e.kind === "text" || e.kind === "delete"
    ? (delta === 0 ? "±0" : delta > 0 ? `+${delta}` : String(delta)) + " ch"
    : "";
  // The anchor is what re-finds this run after the page was re-grouped. When
  // both identities are -1 the ONLY route left is geometry, which is the
  // fragile shape S25/S26/S27 all came from — so it is flagged, not hidden.
  const anchor = e.bk >= 0 ? `<span class="chip">bk ${e.bk}</span>`
    : e.paraId >= 0 ? `<span class="chip">¶ ${e.paraId}</span>`
    : `<span class="chip geom" title="no block/paragraph identity — this step can only be re-found by geometry">geom</span>`;
  const extra = e.kind === "move"
    ? `<span class="chip">Δ ${e.dx.toFixed(1)},${e.dy.toFixed(1)}</span><span class="chip">${e.objs} obj</span>`
    : e.kind === "delete" ? `<span class="chip">${e.objs} obj</span>`
    : e.kind === "style" ? `<span class="chip">${e.runs} run</span>` : "";
  const cut = e.previewFrom > 0;
  const body = e.kind === "text"
    ? `<div class="r2"><span class="del">${txt(e.before, cut)}</span> → <span class="add">${txt(e.after, cut)}</span></div>`
    : e.kind === "delete"
      ? `<div class="r2"><span class="del">${txt(e.before, cut)}</span> → <em>gone</em></div>`
      : e.beforeLen ? `<div class="r2">${txt(e.before, cut)}</div>` : "";
  return `<div class="dbge${isNext ? " next" : ""}">
    <div class="r1">
      ${isNext ? '<span class="chip next">next</span>' : ""}
      <span class="chip kind ${e.kind}">${e.kind}</span>
      <span>p${e.page + 1}</span>${anchor}${extra}
      <span style="margin-left:auto">${deltaStr}</span>
    </div>
    ${body}
    <div class="r3">
      <span>#${e.i}</span>
      <span>len ${e.beforeLen}→${e.afterLen}</span>
      <span>caret ${e.caretBefore}→${e.caretAfter}</span>
      <span>${shortNum(e.bytes)}</span>
    </div>
  </div>`;
}

// NEWEST FIRST on screen (the dump is oldest-first): "what will undo do next?"
// is the question this panel exists to answer, so that step goes on top.
function stackHtml(list, label) {
  if (!list.length) return `<div class="dbgsec">${label} — empty</div>`;
  const rows = list.map((e, i) => entryRow(e, i === list.length - 1)).reverse().join("");
  return `<div class="dbgsec">${label} — ${list.length}</div>${rows}`;
}

function renderDump(d) {
  lastDump = d;
  const totals = $("dbgtotals"), body = $("dbgbody");
  if (!d) {
    totals.textContent = "no document";
    body.innerHTML = "";
    return;
  }
  const flags = [
    d.suspended ? '<span class="chip">suspended</span>' : "",
    d.liveAnchor ? '<span class="chip">live session</span>' : "",
    d.stagedDelete ? '<span class="chip">staged delete</span>' : "",
  ].join("");
  totals.innerHTML =
    `<span>${d.undoCount} undo / ${d.redoCount} redo</span>` +
    `<span>${shortNum(d.bytes)} of ${shortNum(d.maxBytes)}</span>` +
    `<span>cap ${d.maxEntries}</span>${flags}`;
  body.innerHTML = stackHtml(d.undo, "undo") + stackHtml(d.redo, "redo");
}

async function refreshDump() {
  if (!UNDO_UI || !dbgConf.checked) return;   // off/closed: cost nothing
  try { renderDump(await editor.historyDump()); }
  catch (e) { $("dbgtotals").textContent = `dump failed: ${e.message || e}`; }
}
// COALESCED, because `edit` fires per keystroke and each dump is a worker round
// trip carrying the whole journal — one per burst is all a human can read, and
// the panel must never compete with typing for the message pipe.
let dumpTimer = 0;
function queueDump() {
  if (!UNDO_UI || !dbgConf.checked || dumpTimer) return;
  dumpTimer = setTimeout(() => { dumpTimer = 0; refreshDump(); }, 120);
}
window.refreshDump = refreshDump;        // verification hook
window.historyDump = () => lastDump;     // verification hook

dbgConf.checked = UNDO_UI && localStorage.getItem(DBG_PREF) === "1";
const applyDbgPref = () => {
  // With recording off the panel could only ever show two empty stacks, and a
  // stale localStorage pref must not resurrect it.
  stage.classList.toggle("dbg", UNDO_UI && dbgConf.checked);
  if (UNDO_UI && dbgConf.checked) refreshDump();
};
dbgConf.addEventListener("change", () => {
  localStorage.setItem(DBG_PREF, dbgConf.checked ? "1" : "0");
  applyDbgPref();
});
applyDbgPref();

$("dbgrefresh").addEventListener("click", refreshDump);
$("dbgcopy").addEventListener("click", async () => {
  if (!lastDump) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDump, null, 2));
    setStatus("history JSON copied to the clipboard");
  } catch (e) {
    setStatus(`copy failed: ${e.message || e}`);
  }
});

// Every event that can change the journal refreshes it. `history` covers the
// ordinary cases; the rest catch changes that leave canUndo/canRedo untouched
// (a second keystroke, a save clearing the stacks) and so are deduped away.
for (const ev of ["history", "undo", "redo", "edit", "editclose",
                  "deleted", "moved", "opened", "saved"]) {
  editor.on(ev, queueDump);
}

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
