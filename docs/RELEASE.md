Click proposed text or a proposed LaTeX preview to edit the full file at that passage. The monospace editor occupies the review surface, with change highlights, undo/redo, find, and discussion in a collapsible sidebar. Save writes only manual changes and refreshes the word diff; unrelated decisions and discussion survive. Escape retains a file draft.

**Existing version 0.10 libraries need an explicit format upgrade.** Quit the app, replace it, then run:

```sh
"/Applications/Manuscript Review.app/Contents/MacOS/manuscript-review-agent" migrate
```

The command retains choices, comments, replies, source versions, and unfinished drafts, and archives the original records. It does not edit manuscript files. See the [upgrade instructions](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md#upgrade-an-existing-library) for source installations and separate libraries.

Download the ZIP and move the app to **Applications**. The app supports Apple Silicon Macs on macOS 13 or later. It is locally signed and has not been notarized. The browser interface runs from source on macOS and Linux with Git and Python 3.12 or later. CodeMirror and its licenses are bundled; no editor assets load from the internet.
