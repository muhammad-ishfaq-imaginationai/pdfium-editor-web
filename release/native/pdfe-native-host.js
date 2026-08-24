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
  // "history" is here so a native shell can enable/disable its undo and redo
  // buttons from the ENGINE's answer instead of guessing. Without it a shell has
  // no way to know a step exists, which is how iOS ended up with undo it could
  // neither trigger nor display.
  // "styled" and "selection" carry the style under the cursor. Without them a
  // native shell cannot paint a colour swatch at all, let alone follow the caret
  // — the 1.6.0 password gap shape exactly: surface that exists on web and never
  // reached the platform that drives the bridge instead of the JS API.
  //
  // ⚠️ "select" vs "selection" ARE DIFFERENT EVENTS and the near-name is why the
  // first one went missing for months (added 2026-08-13, user-reported):
  //   * "select"    — a BOX was tapped or deselected  → {selection: {...}|null}
  //   * "selection" — the TEXT RANGE/caret moved      → {start, end, style}
  // Without "select" a native shell cannot tell that the user tapped a box at
  // all, so it cannot drive its own Edit/Delete bar — the whole point of the
  // chrome-free surface. "deleted" and "moved" complete the box lifecycle
  // (tap → edit → move → delete); web and Android had them, the bridge did not.
  // The release gate now enforces this list against the SDK's own events.
  // "inputRejected" (2026-08-19) is on this list for the reason the list exists: the
  // editor refuses input no font can draw (an emoji would otherwise be SAVED as a
  // different character), and a native shell that never hears about it can only show
  // a keyboard whose keys do nothing.
  for (const ev of ["ready", "opened", "editmode", "select", "editopen", "editclose",
                    "deleted", "moved", "dirty", "zoom", "page", "history", "styled",
                    "selection", "inputRejected", "error", "fontsReady"]) {
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
    /**
     * Leave box editing: commit the open run and DROP THE KEYBOARD. A native
     * shell needs this before it presents anything of its own over the WebView,
     * and `save` now does it for you.
     */
    getOutOfBoxEditing: () => { editor.getOutOfBoxEditing(); return { editing: editor.editing }; },
    /** The original name, kept forever — identical behaviour. */
    commit: () => { editor.commit(); return {}; },

    // ---- undo / redo -------------------------------------------------------
    // THE SEAM NO BROWSER TEST TOUCHES (CLAUDE.md's five seams, #4). Undo was built
    // for web and then for Android, and iOS drives neither of those APIs — it drives
    // this file. Without these three commands iOS has no undo at all, which is the
    // exact shape of the 1.6.0 password gap: every test green, one platform missing
    // the feature, discovered by a user.
    //
    // ⚠️ THE REPLY IS THE PAIR *BEFORE* THE STEP LANDS. editor.undo() posts to the
    // worker and returns immediately, so canUndo/canRedo read here are the state the
    // shell already had. They are returned anyway because a shell that wants a simple
    // request/response gets something coherent — but the TRUTH is the "history" event
    // forwarded above, which fires when the engine has actually applied the step. A
    // shell that paints its buttons from this reply will be one step behind.
    //
    // There is deliberately no setHistoryEnabled command: the web SDK exposes no such
    // toggle (this branch's worker turns recording on unconditionally), and inventing
    // a bridge command with no API under it would be a lie the parity gate cannot see.
    /**
     * Phase 5 (word-level undo): tell the engine a typing pause happened, so
     * the next keystroke starts a fresh undo entry. A native shell calls this
     * from its own ~300 ms idle timer and on focus loss; the web SDK already
     * does it for its own sink, so this exists for shells that drive editing
     * through the bridge.
     */
    sealHistory: () => { editor._post({ type: "sealHistory" }); return {}; },
    /**
     * The native shell persisted the document itself — it wrote the bytes from
     * `save` to its own storage, uploaded them, or handed them to a share sheet
     * that reported success — and is declaring it. Clears the undo/redo history
     * and the dirty flag.
     *
     * A phone shell needs this more than a browser host does: it is the platform
     * where the SDK produces bytes and something entirely outside the WebView
     * decides whether they were kept. Send it AFTER the write succeeds.
     */
    markSaved: () => { editor.markSaved(); return { dirty: editor.dirty }; },
    undo: () => { editor.undo(); return { canUndo: editor.canUndo, canRedo: editor.canRedo }; },
    redo: () => { editor.redo(); return { canUndo: editor.canUndo, canRedo: editor.canRedo }; },

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

    // ---- character-level colour (docs/STYLING.md) ---------------------------
    // The web SDK has had these since colour landed; the bridge had NONE of them,
    // so a native shell could not colour text or even read the style under the
    // cursor. Added with the caret-follows-colour work so the iOS phase is Swift
    // wrapping and nothing more. They joined the gate's REQUIRED list on 2026-08-13,
    // when Android's colour surface landed and the promise became one every shell
    // could actually keep.

    /** Colour the current selection, and arm the colour for what is typed next. */
    applyTextColor: ({ color }) => { editor.applyTextColor(color); return {}; },
    /** Drop the armed typing colour; the next character inherits from its left. */
    clearTypingColor: () => { editor.clearTypingColor(); return {}; },
    /**
     * Size the current selection, and arm the size for what is typed next. `pt` is
     * EFFECTIVE (on-page) points — the number the user picked.
     *
     * This is the seam CLAUDE.md calls "the one that gets forgotten, because no browser
     * test touches it": iOS drives this bridge and never calls the JS API, so a verb
     * missing here is a capability iOS silently does not have. 1.6.0 shipped passwords
     * to web and Android and not to iOS for exactly that reason.
     */
    applyFontSize: ({ pt, sizePt } = {}) => {
      // Accept either key: the JS method's parameter is `pt`, while every style EVENT
      // reports `sizePt`, and a native shell that echoes back what it was told is the
      // obvious thing to write. Refusing one of them would be a papercut with no upside.
      const v = Number(pt != null ? pt : sizePt);
      editor.applyFontSize(v);
      return {};
    },
    /** Drop the armed typing size; the next character inherits from its left. */
    clearTypingSize: () => { editor.clearTypingSize(); return {}; },
    /** Ask for the style at a caret/range — answered by the `styled` event. */
    requestTextStyle: ({ start, end } = {}) => {
      editor.requestTextStyle(start | 0, end == null ? null : end | 0);
      return {};
    },
    /** Pick the lifetime: follow the caret (default) or stay sticky. */
    setTypingColorFollowsCaret: ({ on } = {}) =>
      ({ typingColorFollowsCaret: editor.setTypingColorFollowsCaret(!!on) }),
    // The same switch for the TYPEFACE (family + bold/italic together, 2026-08-20).
    // Here for the reason seam 4 exists at all: an iOS shell drives this bridge and
    // never the JS API, so a capability missing here is missing on iOS only.
    setTypingFontFollowsCaret: ({ on } = {}) =>
      ({ typingFontFollowsCaret: editor.setTypingFontFollowsCaret(!!on) }),

    // ---- the font FAMILY, and bold / italic (docs/FONTS.md) ------------------
    // Seam 4, and the one that gets forgotten because no browser test touches it.
    // A native shell is the ONLY consumer that cannot call the JS API, and fonts are
    // precisely where it would be left behind: iOS ships its own bundled faces, so
    // "the host provides the variants" means nothing to it without loadFont here.

    /**
     * Register a face the native side provides. `data` is BASE64 — a JSON bridge
     * cannot carry bytes, the same constraint that gives `open` its `openBase64`
     * twin and `save` its `readChunk` pull. Omit `data` to load a standard-14 face by
     * its PDF name, which needs no bytes at all.
     *
     * Chunking is deliberately NOT offered: a font file is tens to hundreds of KB
     * (`save` needs chunks because a PDF is megabytes), so one message is enough and
     * a chunked protocol would be state nobody needs.
     */
    loadFont: async ({ name, data } = {}) =>
      editor.loadFont({ name, bytes: data ? fromBase64(data).buffer : undefined }),

    /**
     * Await the SDK's own bundled families and learn which ones exist.
     *
     * They register automatically on every open, so a native shell does not need this to
     * get working bold/italic — it needs it for the TIMING (show a spinner, then tell the
     * user fonts are usable) and for the family list to build a picker from. Returns
     * `{ ok, families: [{ key, label, faces }], failed }`; the `fontsReady` event carries
     * the same payload for a shell that would rather listen than ask.
     */
    prepareFonts: async () => editor.prepareFonts(),

    /** Apply a family: a selected range is restyled, a bare caret arms the typing
     *  font. `name: null` = Original. */
    applyFont: ({ name } = {}) => { editor.applyFont(name == null ? null : String(name)); return {}; },

    /**
     * Bold / italic over the selection. `on` defaults to true so a shell can send a
     * bare `{cmd:"applyBold"}` for "make it bold".
     *
     * THE REFUSAL ARRIVES AS AN EVENT, not as this call's result: the apply is
     * asynchronous (it crosses to the worker), so a shell greys its buttons from
     * `selection`/`styled`'s `canBold`/`canItalic` and hears about a refusal through
     * the forwarded `error` event with code `no-such-face`.
     */
    applyBold: ({ on } = {}) => { editor.applyBold(on == null ? true : !!on); return {}; },
    applyItalic: ({ on } = {}) => { editor.applyItalic(on == null ? true : !!on); return {}; },

    /**
     * Turn box dragging on or off. It ships ON and is no longer experimental as of
     * 2.0.0 (docs/BLOCK_MOVE.md), so this is primarily the OFF switch.
     * This command exists because a kill switch a phone shell
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

    /**
     * Everything a shell needs to draw its chrome, pulled in one call.
     *
     * The three INDEPENDENT states a toolbar branches on are all here, because a
     * shell that missed an event (a web-view reload, chrome built after the tap)
     * otherwise has no way back to the truth:
     *   * `selection`     — a BOX is selected: Edit / Delete / Move are live.
     *   * `editing`       — a run is OPEN for typing: styling controls are live.
     *   * `textSelection` — a character RANGE is selected inside it: an "apply to
     *                       selection" action applies to that range rather than
     *                       arming the typing style. `null` means a bare caret.
     * `selection` and `textSelection` were added 2026-08-19; `state` had carried
     * only `editing` for its whole life, which is the pull-side twin of the gap the
     * `select` event had until 2026-08-13.
     */
    state: () => ({
      pageCount: editor.pageCount, page: editor.currentPage,
      zoom: editor.zoom, editMode: editor.editMode, blockMove: editor.blockMove,
      dirty: editor.dirty, editing: editor.editing, selection: editor.selection,
      textSelection: editor.textSelection, textStyle: editor.textStyle,
      capabilities: editor.capabilities,
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
