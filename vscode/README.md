# Manuscript Review for VS Code

Review manuscripts in the normal VS Code source editor, with native comments,
focused word comparisons, and highlighted PDF review. This is the primary interface
and the target for production releases. The extension includes its review engine,
LaTeX Workshop comparison viewer, and agent skill; the standalone app is optional.
The current package is a preview pending native interface verification.

## Install

Build the current preview using the [commands below](#build), then install
`dist/manuscript-review-0.1.2.vsix` through **Extensions → Install from VSIX…** and open your
manuscript folder. The workspace host needs macOS or Linux, Git, and Python 3.12 or
newer. Set **Manuscript Review: Python Path** if `python3` is not that interpreter.
LaTeX previews also need `latexmk`, `pdflatex`, and Poppler (`pdftocairo`, `pdftotext`,
`pdfinfo`). Word review works without the PDF tools.

Run **Manuscript Review: Setup and agent skill** to check prerequisites and install
its bundled skill for Codex or Claude Code. The installer preserves existing personal
skills. Extension updates retain the installed command engine and refresh its stable
skill directory. Start a new agent session after installing the skill.
Setup also offers **Copy agent command** for direct CLI use. To migrate an older
library, copy that command, close the review interfaces, then paste it into a terminal
and append `migrate`, or `--home /absolute/path/to/library migrate` for another library.
Setup prepares these commands even when the library cannot open.

The extension starts its local service on demand. Reviews live in a separate user
library, shared with the standalone interface when installed. Set **Manuscript Review:
Library Directory** to use another library. Updating the extension preserves reviews.

## Open and compare

Run **Open manuscript review** from the command palette. Choose a saved round; a
repository with no reviews opens for annotation. An unchanged manuscript stays in the
source editor. **Focus review** opens the comparison beside it, and the round label
opens the history picker for that manuscript. **Browse review library** groups saved
rounds by manuscript.
**Import saved review** imports a `review.json` through the shared record operations.

**Compare manuscript versions** lets you choose a starting and proposed version from
Git commits, branches, tags, and saved review checkpoints. **Working files** uses saved
tracked source. For a GitHub manuscript, run **Clone manuscript from GitHub**, choose
a parent directory, then open a review in the cloned folder. **Fetch manuscript history**
updates remote history and opens the version picker without merging into your files.
A manuscript repository needs at least one commit and tracked source files.

## Edit and discuss

Select source text and run **Comment on selection** (⌘/Ctrl+Shift+M), or use the editor
context menu. With no selection, the comment covers the current line. Responses and
follow-ups stay together in VS Code's Comments view. **Previous comment** and **Next
comment** (⌘/Ctrl+Alt+[ / ]) move through them across files. Comment shortcuts apply
while a review is open and the source editor has focus; remap them in Keyboard Shortcuts.

Clicking proposed text in the focused review opens the source file at the change.
Source remains a normal VS Code document with saving, undo, syntax highlighting, and
LaTeX Workshop compilation. Change backgrounds and hovers show replacements against
the exact current editor buffer.

After saving manual edits, use **Compare saved changes** in Review tools, or **Review
saved source changes** from the command palette. This creates a round against the
preceding selected draft and retains the original baseline and discussion. **Since
baseline** shows accumulated selected changes. A source-changing round must contain
a reviewable diff.

**Saved source drafts** opens retained drafts from the shared library as untitled editor
copies, or discards them explicitly. Opening a copy keeps the saved draft and working
file intact. Save the copy to the intended source file, then discard its retained draft
before comparing or applying. New source edits use VS Code's normal unsaved buffers
and recovery behavior.

## Review and apply

In **Focus review**, use **A / S** to accept or reject and advance, **D / F** to move
backward or forward, and **Shift+A / S** for passage decisions. **Ctrl+A / S** applies
a decision to the file. These shortcuts apply within the review panel; source editing
keeps its normal keys. Comments save automatically.

**PDF** shows the original and proposed pages using the bundled LaTeX Workshop viewer,
with the selected change highlighted. Moving through edits retains zoom and the loaded
PDF. PDF panes retain selection, search, and copy shortcuts; whole-file decisions and
Apply use the review panel. **Show location in LaTeX Workshop PDF** uses the installed
Workshop extension's SyncTeX for live source. Its compiler and live viewer remain the
usual Workshop tools.

When the review is complete, **Apply review** writes the selected wording to your files.
Save or discard unsaved manuscript buffers first. Apply preserves Git HEAD and staging
and refuses intervening source changes. Review tools also contain patch and feedback
exports, response imports, version comparison, the library, drafts, and setup.

## Work with an agent

Use **Copy agent request** and paste it into your agent's chat. The prompt identifies
the exact review and its bundled command launcher. The skill reads comments and earlier
responses, makes the requested surgical changes, publishes a new round, and appends
replies. Existing prose is settled wording; a style guide alone does not authorize
rewriting it. Agent conversations stay in your agent's interface.

**Reload review** refreshes comments after replies. **Open manuscript review** selects
a new round; the agent can also return a link of the form
`vscode://njwfish.manuscript-review/review/REVIEW_ID` to open it directly. **This round**
shows the latest pass and **Since baseline** shows accumulated selected changes.
Replies without source changes stay in the same round.

## Build

From this repository's `vscode/` directory:

```sh
npm ci
npm test
npm run package
```

The VSIX is written under `dist/`. The build includes the shared Python engine,
comparison interface, viewer, skill, and commands. Python is a local prerequisite;
the engine has no third-party Python dependencies. No standalone app installation is
required. The viewer's pinned upstream sources and license notices are documented in
`viewer/UPSTREAM.json`.
