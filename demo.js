// demo.js — the HOST side of the demo page (docs/EDITOR_SDK.md).
//
// This file is a worked example of everything a host owns: open, save (+ its
// dialogs and destination picking), the edit-mode toggle, zoom buttons, the
// line-mode toggle and its config checkbox, status text and telemetry. The
// editor itself contributes no chrome; it is created once here and driven
// entirely through its API + events.
//
// It is also our browser test harness, so the window.* hooks earlier sessions'
// verification scripts use are re-exported verbatim (window.worker,
// window.lastOpen, window.lastSave, window.lastSavedFile, window.latencySamples,
// window.showWarning) plus window.pdfe for the instance itself.

import { PdfeEditor } from "./pdfe-editor.js?v=1.7.0-2686ba4";

const SAMPLE_PDF = "./sample.pdf";   // build_site.sh → ./sample.pdf
const ENGINE_URL = "./editor.js";            // build_site.sh → ./editor.js

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const imeLog = $("imelog");
const setStatus = (s) => { statusEl.textContent = s; };

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
const version = params.get("v") || $("appver").textContent.trim() || undefined;
if (params.get("v")) $("appver").textContent = params.get("v");

const editor = new PdfeEditor({
  container: $("editor"),
  engineUrl: ENGINE_URL,
  version,                                     // cache-buster (build_site stamps it)
  simulateNoOpfs: forceInHeap,
});
window.pdfe = editor;
window.worker = editor.worker;                 // verification hook (drive the worker directly)
window.latencySamples = editor.latencySamples; // the latency-gate harness reads this

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
        setStatus("locked document — no password given");
        return null;
      }
    }
  }
}
window.openDocument = openDocument;  // verification hook (the browser harness drives it)

// ---- engine ready → load the corpus sample ---------------------------------
editor.on("ready", (caps) => {
  $("opfsbadge").hidden = caps.canStreamSave;
  setStatus("engine ready — loading corpus PDF…");
  openDocument(SAMPLE_PDF).catch(() => setStatus("engine ready — pick a PDF"));
});

editor.on("opened", (info) => {
  window.lastOpen = info;                      // verification hook (tier / io / heap)
  setStatus(`${info.pages} pages — ${describeLoad(info)}`);
});

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
$("file").addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  if (f) openDocument(f, { tier: forcedTier, blockKB }).catch((e) => setStatus(`error: ${e.message}`));
});

// ---- edit mode + line mode -------------------------------------------------
const editBtn = $("editmode");
editBtn.addEventListener("click", () => editor.toggleEditMode());
editor.on("editmode", ({ editMode }) => {
  editBtn.textContent = editMode ? "✓ Done" : "✎ Edit";
  editBtn.classList.toggle("active", editMode);
  imeLog.textContent = editMode
    ? "edit mode — tap a paragraph to select it, then Edit or Delete"
    : "view mode — click ✎ Edit to enable editing";
});

// Select-then-act: the SDK draws the selected box and its Edit/Delete bar; the
// host only reports it (and could drive the same actions from its own chrome).
editor.on("select", ({ selection }) => {
  imeLog.textContent = selection
    ? `selected p${selection.page + 1} box #${selection.index} — Edit, Delete, ` +
      "or tap it again to type"
    : "edit mode — tap a paragraph to select it, then Edit or Delete";
});
editor.on("deleted", ({ page, ok }) => {
  imeLog.textContent = `deleted a paragraph on p${page + 1} (${ok ? "ok" : "FAILED"})`;
});

const lineModeBtn = $("linemode");
const lmConf = $("lmtoggleconf");
const LM_PREF = "pdfe.lineModeToggle";
lmConf.checked = localStorage.getItem(LM_PREF) === "1";
lmConf.addEventListener("change", () => {
  localStorage.setItem(LM_PREF, lmConf.checked ? "1" : "0");
  updateLineModeButton();
});
lineModeBtn.addEventListener("click", () => editor.toggleLineMode());

function updateLineModeButton() {
  const ed = editor.editing;
  lineModeBtn.hidden = !(lmConf.checked && ed && ed.isParagraph);
  lineModeBtn.textContent = ed && ed.linePreserve ? "≡ Lines" : "¶ Reflow";
}

editor.on("editopen", (ed) => {
  updateLineModeButton();
  imeLog.textContent =
    `editing p${ed.page + 1} (${ed.isParagraph
      ? (ed.linePreserve ? "paragraph ≡ lines" : "paragraph ¶ reflow")
      : "line"}, ${ed.chars} chars) — type; tap outside to commit`;
});
editor.on("editclose", ({ page, ok }) => {
  updateLineModeButton();
  imeLog.textContent = `committed p${page + 1} (${ok ? "ok" : "REJECTED"})`;
});
editor.on("edit", (m) => {
  imeLog.textContent =
    `edit#${m.generation}: engine ${m.engineMs} ms, strip blit ${m.blitMs} ms, ` +
    `keystroke→blit ${m.totalMs.toFixed(1)} ms — p95 ${m.p95.toFixed(1)} ms over ` +
    `${m.samples} (gate ≤ 16 ms)`;
});
editor.on("echo", (m) =>
  { imeLog.textContent = `no run open — latch echo: ${m.chars} chars, round-trip ${m.rttMs.toFixed(1)} ms`; });

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
