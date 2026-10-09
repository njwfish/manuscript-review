# PDF review viewer

The viewer starts from LaTeX Workshop 10.19.0, commit
`52f8c9e87b710d17293c4e150a7378ebc9cb801e`. `UPSTREAM.json` records original
file hashes. Its PDF.js viewer, styling, icons, and translations are retained.
The HTML loads our small review bridge in place of Workshop's WebSocket client.
Review highlights are display overlays and do not modify PDF annotations.

Run `node src/build-viewer.mjs` from the extension directory. The build copies
the pinned PDF.js 6.2.108 engine, worker, fonts, CMaps, codecs, and their notices
into `dist/viewer`. `buildViewer(destination)` also accepts the shared webview
asset directory as a destination. Retain the license files and resource notices
when distributing the viewer.

Embed `viewer.html` through `webview.asWebviewUri`. Add the exact parent window
origin as its `parentOrigin` query parameter. After `review-pdf-ready`, send
`review-pdf` with PDF bytes in `data`, a stable asset name in `document`,
normalized page bounds in `marks`, `color` (`added` or `removed`), and
`active` (whether to scroll to the selection). Bounds use the PDF's original
displayed orientation. Later updates for the same document can omit its bytes.

The bridge accepts messages only from that parent window and origin. Viewer
errors return as `review-pdf-error`. Focused review shortcuts return as
`review-pdf-key` with `key` and `shiftKey`; typing in PDF search and ordinary
modified PDF shortcuts stay in the viewer. Ordinary working-PDF SyncTeX continues to
use the installed LaTeX Workshop extension; this historical viewer does not
implement a second SyncTeX service.
