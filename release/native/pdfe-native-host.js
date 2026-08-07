// pdfe-native-host.js — the bridge a NATIVE shell (iOS WKWebView today, an
// Android WebView later) uses to drive the editor (docs/EDITOR_SDK.md §5).
//
// Why this file exists: the editor SDK is chrome-free, so on a phone the buttons
// live in Swift/Kotlin. Those buttons need a command channel into the page and
// an event channel back out. Both are JSON — deliberately:
//
//   * WKScriptMessageHandler carries JSON-serializable types ONLY. Never design
//     a byte path over it (docs/PLATFORM_SHELLS.md §3).
//   * Bytes therefore travel out-of-band: IN via a URL the native side serves
//     (WKURLSchemeHandler / WebViewAssetLoader) and the page fetches, OUT via
//     `readChunk` pulls the native side performs after a save.
//
// The native side calls commands with WKWebView.callAsyncJavaScript (iOS) or
// evaluateJavascript with a promise-aware wrapper (Android), always as:
//     return await window.PdfeNative.command(name, argsObject)
// and always gets back a JSON envelope {ok, result} / {ok:false, error} — never
// a thrown JS exception, which marshals badly across both bridges.

const CHUNK = 3 * 1024 * 1024;   // 3 MB raw → 4 MB base64 per pull

function toBase64(bytes) {
  let s = "";
  const STEP = 0x8000;   // fromCharCode.apply blows the stack on large arrays
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Pick whatever event channel this native host installed. */
function detectTransport(name) {
  const wk = globalThis.webkit?.messageHandlers?.[name];
  if (wk) return (msg) => wk.postMessage(msg);                     // iOS
  const android = globalThis[name];                                 // Android @JavascriptInterface
  if (android && typeof android.postMessage === "function") {
    return (msg) => android.postMessage(JSON.stringify(msg));
  }
  return (msg) => console.log("[pdfe] event (no native transport)", msg);
}

/**
 * Wire an editor to the native shell.
 * @param {PdfeEditor} editor
 * @param {object} opts  handlerName: message-handler name (default "pdfe"),
 *                       telemetry: also forward per-keystroke timings.
 * @returns the object also published as window.PdfeNative.
 */
export function attachNativeHost(editor, opts = {}) {
  const send = detectTransport(opts.handlerName || "pdfe");
  let savedFile = null;

  const emit = (event, detail) => send({ event, ...(detail || {}) });

  // "page" is in here so a native shell can show a live page number without
  // polling `state` on every scroll frame (the SDK already coalesces it).
  for (const ev of ["ready", "opened", "editmode", "editopen", "editclose",
                    "dirty", "zoom", "page", "error"]) {
    editor.on(ev, (detail) => emit(ev, detail));
  }
  if (opts.telemetry) editor.on("edit", (d) => emit("edit", d));

  const commands = {
    /** Liveness + handshake. */
    ping: () => ({ pong: true, pageCount: editor.pageCount }),

    /**
     * Open the document the native side is serving at `url` (a custom-scheme URL
     * it streams the file bytes into). `name` shows up in the suggested save name.
     *
     * `password` (optional, default none) unlocks an encrypted PDF. When the
     * document is locked the command comes back `{ok:false, error:{code}}` with
     * code `password-required` (none supplied) or `password-wrong` (supplied and
     * refused) — the native side raises ITS OWN prompt and calls `open` again
     * with the same url plus the password. Nothing here stores it.
     */
    open: async ({ url, name, password }) => editor.open(url, { name, password }),

    /** Fallback path for small documents when no scheme handler is available. */
    openBase64: async ({ data, name, password }) =>
      editor.open(fromBase64(data), { name, password }),

    /**
     * Commit + save. Returns the sizes only; the BYTES are pulled afterwards
     * with readChunk (JSON bridges cannot carry them).
     */
    save: async ({ allowInMemory } = {}) => {
      const res = await editor.save({ allowInMemory: !!allowInMemory });
      savedFile = res.file;
      return {
        bytes: res.bytes, ms: res.ms, flat: res.flat, heapMB: res.heapMB,
        suggestedName: res.suggestedName, chunkSize: CHUNK,
      };
    },

    /** Pull one slice of the last save as base64. */
    readChunk: async ({ offset = 0, length = CHUNK } = {}) => {
      if (!savedFile) throw new Error("no saved file to read");
      const end = Math.min(savedFile.size, offset + length);
      const buf = await savedFile.slice(offset, end).arrayBuffer();
      return { data: toBase64(new Uint8Array(buf)), offset, length: end - offset,
               eof: end >= savedFile.size, total: savedFile.size };
    },

    /** Native side finished copying the bytes: drop the staged OPFS copy. */
    releaseSaved: () => { savedFile = null; editor.releaseSaved(); return {}; },

    setEditMode: ({ on }) => { editor.setEditMode(!!on); return { editMode: editor.editMode }; },
    toggleEditMode: () => { editor.toggleEditMode(); return { editMode: editor.editMode }; },
    commit: () => { editor.commit(); return {}; },

    setZoom: ({ zoom }) => { editor.setZoom(Number(zoom)); return { zoom: editor.zoom }; },
    zoomIn: () => { editor.zoomIn(); return { zoom: editor.zoom }; },
    zoomOut: () => { editor.zoomOut(); return { zoom: editor.zoom }; },
    fitWidth: () => { editor.fitWidth(); return { zoom: editor.zoom }; },

    /**
     * Recolour the surround behind the pages (any CSS colour; omit to reset to
     * the default #f8f9fb). A native shell also needs to paint its OWN view the
     * same colour — the WKWebView sits inside a UIView, and only matching the
     * two removes the seam on rubber-band overscroll.
     */
    setBackgroundColor: ({ color } = {}) => ({ color: editor.setBackgroundColor(color) }),

    toggleLineMode: () => { editor.toggleLineMode(); return {}; },
    setLineMode: ({ preserve }) => { editor.setLineMode(!!preserve); return {}; },

    /**
     * Turn box dragging on or off — an EXPERIMENTAL feature that ships OFF
     * (docs/BLOCK_MOVE.md). This command exists because a kill switch a phone shell
     * cannot reach is not a kill switch: iOS runs this bundle inside a WKWebView, so
     * without it a native product could enable nothing and, worse, disable nothing.
     */
    setBlockMove: ({ on } = {}) => ({ blockMove: editor.setBlockMove(!!on) }),

    /** Go to a 0-based page. `ok:false` in the result means out of range. */
    goToPage: ({ page }) => ({ ok: editor.goToPage(Number(page)), page: editor.currentPage }),
    /** Deprecated alias kept for shells built against the older bridge. */
    scrollToPage: ({ page }) => ({ ok: editor.goToPage(Number(page)), page: editor.currentPage }),

    /**
     * The on-screen keyboard's height, in CSS px. The native side knows this
     * exactly (and earlier) than visualViewport does, so it drives the inset:
     * the host page reserves that much space and the caret is scrolled back
     * into view — the "text hidden behind the keyboard" failure mode.
     */
    setKeyboardInset: ({ height }) => {
      // Once the native side drives the inset, the page's visualViewport
      // fallback must stand down (they would fight over the same variable).
      globalThis.__pdfeNativeInset = true;
      document.documentElement.style.setProperty("--pdfe-keyboard-inset", `${Number(height) || 0}px`);
      requestAnimationFrame(() => editor.scrollCaretIntoView());
      return {};
    },

    state: () => ({
      pageCount: editor.pageCount, page: editor.currentPage,
      zoom: editor.zoom, editMode: editor.editMode, blockMove: editor.blockMove,
      dirty: editor.dirty, editing: editor.editing, capabilities: editor.capabilities,
      documentName: editor.documentName, documentBytes: editor.documentBytes,
      suggestedName: editor.suggestedName(),
    }),
  };

  const api = {
    /** The one entry point the native side calls. Never throws. */
    async command(name, args) {
      const fn = commands[name];
      if (!fn) return { ok: false, error: { code: "unknown-command", message: name } };
      try {
        return { ok: true, result: (await fn(args || {})) ?? {} };
      } catch (e) {
        return {
          ok: false,
          error: {
            code: e?.code || "command-failed",
            message: e?.message || String(e),
            // Save-consent/size details the native UI needs for its own dialog.
            sizeMB: e?.sizeMB, limitMB: e?.limitMB,
          },
        };
      }
    },
    editor,
  };

  globalThis.PdfeNative = api;
  emit("bridgeReady", { commands: Object.keys(commands) });
  return api;
}

export default attachNativeHost;
