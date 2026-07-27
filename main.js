// main.js — main-thread side of the Step 7 viewer (docs/WEB_VIEWER.md).
// Owns DOM/canvas creation and input; NEVER calls into wasm. Canvases are
// transferred to the worker once (transferControlToOffscreen); paints are
// requested lazily as pages scroll into view and re-requested on zoom.
//
// Step 7 additions: zoom (CSS-instant, sharp tiles refill async — §5) and the
// hidden-input IME sink (§7) feeding the worker's newest-wins latch (§9).

const worker = new Worker("worker.js"); // classic worker (importScripts glue)
window.worker = worker;                 // verification hook (drive the worker directly)
const strip = document.getElementById("strip");
const status = document.getElementById("status");
const fileInput = document.getElementById("file");
const sink = document.getElementById("sink");
const imeLog = document.getElementById("imelog");

let pages = [];            // [{w,h}] PDF points
let painted = new Set();   // page indexes already painted at the current zoom
let zoom = 1;              // user zoom over fit-width
let fitScale = 1;          // CSS px per PDF point at zoom 1
const DPR = Math.min(window.devicePixelRatio || 1, 2);

function setStatus(s) { status.textContent = s; }

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "ready") {
    // The worker probed its save sink before saying ready (docs/WEB_IO.md §7):
    // no OPFS sync handle (Safari private browsing, ancient browsers) means
    // saves cannot stream, which the user must be told BEFORE spending one.
    opfsAvailable = msg.opfs && !forceInHeap;
    inHeapMaxMB = msg.inHeapMaxMB || 0;
    document.getElementById("opfsbadge").hidden = opfsAvailable;
    setStatus("engine ready — loading corpus PDF…");
    // Default document: the same corpus PDF the Android suite uses.
    fetch("./sample.pdf")
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then((blob) => openDocument(new File([blob], "pennycount.pdf")))
      .catch(() => setStatus("engine ready — pick a PDF"));
  } else if (msg.type === "opened") {
    pages = msg.pages;
    buildStrip();
    setStatus(`${pages.length} pages — ${describeLoad(msg)}`);
    window.lastOpen = msg;   // verification hook (tier / io stats / heap)
  } else if (msg.type === "painted") {
    setStatus(`${pages.length} pages @ ${Math.round(zoom * 100)}% — p${msg.page + 1} base ${msg.baseMs} ms, ${msg.tiles} tiles queued`);
  } else if (msg.type === "tile") {
    if (msg.left === 0) setStatus(`${pages.length} pages @ ${Math.round(zoom * 100)}% — tiles sharp (last ${msg.ms} ms)`);
  } else if (msg.type === "editOpened") {
    // Prime the sink with the run's logical text (no 'input' event fires for a
    // programmatic set, so this can't echo back as a keystroke).
    editingPage = msg.page;
    sink.value = msg.text;
    sink.setSelectionRange(msg.caretIndex, msg.caretIndex);
    sink.focus({ preventScroll: true });
    drawCaret(msg.caret);
    drawSelection([]);
    imeLog.textContent =
      `editing p${msg.page + 1} (${msg.isParagraph ? "paragraph" : "line"}, ` +
      `${msg.text.length} chars) — type; tap outside to commit`;
  } else if (msg.type === "caretMoved") {
    sink.setSelectionRange(msg.index, msg.index);
    // I9 belt-and-braces: the open path refocuses in editOpened; the
    // reposition path must too, or any focus loss the preventDefault above
    // didn't cover (e.g. focus stolen between tap and reply) stays permanent.
    sink.focus({ preventScroll: true });
    drawCaret(msg.caret);
    drawSelection([]);
  } else if (msg.type === "editApplied") {
    // Keystroke fully applied: PDFium pixels already blitted by the worker;
    // reposition the caret/selection overlays from CORE geometry. Latency is
    // closed on THIS thread's clock (postedAt echoed verbatim).
    drawCaret(msg.caret);
    drawSelection(msg.selection || []);
    const total = performance.now() - msg.postedAt;
    latencySamples.push(total);
    if (latencySamples.length > 200) latencySamples.shift();
    const p95 = percentile(latencySamples, 95);
    imeLog.textContent =
      `edit#${msg.generation}: engine ${msg.engineMs} ms, strip blit ${msg.blitMs} ms, ` +
      `keystroke→blit ${total.toFixed(1)} ms — p95 ${p95.toFixed(1)} ms over ` +
      `${latencySamples.length} (gate ≤ 16 ms)`;
  } else if (msg.type === "editClosed") {
    editingPage = -1;
    sink.value = "";
    drawCaret(null);
    drawSelection([]);
    imeLog.textContent = `committed p${msg.page + 1} (${msg.ok ? "ok" : "REJECTED"})`;
  } else if (msg.type === "editEcho") {
    const rtt = Math.round((performance.now() - msg.postedAt) * 10) / 10;
    imeLog.textContent =
      `no run open — latch echo: ${msg.chars} chars, round-trip ${rtt} ms`;
  } else if (msg.type === "saved") {
    editingPage = -1;
    drawCaret(null);
    drawSelection([]);
    window.lastSavedFile = msg.file;   // verification hook
    window.lastSave = msg;             // verification hook (ms / io stats / heap)
    deliver(msg.file).then((how) => {
      setStatus(`saved ${msg.bytes.toLocaleString()} bytes in ${msg.ms} ms` +
        (msg.flat ? " (streamed via OPFS, flat memory)" : " (IN-HEAP FALLBACK — no OPFS)") +
        ` — heap ${msg.heapMB} MB` +
        (msg.tier === 2 ? `, ${msg.io.calls} source reads` : "") + ` — ${how}`);
    });
  } else if (msg.type === "saveRefused") {
    // The worker's backstop for §7 fired (shouldn't normally: the UI warns first).
    showWarning({
      title: "Too large to save in this browser",
      body: `This document is ${msg.sizeMB} MB. Without streaming storage the whole ` +
            `saved file would have to be held in memory, so saving is limited to ` +
            `${msg.limitMB} MB here. Open it in a browser with Origin Private File ` +
            `System support (or outside private browsing) to save it.`,
      okLabel: null,
    });
    setStatus("save refused — too large for the in-memory fallback");
  } else if (msg.type === "error") {
    setStatus(`error: ${msg.detail}`);
  }
};

// ---- caret/selection overlays (§6): CORE page-point geometry -> CSS ------------
const caretEl = document.getElementById("caret");
const selEl = document.getElementById("selrects");
let editingPage = -1;
let lastCaretGeom = null;        // [x, topPt, botPt] page points
let lastSelection = [];          // [[l,b,r,t], ...] page points
const latencySamples = [];
window.latencySamples = latencySamples;   // the latency-gate harness reads this

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// Page points -> viewport CSS px for the editing page's canvas.
function pageToCss(xPt, yPt) {
  const canvas = strip.children[editingPage];
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleCss = fitScale * zoom;
  return {
    x: rect.left + xPt * scaleCss,
    y: rect.top + (pages[editingPage].h - yPt) * scaleCss,
  };
}

function drawCaret(geom) {
  lastCaretGeom = geom;
  if (!geom || editingPage < 0) { caretEl.style.display = "none"; return; }
  const top = pageToCss(geom[0], geom[1]);
  const bot = pageToCss(geom[0], geom[2]);
  if (!top) { caretEl.style.display = "none"; return; }
  caretEl.style.display = "block";
  caretEl.style.left = `${top.x - 1}px`;
  caretEl.style.top = `${top.y}px`;
  caretEl.style.height = `${Math.max(2, bot.y - top.y)}px`;
  // Keep the sink under the caret so an IME candidate window follows (§7).
  sink.style.left = `${Math.round(top.x)}px`;
  sink.style.top = `${Math.round(top.y)}px`;
}

function drawSelection(rects) {
  lastSelection = rects;
  selEl.innerHTML = "";
  if (editingPage < 0) return;
  for (const r of rects) {
    const tl = pageToCss(r[0], r[3]);
    const br = pageToCss(r[2], r[1]);
    if (!tl) continue;
    const div = document.createElement("div");
    div.className = "selrect";
    div.style.left = `${tl.x}px`;
    div.style.top = `${tl.y}px`;
    div.style.width = `${br.x - tl.x}px`;
    div.style.height = `${br.y - tl.y}px`;
    selEl.appendChild(div);
  }
}

// I9: taps that miss every canvas (the strip's gray gutter, the imelog bar)
// used to do NOTHING except let the browser blur the sink — the edit stayed
// open but the keyboard was silently dead. Route them as an explicit commit
// instead (the Android tap-outside behavior); the worker no-ops when no
// session is open. The toolbar is excluded: its buttons must keep working
// mid-edit (Save already commits internally), and a button press must not
// also double as a commit gesture.
document.addEventListener("pointerdown", (ev) => {
  if (editingPage < 0) return;
  if (ev.target.tagName === "CANVAS") return;        // canvas handler owns these
  if (ev.target.closest("#bar") || ev.target.closest("#warn")) return;
  ev.preventDefault();                               // keep the sink focused
  worker.postMessage({ type: "commit" });
});

// Overlays are position:fixed — track scroll/zoom/resize.
function repositionOverlays() {
  drawCaret(lastCaretGeom);
  drawSelection(lastSelection);
}
window.addEventListener("scroll", repositionOverlays, { passive: true });
window.addEventListener("resize", repositionOverlays);

// Two-tier load (docs/WEB_IO.md §3): the main thread hands the worker the
// Blob/File itself — never the bytes. The worker picks the tier by size (a
// structured-clone of a Blob is by reference, so a 1 GB file costs nothing
// here) and keeps the Blob alive for the whole session. `?tier=1|2` forces a
// tier so the lazy path can be exercised on a small file.
const params = new URLSearchParams(location.search);
const forcedTier = Number(params.get("tier")) || 0;
const blockKB = Number(params.get("block")) || 0;   // dev knob: cache block size
// Dev knob: pretend this browser has no OPFS, to exercise the §7 in-heap
// fallback + its warning UI on a browser that does have it.
const forceInHeap = params.has("noopfs");
let docBytes = 0;

function openDocument(blob) {
  painted = new Set();
  docBytes = blob.size;
  if (blob.name) docName = blob.name;
  worker.postMessage({ type: "open", blob, tier: forcedTier, blockKB });
}

function describeLoad(msg) {
  const mb = (msg.bytes / (1024 * 1024)).toFixed(1);
  if (msg.tier !== 2) return `${mb} MB copied into the heap (tier 1) in ${msg.openMs} ms`;
  const io = msg.io || {};
  return `${mb} MB LAZY (tier 2) in ${msg.openMs} ms — ${io.calls} reads, ` +
    `${((io.readBytes || 0) / (1024 * 1024)).toFixed(1)} MB fetched, heap ${msg.heapMB} MB`;
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (f) openDocument(f);
});

// ---- lazy paint on visibility --------------------------------------------------
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      requestPaint(Number(en.target.dataset.page));
    }
  },
  { rootMargin: "300px" }
);

function requestPaint(page) {
  if (painted.has(page)) return;
  painted.add(page);
  const canvas = strip.children[page];
  worker.postMessage({
    type: "paint",
    page,
    w: Number(canvas.dataset.w),
    h: Number(canvas.dataset.h),
    scale: Number(canvas.dataset.scale), // device px per PDF point
  });
}

function buildStrip() {
  strip.innerHTML = "";
  io.disconnect();
  const maxWpt = Math.max(...pages.map((p) => p.w));
  fitScale = Math.min(strip.clientWidth - 24, 900) / maxWpt;
  pages.forEach((p, i) => {
    const canvas = document.createElement("canvas");
    canvas.dataset.page = i;
    strip.appendChild(canvas);
    // One-time ownership transfer; from here the WORKER draws (§2).
    const off = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "attach", page: i, canvas: off }, [off]);
    io.observe(canvas);
    // Tap -> page points -> worker (hit-test + edit_begin / caret move / commit
    // all happen where the engine state lives). Focus the sink immediately —
    // browsers only show a keyboard for a focus inside the user gesture.
    canvas.addEventListener("pointerdown", (ev) => {
      // I9: killing the default action stops the browser from moving focus to
      // <body> after this handler (a mousedown on a non-focusable canvas blurs
      // whatever is focused — i.e. the sink). Without this, every
      // caret-reposition tap silently disconnected the keyboard: the open path
      // refocused in editOpened, but the caretMoved path never did.
      ev.preventDefault();
      const page = Number(canvas.dataset.page);
      const rect = canvas.getBoundingClientRect();
      const scaleCss = fitScale * zoom;
      const xPt = (ev.clientX - rect.left) / scaleCss;
      const yPt = pages[page].h - (ev.clientY - rect.top) / scaleCss;
      worker.postMessage({ type: "tap", page, xPt, yPt });
      focusSinkAt(ev.clientX, ev.clientY);
    });
  });
  applyZoom(); // sets CSS + device sizes, then visible pages paint via IO
}

// ---- zoom (§5): CSS rescales instantly; sharp tiles refill async ---------------
function applyZoom() {
  const scaleCss = fitScale * zoom;        // CSS px per point
  const scaleDev = scaleCss * DPR;         // device px per point
  for (const canvas of strip.children) {
    const p = pages[Number(canvas.dataset.page)];
    canvas.style.width = Math.round(p.w * scaleCss) + "px";
    canvas.style.height = Math.round(p.h * scaleCss) + "px";
    canvas.dataset.w = Math.round(p.w * scaleDev);
    canvas.dataset.h = Math.round(p.h * scaleDev);
    canvas.dataset.scale = scaleDev;
  }
  // Old pixels keep showing, CSS-scaled (instant feedback, maybe blurry);
  // repaint at the new resolution after a short settle.
  painted = new Set();
  clearTimeout(applyZoom._t);
  applyZoom._t = setTimeout(() => {
    for (const canvas of strip.children) {
      const r = canvas.getBoundingClientRect();
      if (r.bottom > -300 && r.top < innerHeight + 300) {
        requestPaint(Number(canvas.dataset.page));
      }
    }
  }, 180);
}

function setZoom(z) {
  zoom = Math.min(3, Math.max(0.5, z));
  document.getElementById("zoomlabel").textContent = Math.round(zoom * 100) + "%";
  applyZoom();
  repositionOverlays();
}

document.getElementById("zin").addEventListener("click", () => setZoom(zoom * 1.25));
document.getElementById("zout").addEventListener("click", () => setZoom(zoom / 1.25));
// ---- saving: warning gate, destination, delivery (docs/WEB_IO.md §6–§7) --------
let opfsAvailable = true;     // set from the worker's probe at ready
let inHeapMaxMB = 0;
let pickedHandle = null;      // showSaveFilePicker target for the save in flight
let docName = "document.pdf";   // replaced by the opened File's name

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
      // The File System Access API writes to a temp file and atomically moves
      // it on close(), so a crashed tab never leaves a half-written user file.
      worker.postMessage({ type: "reapStaging" });
      return `written to ${handle.name}`;
    } catch (e) {
      return `delivery failed: ${e.message}`;   // the staged file stays for retry
    }
  }
  // Firefox/Safari (and Chromium if the picker was unavailable): classic
  // anchor download of an object URL. Also streams from disk — which is why
  // this path does NOT reap the staging file: the browser is still reading it.
  // The worker's startup reap collects it next session (§9).
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = suggestedName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return "downloaded";
}

function suggestedName() {
  return docName.replace(/\.pdf$/i, "") + "-edited.pdf";
}

// The §7 warning panel. Resolves true only if the user accepts; a null
// okLabel makes it an acknowledge-only refusal.
const warnEl = document.getElementById("warn");
function showWarning({ title, body, okLabel = "Save anyway" }) {
  document.getElementById("warntitle").textContent = title;
  document.getElementById("warntext").textContent = body;
  const ok = document.getElementById("warnok");
  const cancel = document.getElementById("warncancel");
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

document.getElementById("save").addEventListener("click", async () => {
  const sizeMB = docBytes / (1024 * 1024);
  if (!opfsAvailable) {
    if (inHeapMaxMB && sizeMB > inHeapMaxMB) {
      await showWarning({
        title: "Too large to save in this browser",
        body: `This document is ${sizeMB.toFixed(0)} MB. This browser has no ` +
              `streaming storage (private browsing?), so the entire saved file ` +
              `would sit in memory — saving is limited to ${inHeapMaxMB} MB here.`,
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
  }
  // Ask for the destination NOW, while the click's user activation is fresh:
  // showSaveFilePicker requires it, and a 110 MB save takes seconds — asking
  // afterwards would throw (§6). Chromium only; elsewhere we download.
  pickedHandle = null;
  if (window.showSaveFilePicker) {
    try {
      pickedHandle = await window.showSaveFilePicker({
        suggestedName: suggestedName(),
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (e.name === "AbortError") { setStatus("save cancelled"); return; }
      pickedHandle = null;   // picker unavailable/blocked: fall back to download
    }
  }
  setStatus("saving…");
  worker.postMessage({ type: "save", forceInHeap });   // worker commits any live edit first
});
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);

// ---- hidden-input IME sink (§7) -------------------------------------------------
// The direct analog of Android's InputSinkEditText: an off-screen editable
// element whose only job is to summon the keyboard, receive keystrokes AND
// composition events, and mirror the full buffer + caret to the worker. It is
// NEVER a visible editor. Composition handling is here from day one (§7).
// Once the edit-session ABI lands, opening a run seeds sink.value with the
// run's logical text; today it starts empty and just proves the pipe.
let editGeneration = 0;
let composing = false;
const seenEvents = [];

function logIme(kind) {
  if (seenEvents[seenEvents.length - 1] !== kind) seenEvents.push(kind);
  if (seenEvents.length > 6) seenEvents.shift();
}

function focusSinkAt(cssX, cssY) {
  // Keep the sink NEAR the caret so the IME candidate window follows (§7);
  // it stays invisible (1x1, transparent) — never a visible editor.
  sink.style.left = Math.round(cssX) + "px";
  sink.style.top = Math.round(cssY) + "px";
  sink.focus({ preventScroll: true });
}

function pushEdit() {
  worker.postMessage({
    type: "edit",
    fullText: sink.value,
    caretIndex: sink.selectionStart,
    selStart: sink.selectionStart,
    selEnd: sink.selectionEnd,
    generation: ++editGeneration,
    postedAt: performance.now(),
  });
}

// Full composition handling from day one (§7): during composition we still
// mirror every intermediate buffer state (newest-wins latch coalesces), and
// compositionend pushes the settled text.
sink.addEventListener("compositionstart", () => { composing = true; logIme("compositionstart"); });
sink.addEventListener("compositionupdate", () => { logIme("compositionupdate"); pushEdit(); });
sink.addEventListener("compositionend", () => { composing = false; logIme("compositionend"); pushEdit(); });
sink.addEventListener("beforeinput", (e) => { logIme(`beforeinput:${e.inputType}`); });
sink.addEventListener("input", () => {
  logIme("input");
  if (!composing) pushEdit();
  imeLog.textContent = `sink: "${sink.value.slice(-40)}" caret ${sink.selectionStart} [${seenEvents.join(" → ")}]`;
});
sink.addEventListener("keydown", (e) => {
  // Arrows/Home/End move the caret (or extend the selection with Shift)
  // without an input event — mirror those too so the caret/selection overlays
  // track. Up/Down move by the sink's own layout, not the PDF wrap (the
  // Android deferral carries over) — left/right/tap are exact.
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
    setTimeout(pushEdit, 0);
  }
});
sink.addEventListener("blur", () => logIme("blur"));
