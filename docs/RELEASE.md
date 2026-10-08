Step through manuscript comments with the sidebar arrows or **⌘/Ctrl+Shift+[ / ]**, including while editing. The selector jumps across files, and **View change** returns to the attached diff. Follow-ups remain one thread; comments on removed files stay readable in All feedback. Pending comments and drafts save before navigation.

The bundled agent skill can now ingest a referee report as comments anchored to exact source quotes before editing. Agents revise the manuscript in a new round and respond to those original comments, keeping the feedback and explanation beside the resulting changes. The optional feedback CSV stays with the manuscript project.

The source editor now uses restrained LaTeX syntax highlighting: commands and math delimiters in a muted blue, with comments and braces in gray. Review additions and deletions retain their green and red highlights.

**PDF pages** shows the original and proposed manuscript pages with the current edit highlighted. Prose can be highlighted at word level; equations and ambiguous text use their source-linked region. The exact source change remains below the pages. **D / F** moves through edits, **V** switches to word changes, and **PageUp / PageDown** scrolls the PDF panes. Zoom keeps the highlighted area visible.

Selecting text in the source editor reveals a small **Comment** button beside the selection. It opens the existing sidebar and preserves the selected quote. **⌘/Ctrl+Shift+M** still works.

Version 0.11 through 0.13 libraries use the same record format and require no migration.

Click proposed text or a proposed LaTeX preview to edit the full file at that passage. The monospace editor occupies the review surface, with change highlights, undo/redo, find, and discussion in a collapsible sidebar. Save writes only manual changes and refreshes the word diff; unrelated decisions and discussion survive. Escape retains a file draft.

**Existing version 0.10 libraries need an explicit format upgrade.** Quit the app, replace it, then run:

```sh
"/Applications/Manuscript Review.app/Contents/MacOS/manuscript-review-agent" migrate
```

The command retains choices, comments, replies, source versions, and unfinished drafts, and archives the original records. It does not edit manuscript files. See the [upgrade instructions](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md#upgrade-an-existing-library) for source installations and separate libraries.

Download the ZIP and move the app to **Applications**. The app supports Apple Silicon Macs on macOS 13 or later. It is locally signed and has not been notarized. The browser interface runs from source on macOS and Linux with Git and Python 3.12 or later. CodeMirror and its licenses are bundled; no editor assets load from the internet.
