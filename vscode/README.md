# Manuscript Review for VS Code

Review manuscripts in the normal VS Code source editor, with native comments,
focused word comparisons, and highlighted PDF review. This is the primary interface
and the target for production releases. The extension includes its review engine,
LaTeX Workshop comparison viewer, and agent skill; the standalone app is optional.
The current package is a preview.

## Install

Download the `.vsix` from the [latest release](https://github.com/njwfish/manuscript-review/releases/latest),
install it through **Extensions → Install from VSIX…**, and open your manuscript
folder in VS Code 1.114 or later. You can also [build the package](#build) from the
shared `main` branch. The workspace host needs macOS or Linux, Git, and Python 3.12 or
newer. The extension finds a supported interpreter automatically, including Homebrew Python
when an older Conda environment comes first on the path. **Manuscript Review: Python
Path** selects a specific interpreter.
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

Click **Review manuscript** in the source editor's toolbar, beside the LaTeX Workshop
buttons, or open **Manuscript Review** from the left activity bar. Its sidebar keeps **From**, **To**, and **PDF** visible, with review progress and
**Apply review** when every edit has a decision. **Source comments** toggles the editor
comment controls. Library is in the title bar; Setup and saved-source review are in its menu. With no folder open, choose a manuscript folder or clone from GitHub.

Choose a saved round; a repository with no reviews opens for annotation. The toolbar
button opens focused review beside the source. **Open manuscript review** from the
command palette keeps an unchanged manuscript in the source editor; **Focus review**
opens the comparison when needed. The round label
opens the history picker for that manuscript. **Browse review library** groups saved
rounds by manuscript.
**Import saved review** imports a `review.json` through the shared record operations.

**Compare versions** opens this sidebar. Click **From**, **To**, or **PDF** to change
a field, then choose **Review changes** to open that pair. The current review and its
decisions stay intact while you choose another comparison.
Version pickers group review drafts, branches and tags, and commits; search by name,
message, date, or hash. Escape closes a picker without changing the other fields. The initial manuscript folder comes from the active source file.
The folder name also lets you choose another workspace folder or local directory.

**From** is the starting wording; **To** is the proposed wording. **Working files**
captures saved tracked files, including staged new files, as a fixed snapshot.
Choosing a **selected draft** for **From** starts a new round with its decisions, original baseline,
and discussion preserved. Choosing a Git version starts a fresh comparison whose
baseline is that version. Both versions remain visible above the focused review;
hover to inspect their exact hashes, or click to choose another comparison.
**This round** compares the starting and proposed drafts; **Since baseline** compares
the original baseline with your current selected wording.

**PDF document** selects the LaTeX entry file; choose **Source only** to skip compilation.
**Fetch manuscript history** updates available history without changing your working
files. For a GitHub manuscript, run **Clone manuscript from
GitHub**, choose a parent directory, then open a review in the cloned folder.
A manuscript repository needs at least one commit and tracked source files.

## Edit and discuss

Source comments are on by default for `.tex`, `.bib`, `.md`, `.txt`, `.typ`, and `.rst`
files. You can comment before opening a comparison; the first comment opens its
manuscript quietly in the background. Existing comments resume when their source
folder is opened. Turn **Source comments** off in the sidebar to hide new-comment
controls; saved threads and replies remain.

Select source text and run **Comment on selection** (⌘/Ctrl+Shift+M), or use the editor
context menu or the comment gutter. With no selection, the comment covers the current line. Responses and
follow-ups stay together in VS Code's Comments view. **Resolve comment** closes a thread;
**Reopen comment** returns it to the queue. Resolved threads collapse and retain their
messages across revisions. **Previous comment** and **Next comment** (⌘/Ctrl+Alt+[ / ])
visit unresolved threads across files; **Manuscript Review: Comment navigation → All** in the Command Palette includes resolved
threads. The Comments view also provides its native resolved/unresolved filter. New-comment shortcuts require source comments to be on; navigation stays available
for saved threads. These shortcuts require source editor focus and can be remapped in Keyboard Shortcuts.

Clicking proposed text in the focused review opens the source file at the change.
Focused review shows the exact word changes with faded surrounding context. Click
that context to expand the passage; click the source editor to restore the full file’s
visibility for editing.
Source remains a normal VS Code document with saving, undo, syntax highlighting, and
LaTeX Workshop compilation. Change backgrounds and hovers show replacements against
the exact current editor buffer.

If a reviewed file has been removed or moved, its saved source opens in a read-only
editor. Existing comments remain accessible there. Opening saved source never
restores a deleted file; an already open source buffer retains your unsaved text.

Saving a native source edit refreshes the current comparison automatically. **From**
stays at A; **To** becomes B plus your local edits. New manual edits are accepted,
unaffected choices remain, and comments on revised edits move into discussion.
The original baseline stays fixed. Parallel agent revisions join the current proposal
through the bundled skill; **Compare saved changes** captures edits made outside this editor.

Source editing uses B’s checkout. If the open folder contains another version or
unrelated changes, the review creates a separate Git worktree containing its selected
draft. **Open editing folder** in Review tools opens that source as a normal VS Code
folder for Git, terminals, and LaTeX Workshop. Your original checkout stays intact;
create a branch in the editing folder when you want to commit or publish its changes.

**Saved source drafts** opens retained drafts from the shared library as untitled editor
copies, or discards them explicitly. Opening a copy keeps the saved draft and working
file intact. Keep the recovery copy open, discard the retained draft, then save the
copy to the intended source file. New source edits use VS Code's normal unsaved buffers
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

Accept/reject selects wording. Resolve/reopen settles a discussion. These actions are
independent: accepting an edit or receiving a response leaves its thread status intact.
The focused review’s **Unresolved / All** filter and **Resolve / Reopen** controls use
the same thread state as native comments.

## Work with an agent

Press **Enter** in a comment to save it and dispatch it through the selected agent's
CLI; **Shift+Enter** adds a newline. Choose Codex or Claude Code beside Send, or from
the arrow in a native comment's toolbar. The choice is remembered. **Add comment**
saves without dispatching; **Send to agent** also works on a saved comment.

[Install and sign in to the CLI](../docs/INSTALL.md#agent-clis) first. No provider tab
opens and focus stays in your manuscript. Several agents can work while you continue
editing or reviewing. Each receives one saved discussion, earlier replies, and the
bundled command launcher. Working transcripts stay with the provider; only the final
response is appended to the discussion. Launch details are in the Manuscript Review
Output channel and the library's `agent-output/` directory.

For source changes, the agent starts a separate proposal checkout with
`begin --parallel`, follows the manuscript's Git workflow and build checks, then
publishes with `finish --workspace`. Clean changes join the current comparison as
undecided edits against its fixed base, preserving your choices, drafts, discussion,
and other agent results. Different words in the same paragraph can merge;
overlapping changes require reconciliation in a fresh proposal. Your source files
and buffers remain untouched until **Apply**. Pending decisions and unsaved source
do not block agent revisions. The author reviews wording and resolves settled threads.

**Copy agent request** prepares the same workflow for your external chat. An idle
focused review refreshes returned changes and replies automatically; active input is
retained with **Reload review** available. **This round** compares the accumulated
proposal to its fixed base; **Since baseline** includes selected changes across earlier
rounds. An explicitly requested separate revision pass can still create a new round.

**Review highlights** in the sidebar turns diff highlighting and surrounding dimming
off or on, independently of **Source comments**. Existing comments remain available.

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
