# pdfium-editor — demo sites

Built artifacts only, generated from the private source repo. Two sites:

| Path | Built from | Use it to |
| --- | --- | --- |
| `release/` | the **published** npm package `@muhammad-ishfaq-imaginationai/pdfe-editor` | test a release the way a consumer gets it |
| `dev/` | the working tree (**unreleased**) | look at work in progress before it ships |

A PDF text editor that edits the REAL text layer in your browser: rendering and
editing both run in a WebAssembly build of PDFium plus the same C++ editing core
that drives the Android app (verified byte-for-byte identical behaviour).

Everything runs locally — documents never leave your machine. Open a page, pick a
PDF, tap a paragraph, type. Tap outside to commit; Save streams the result to disk.

Engine provenance: PDFIUM_SOURCE_COMMIT=c2c971ad689436f3c36009603b4aa7dac9cacf21
This site embeds PDFium (BSD-3-Clause, https://pdfium.googlesource.com/pdfium/).
