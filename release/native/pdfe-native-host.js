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
/** base64 PNG/JPEG → an ImageBitmap, or null when it does not decode (W5a). */
async function decodePicture(data) {
  if (typeof data !== "string" || !data) return null;
  try { return await createImageBitmap(new Blob([fromBase64(data)])); } catch { return null; }
}

/** A signature as JSON can carry it: a picture's pixels never cross the bridge (W4). */
function bridgeSignature(sig) {
  if (!sig) return null;
  if (sig.type === "picture") return { type: "picture", width: sig.image?.width ?? 0, height: sig.image?.height ?? 0 };
  return sig;
}

// The page-selection switches setSelectionOptions takes (W3) — PdfeEditorView's names.
const SELECTION_BOOLS = ["viewTextSelectionEnabled", "viewSelectionMenuEnabled",
  "annotateTextSelectionEnabled", "annotateSelectionMenuEnabled", "markupOnSelectionEnd",
  "markupOnToolPick", "annotateDragSelectEnabled", "newSelectionDeselectsAnnotation",
  "tapKeepsAnnotationSelected"];

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
                    "selection", "inputRejected", "error", "fontsReady",
                    // ADD TEXT (docs/ADD_TEXT.md). Forwarded in the SAME change as the
                    // armAddText command, deliberately: telling a native shell that the
                    // mode is armed while giving it no way to arm or cancel would be a
                    // worse shape than a declared gap.
                    "addtextarmed",
                    // IMAGE EDIT (docs/IMAGE_EDIT.md). `select`, `moved` and `deleted`
                    // already carried pictures here — they gained a `kind` field, not a
                    // new name. `rotated` is the one genuinely new event, because no
                    // text verb turns anything, and it is forwarded in the SAME change
                    // as the rotateSelection command for the reason addtextarmed was:
                    // telling a shell a picture turned while giving it no way to turn
                    // one is a worse shape than a declared gap.
                    "rotated",
                    // THE MODE (docs/annotations/12-VOCABULARY.md). Forwarded in the
                    // SAME change as the setMode command. Note this puts a SECOND
                    // message on the wire for every edit-mode toggle, because
                    // setEditMode now funnels through setMode -- additive, exactly as
                    // `rotated` and `addtextarmed` were, but a shell with an
                    // exhaustive switch over event names sees a name it has not seen.
                    "mode",
                    // ANNOTATE MODE (annotations step 19, 3.15.0) — forwarded in the SAME
                    // change as the commands below, the addtextarmed rule.
                    "markuptool", "markupcolor", "markupcreated", "markupdeleted",
                    "pagetextselection",
                    // W3: a long-press (selected or only reported) and a words-menu pick. A
                    // native shell cannot preventDefault in time, so — as with "action" — to
                    // change what a built-in item does it lists its OWN id instead.
                    "pagelongpress", "selectionmenuitem",
                    // W4: signatures — the pick (turning off too), the start and end of a
                    // placement, and the WHICH of a delete.
                    "signaturetool", "signatureplacing", "signatureplaced", "signaturedeleted",
                    // DR3: drawing — the tool (and its colour / width), each stroke's start and
                    // end, and what a stroke, an eraser pass, a move or a restyle did.
                    "drawingtool", "drawingstroke", "drawingcreated", "drawingchanged", "drawingdeleted",
                    // W5a: a picture armed for the next tap, or the arm spent / dropped.
                    "imageinserting",
                    // W5c: a finger moves / resizes / turns the selection (and when it is over).
                    "selectiongesture",
                    // W6: a tap on a web address in reading mode (the SDK opens nothing).
                    "linktapped",
                    // THE CLIENT'S OWN DESIGN (3.3.0): a bar button was tapped. A native
                    // shell cannot answer in time to stop the SDK, so it routes by ID: an
                    // app's own id (an AI button, say) is only reported, and to change what a built-in
                    // does it lists its own id instead and calls performAction itself.
                    "action",
                    // What an app's own chrome follows (3.3.0): the selection's place on
                    // screen, and the keyboard (the SDK's typing target focused or not).
                    "selectionrect", "keyboard",
                    // The reader (3.3.0): where it is, its scroll state, the ends, a reading tap.
                    "scroll", "scrollstate", "scrolledge", "pagetap",
                    // Text search (3.3.0): the whole snapshot on every change.
                    "search",
                    // The text check (3.16.0): a NEW answer, { hasText }.
                    "textcheck",
                    // 3.17.0: a file is opening { opening }; a save / export is writing { saving, kind }.
                    "opening", "saving"]) {
    // "select" carries WHERE the selection is on screen too (3.3.0), so a native shell
    // that turned the SDK's bar off (setActionBarEnabled) can put its own buttons there.
    // "pagelongpress" carries the press ON SCREEN and "pagetextselection" the selection's
    // screen rect (W3), so a native shell can put its own popup there without a round trip.
    editor.on(ev, (detail) => emit(ev,
      ev === "select" || ev === "pagetextselection" ? { ...detail, screenRect: editor.selectionScreenRect }
      : ev === "pagelongpress" ? { ...detail, screen: editor.pageToScreen(detail.page, detail.xPt, detail.yPt) }
      : ev === "selectionmenuitem" ? { item: detail.item, selection: detail.selection }
      : ev === "signaturetool" ? { signature: bridgeSignature(detail.signature) }
      : detail));
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
    // `mode` (W2): open straight into "annotate" (Android's openPdfInAnnotateMode) or "text".
    open: async ({ url, name, password, mode }) => editor.open(url, { name, password, mode }),

    /** Fallback path for small documents when no scheme handler is available. */
    openBase64: async ({ data, name, password, mode }) =>
      editor.open(fromBase64(data), { name, password, mode }),

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

    /**
     * exportFlattened (3.2.0): a COPY with the annotations burned in, for printing. Like
     * `save` it returns the SIZE only; the bytes are pulled with readChunk and released
     * with releaseSaved — they are staged in the same slot, so an export replaces a save
     * not yet read, and the reverse, exactly as two saves in a row do. Not a save: the
     * open document, its history and its dirty flag are unchanged.
     */
    exportFlattened: async () => {
      const bytes = await editor.exportFlattened();
      savedFile = new Blob([bytes], { type: "application/pdf" });
      return { bytes: bytes.length, chunkSize: CHUNK };
    },

    /** Pull one slice of the last save (or exportFlattened) as base64. */
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
     * THE MODE: `"view"` | `"text"` | `"annotate"`
     * (docs/annotations/12-VOCABULARY.md). The general form of the two commands
     * above -- `setEditMode({on:true})` is `setMode({mode:"text"})`, and both keep
     * working, because `editMode` is exactly `mode === "text"` in both directions.
     *
     * `"annotate"` is ACCEPTED AND INERT: it can be set and read back, and it
     * currently behaves like `"view"`. Marking up arrives at roadmap step 13.
     *
     * An unrecognised mode is IGNORED rather than refused, matching the SDK verb --
     * so the reply, like every other setter here, is the RESULTING state, which is
     * how a shell tells whether its value was taken.
     */
    setMode: ({ mode }) => {
      editor.setMode(mode);
      return { mode: editor.mode, editMode: editor.editMode };
    },
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
    /**
     * Leave the mode, reverting everything done in it (W2). Answers once the page is
     * reverted; refused with `discard-unavailable` when `canDiscard` (in `state` and on the
     * `mode` event) is false. Ask the user first — it cannot be undone.
     */
    discardModeChanges: async () => { await editor.discardModeChanges(); return { mode: editor.mode }; },
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

    // ---- select-then-act, for ALL FOUR verbs (docs/IMAGE_EDIT.md, BLOCK_MOVE.md) --
    // THE DECLARED GAP IS CLOSED HERE, AND AS ONE UNIT because that is how it was
    // declared: the bridge had no select-then-act command at all, and the gate's
    // KNOWN_BRIDGE_GAPS said in those words that adding one alone "would make it the
    // only selection command on the bridge, which is a worse shape than none. When it
    // is done, add all four here and to pdfe-native-host.js in one change."
    //
    // Pictures are what forced it: a native shell could be TOLD a picture was selected
    // and had no way to delete, deselect or nudge it. Each routes by what is selected,
    // so a shell learns one verb for both kinds, never a picture-specific twin
    // (IMAGE_EDIT.md §6).
    editSelection: () => { editor.editSelection(); return { ok: true }; },
    deleteSelection: () => { editor.deleteSelection(); return { ok: true }; },
    clearSelection: () => { editor.clearSelection(); return { ok: true }; },
    // Select ALL the text of the open box (3.1.0). ok:false when no box is open, the
    // mode is not text, or the box is empty. Focus is not touched, so the keyboard stays.
    selectAllText: () => ({ ok: editor.selectAllText() }),
    // Show or hide Delete in a PICTURE's action bar (3.1.0): `{ on: false }` hides it.
    setImageDeleteControl: ({ on } = {}) => {
      editor.setImageDeleteControl(on !== false);
      return { ok: true, on: editor.imageDeleteControl };
    },
    // ---- the client's own design (3.3.0) -----------------------------------
    // The look: the same fields as Android's PdfeAppearance; colours as CSS strings.
    setAppearance: ({ appearance } = {}) => { editor.setAppearance(appearance || {}); return { ok: true }; },
    // The action bar's buttons for "text" or "image": [{id, label?, icon?}], icon = SVG
    // markup or an image URL. Taps arrive as the "action" event.
    setActions: ({ kind, actions } = {}) => {
      editor.setActions(String(kind), Array.isArray(actions) ? actions : []);
      return { ok: true, actions: editor.actions(String(kind)) };
    },
    setActionBarEnabled: ({ on } = {}) => {
      editor.setActionBarEnabled(on !== false);
      return { ok: true, on: editor.actionBarEnabled };
    },
    performAction: ({ id } = {}) => ({ ok: editor.performAction(String(id)) }),
    // The keyboard while a box stays open (3.3.0). iOS raises a keyboard only from a user
    // gesture inside the web view, so showKeyboard may report ok and raise nothing there.
    showKeyboard: () => ({ ok: editor.showKeyboard() }),
    hideKeyboard: () => { editor.hideKeyboard(); return { ok: true }; },
    selectionScreenRect: () => ({ ok: true, rect: editor.selectionScreenRect }),
    moveSelection: ({ dx, dy } = {}) => {
      editor.moveSelection(Number(dx) || 0, Number(dy) || 0);
      return { ok: true };
    },

    // ---- pictures (docs/IMAGE_EDIT.md) --------------------------------------
    // Turning and nudging a PICTURE. Deleting one is deleteSelection above, and
    // selecting one is a tap inside the web view, so neither gets a twin here.
    rotateSelection: ({ turns } = {}) => ({
      ok: editor.rotateSelection(turns === undefined ? 1 : Math.trunc(Number(turns) || 0)),
    }),
    moveImageSelection: ({ dx, dy } = {}) => ({
      ok: editor.moveImageSelection(Number(dx) || 0, Number(dy) || 0),
    }),
    /** Where the rotate control lives: "both" | "handle" | "bar" | "none". */
    setImageRotateControl: ({ where } = {}) => {
      editor.setImageRotateControl(where);
      return { imageRotateControl: editor.imageRotateControl };
    },

    // ---- ANNOTATE MODE (annotations step 19, 3.15.0) -------------------------
    // The same names and payloads as the web API and Android (12-VOCABULARY §6–§8, §15,
    // §19, §20). Each arm REPORTS ITSELF through its event (parity rule 14), so these
    // commands return only what is already true when they return.
    setMarkupTool: ({ tool } = {}) => {
      editor.setMarkupTool(tool == null ? null : String(tool));
      return { markupTool: editor.markupTool, markupColor: editor.markupColor };
    },
    setMarkupColor: ({ color } = {}) => {
      editor.setMarkupColor(color);
      return { markupColor: editor.markupColor, markupColors: editor.markupColors };
    },
    markupSelection: ({ tool, color, select } = {}) => { editor.markupSelection(String(tool), color, select === true); return { ok: true }; },
    setSelectedMarkupColor: ({ color } = {}) => { editor.setSelectedMarkupColor(color); return { ok: true }; },
    setMarkupAuthor: ({ name } = {}) => { editor.setMarkupAuthor(name); return { markupAuthor: editor.markupAuthor }; },
    setMarkupLineRatio: ({ ratio, minWidth } = {}) => {
      editor.setMarkupLineRatio(ratio, minWidth);
      return { markupLineRatio: editor.markupLineRatio, markupLineMinWidth: editor.markupLineMinWidth };
    },
    /**
     * The page-selection switches and the words menu, by name — any subset: the nine booleans
     * (viewTextSelectionEnabled, viewSelectionMenuEnabled, annotateTextSelectionEnabled,
     * annotateSelectionMenuEnabled, markupOnSelectionEnd, markupOnToolPick,
     * annotateDragSelectEnabled, newSelectionDeselectsAnnotation, tapKeepsAnnotationSelected), `selectionMenuItems` (ids) and the per-mode button lists
     * `viewSelectionMenuActions` / `annotateSelectionMenuActions` ([{id, label?, icon?}] or
     * null). The menu LAYOUTS are DOM elements and so web-only. Returns every value as it stands.
     */
    setSelectionOptions: (o = {}) => {
      for (const k of SELECTION_BOOLS) if (k in o) editor[k] = !!o[k];
      for (const k of ["selectionMenuItems", "viewSelectionMenuActions", "annotateSelectionMenuActions"])
        if (k in o) editor[k] = o[k];
      const out = {};
      for (const k of [...SELECTION_BOOLS, "selectionMenuItems", "viewSelectionMenuActions",
                       "annotateSelectionMenuActions"]) out[k] = editor[k];
      return out;
    },
    /** A page point on screen, {x, y} in CSS px from the editor's top-left, or null. */
    /**
     * Pick what the next tap in annotate places (W4), or `{signature: null}` to turn it off.
     * The shapes are the web's (`type` drawn / typed / text), and a picture travels as
     * `{type: "picture", data: <base64 PNG or JPEG>}` — decoded here, then picked.
     */
    setSignatureTool: async ({ signature } = {}) => {
      if (signature && signature.type === "picture" && typeof signature.data === "string") {
        let bmp;
        try { bmp = await createImageBitmap(new Blob([fromBase64(signature.data)])); }
        catch (e) { throw Object.assign(new Error("the picture data could not be decoded"), { code: "signature-empty" }); }
        editor.setSignatureTool({ type: "picture", image: bmp });
      } else editor.setSignatureTool(signature ?? null);
      return { signatureTool: bridgeSignature(editor.signatureTool) };
    },
    /**
     * Put a picture on the page (W5a): `{data: <base64 PNG/JPEG>}` centred on what the reader
     * sees, or with `page`, `xPt`, `yPt` (PDF points) there. Half the page, upright, selected,
     * one undo step; switches to text mode. Replies `{ok}`; a bad picture is `ok: false`.
     */
    insertImage: async ({ data, page, xPt, yPt } = {}) => {
      const bmp = await decodePicture(data);
      if (!bmp) throw Object.assign(new Error("the picture data could not be decoded"), { code: "insert-failed" });
      const ok = page == null ? (xPt == null ? editor.insertImage(bmp) : editor.insertImageAt(bmp, Number(xPt), Number(yPt)))
                              : editor.insertImageAt(bmp, Number(page), Number(xPt), Number(yPt));
      return { ok: !!ok };
    },
    /** Arm a picture `{data}`: the next tap in text mode places it. Reports `imageinserting`. */
    armInsertImage: async ({ data } = {}) => {
      const bmp = await decodePicture(data);
      if (!bmp) throw Object.assign(new Error("the picture data could not be decoded"), { code: "insert-failed" });
      editor.armInsertImage(bmp);
      return { isInsertingImage: editor.isInsertingImage };
    },
    cancelInsertImage: () => { editor.cancelInsertImage(); return { isInsertingImage: editor.isInsertingImage }; },
    // W5b: free resize / stretch / turn of the selected picture or signature, from code. Each
    // replies {ok} — the change lands a moment later; read the geometry on `rotated` / `moved`,
    // or with selectionGeometry.
    rotateSelectionBy: ({ degrees } = {}) => ({ ok: editor.rotateSelectionBy(Number(degrees)) }),
    setSelectionAngle: ({ degrees } = {}) => ({ ok: editor.setSelectionAngle(Number(degrees)) }),
    resizeSelectionBy: ({ scale } = {}) => ({ ok: editor.resizeSelectionBy(Number(scale)) }),
    stretchSelectionBy: ({ scaleX, scaleY } = {}) => ({ ok: editor.stretchSelectionBy(Number(scaleX), Number(scaleY)) }),
    /** Where the selection is and how it is turned: corners (CSS px of the web view, own order BL,
     *  BR, TR, TL), the top anchor, the angle (clockwise degrees) and whether it can turn. */
    selectionGeometry: () => ({ corners: editor.selectionScreenCorners, topAnchor: editor.selectionTopAnchor,
                                angle: editor.selectionAngle, canRotate: editor.canRotateSelection }),
    /**
     * W5c: the knobs of a selected picture, signature and/or drawing (3.16.0) —
     * `{imageHandles, signatureHandles, drawingHandles}`,
     * either may be left out. Each is a PdfeHandleConfig object: `corners`, `edges`,
     * `cornerButton`, `pinch` ("none" | "resize" | "rotate" | "resizeAndRotate" | "stretch"),
     * `cornerStyle`, `edgeStyle`, `knobs` ({topLeft: {job, filled, fillColor, …}, …}).
     * Replies both as they stand (cleaned).
     */
    setSelectionHandles: ({ imageHandles, signatureHandles, drawingHandles } = {}) => {
      if (imageHandles !== undefined) editor.imageHandles = imageHandles;
      if (signatureHandles !== undefined) editor.signatureHandles = signatureHandles;
      if (drawingHandles !== undefined) editor.drawingHandles = drawingHandles;
      return { imageHandles: editor.imageHandles, signatureHandles: editor.signatureHandles,
               drawingHandles: editor.drawingHandles,
               isSelectionGestureActive: editor.isSelectionGestureActive };
    },
    /**
     * W6: the reader's switches, by name — any subset of `linksEnabled`, `nightMode`,
     * `scrollEnabled`, `pageSpacingDp`, `scrollDirection` ("vertical" | "horizontal"), `pageSnap`,
     * `uniformPageWidth`, `zoomConfig` ({minZoom, maxZoom, stretchBeyondLimits,
     * stretchMin, stretchMax, springBackDurationMs, doubleTapEnabled, doubleTapZoom,
     * doubleTapDurationMs, pinchMomentum, pinchMomentumDurationMs}). Replies all of them as they
     * stand (zoomConfig corrected).
     */
    setReaderOptions: (o = {}) => {
      for (const k of ["linksEnabled", "nightMode", "scrollEnabled", "pageSnap", "uniformPageWidth"]) if (k in o) editor[k] = !!o[k];
      if ("pageSpacingDp" in o) editor.pageSpacingDp = Number(o.pageSpacingDp);
      if ("zoomConfig" in o) editor.zoomConfig = o.zoomConfig;
      if ("scrollDirection" in o) editor.scrollDirection = o.scrollDirection;
      return { linksEnabled: editor.linksEnabled, nightMode: editor.nightMode, scrollEnabled: editor.scrollEnabled,
               pageSpacingDp: editor.pageSpacingDp, zoomConfig: editor.zoomConfig,
               scrollDirection: editor.scrollDirection, pageSnap: editor.pageSnap, uniformPageWidth: editor.uniformPageWidth };
    },
    /** The middle of what the reader sees, {page, xPt, yPt}, or null. */
    visibleCenter: () => ({ point: editor.visibleCenter() }),
    /** The two signature switches, by name — any subset. Returns both as they stand. */
    setSignatureOptions: (o = {}) => {
      for (const k of ["otherAppStampsEditable", "signatureToolSelectsExisting"]) if (k in o) editor[k] = !!o[k];
      return { otherAppStampsEditable: editor.otherAppStampsEditable,
               signatureToolSelectsExisting: editor.signatureToolSelectsExisting };
    },
    pageToScreen: ({ page, xPt, yPt } = {}) => ({ point: editor.pageToScreen(Number(page), Number(xPt), Number(yPt)) }),

    // ---- DRAWING (DR3, vocabulary §25) --------------------------------------
    /** Pick up "pen" or "eraser", or put it down with null. Replies the tool state. */
    setDrawingTool: ({ tool = null } = {}) => {
      editor.setDrawingTool(tool ?? null);
      return { drawingTool: editor.drawingTool };
    },
    /** Any subset of `color`, `widthDp`, `eraserWidthDp`, `eraserCutsStrokes`, `drawingStylusOnly`,
     *  `otherAppInkEditable`. Replies all of them as they stand. */
    setDrawingOptions: (o = {}) => {
      if ("color" in o) editor.setDrawingColor(o.color);
      if ("widthDp" in o) editor.setDrawingWidth(Number(o.widthDp));
      if ("eraserWidthDp" in o) editor.eraserWidthDp = Number(o.eraserWidthDp);
      for (const k of ["eraserCutsStrokes", "drawingStylusOnly", "otherAppInkEditable"]) if (k in o) editor[k] = !!o[k];
      return { drawingTool: editor.drawingTool, color: editor.drawingColor, widthDp: editor.drawingWidthDp,
               eraserWidthDp: editor.eraserWidthDp, eraserCutsStrokes: editor.eraserCutsStrokes,
               drawingStylusOnly: editor.drawingStylusOnly, otherAppInkEditable: editor.otherAppInkEditable };
    },
    /** Restyle the selected drawing: `{color?, widthPt?}` (one undo step). Replies `{selectedDrawing}`. */
    setSelectedDrawingStyle: ({ color, widthPt } = {}) => {
      editor.setSelectedDrawingStyle({ color, widthPt });
      return { selectedDrawing: editor.selectedDrawing };
    },

    // ---- ADD TEXT (docs/ADD_TEXT.md) ---------------------------------------
    // Placing a NEW text box where the document has none. An ARMED mode, so this is
    // two commands and a report rather than one "insert" call: the SDK cannot know
    // where the user wants the box, and the tap that decides is a gesture inside the
    // web view, not something a native shell can pass as coordinates.
    //
    // WHY IT MATTERS THAT THESE EXIST AT ALL: iOS drives this bridge and NEVER the JS
    // API. Without them the feature is present in the bundle an iPhone is already
    // running and unreachable from it — the 1.6.0 password shape exactly, one feature
    // over (docs/CONSUMER_CONTRACT.md).

    /**
     * Arm ADD TEXT: the next tap in the page area creates an empty text box there with
     * the caret inside it, and the arm is spent. Typing, styling, undo, save and
     * dragging then behave as they do in any other box.
     *
     * Nothing is created until a character is typed — a box the user places and taps
     * away from evaporates, leaving no object and no undo step. Turns edit mode on if
     * it is off, because placing text is editing.
     *
     * Watch the `addtextarmed` event for the state, INCLUDING the disarm that the
     * placing tap performs — a button driven by your own click handler will go stale.
     */
    // ⚠️ RETURNS ONLY `ok`, AND THAT IS DELIBERATE. An earlier version also returned
    // `addingText`, and it LIED: arming round-trips through the worker, so the field
    // still reads false when this returns, and a shell trusting the result would decide
    // the arm had failed. The `addtextarmed` event is the truth; `state` is the re-sync.
    // Measured through this bridge, not reasoned about.
    // W7a: with `{text}` the box placed by the next tap holds that text and closes (one undo step).
    armAddText: ({ text } = {}) => ({ ok: editor.armAddText(text) }),
    /** W7a: a box holding `text` at `{page, xPt, yPt}` right away, no tap. Replies {ok}. */
    addTextAt: ({ text, page, xPt, yPt } = {}) => ({ ok: editor.addTextAt(String(text ?? ""), Number(page), Number(xPt), Number(yPt)) }),
    /** W7a: a box holding `text` in the middle of what the reader sees. Replies {ok}. */
    addTextAtCenter: ({ text } = {}) => ({ ok: editor.addTextAtCenter(String(text ?? "")) }),
    /** W7a: `addTextPlaceholder` (the words an empty box shows, null = none) and
     *  `addTextScreenSizeDp` (a new box's text size on screen, 0 = the point size), any subset. */
    setAddTextOptions: (o = {}) => {
      if ("addTextPlaceholder" in o) editor.addTextPlaceholder = o.addTextPlaceholder;
      if ("addTextScreenSizeDp" in o) editor.addTextScreenSizeDp = Number(o.addTextScreenSizeDp);
      return { addTextPlaceholder: editor.addTextPlaceholder, addTextScreenSizeDp: editor.addTextScreenSizeDp };
    },

    /** Disarm ADD TEXT without placing anything. Safe when not armed. */
    cancelAddText: () => { editor.cancelAddText(); return {}; },

    /**
     * The default look for text created by `armAddText`. Every field is optional and
     * independent, so sending only `color` leaves the face and size alone. `font` is a
     * family name you loaded with `loadFont` (or a standard-14 name); one this document
     * cannot resolve falls back to the built-in Helvetica rather than failing.
     */
    setNewTextStyle: ({ font, size, color } = {}) => {
      const style = {};
      if (font !== undefined) style.font = font;
      if (size !== undefined) style.size = size;
      if (color !== undefined) style.color = color;
      editor.setNewTextStyle(style);
      return {};
    },

    /** Go to a 0-based page. `ok:false` in the result means out of range. */
    goToPage: ({ page, animated }) => ({ ok: editor.goToPage(Number(page), animated === true), page: editor.currentPage }),
    // The reader (3.3.0): scroll to a place 0..1 (an own scroll handle, continue reading).
    scrollToPosition: ({ position, animated } = {}) => {
      editor.scrollToPosition(Number(position), animated === true);
      return { ok: true, position: editor.scrollPosition };
    },
    // Text search (3.3.0). Progress and results arrive as `search` events.
    search: ({ query, matchCase, wholeWord } = {}) => {
      editor.search(String(query ?? ""), { matchCase: matchCase === true, wholeWord: wholeWord === true });
      return { ok: true };
    },
    goToNextResult: () => ({ ok: editor.goToNextResult(), search: editor.searchState() }),
    goToPreviousResult: () => ({ ok: editor.goToPreviousResult(), search: editor.searchState() }),
    clearSearch: () => { editor.clearSearch(); return { ok: true }; },
    // The text check (3.16.0, docs/api/text-check.md). Off by default.
    setTextCheckOnOpen: ({ enabled } = {}) => { editor.textCheckOnOpen = enabled === true; return { textCheckOnOpen: editor.textCheckOnOpen }; },
    /** { hasText } — saved after the first time; `force: true` works it out again. Fails with
     *  `no-document` or `superseded`. A NEW answer also arrives as the `textcheck` event. */
    checkText: async ({ force } = {}) => editor.checkText({ force: force === true }),
    /** { kind }: "text" | "scanned" | "scannedWithOcr" | "noText", or null (out of range). */
    pageKind: async ({ page } = {}) => ({ kind: await editor.pageKind(Number(page)) }),
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
    //
    // Since 2026-09-29 (V2, the review fixes) this IS the web SDK's own state():
    // one key list for the web host and the iOS shell, which also gained canUndo /
    // canRedo here. Parity rule 13 reads the keys from pdfe-editor.js's state().
    // (A picked picture's ImageData serialises as {} — its pixels never cross the bridge.)
    state: () => editor.state(),
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
