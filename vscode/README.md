# Manuscript Review for VS Code

Review manuscripts in the normal VS Code source editor, with native comments,
focused word comparisons, and highlighted PDF review. This is the primary interface
and the target for production releases. The extension includes its review engine,
LaTeX Workshop comparison viewer, and agent skill; the standalone app is optional.
The current package is a preview.

## Install

Build the current preview using the [commands below](#build), then install
the VSIX in `dist/` through **Extensions → Install from VSIX…** and open your
manuscript folder. The workspace host needs macOS or Linux, Git, and Python 3.12 or
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
buttons, or open **Manuscript Review** from the left activity bar. Its sidebar offers
one Review button and a Compare versions link. Library is in its title bar; Setup
and saved-source review are in its menu. With no folder open, choose Open manuscript folder or Clone
from GitHub.

Choose a saved round; a repository with no reviews opens for annotation. The toolbar
button opens focused review beside the source. **Open manuscript review** from the
command palette keeps an unchanged manuscript in the source editor; **Focus review**
opens the comparison when needed. The round label
opens the history picker for that manuscript. **Browse review library** groups saved
rounds by manuscript.
**Import saved review** imports a `review.json` through the shared record operations.

**Compare versions** shows **From**, **To**, the manuscript folder, and the PDF document
together. Choose **Review changes** to use that pair, or select a row to change it.
Version pickers group review drafts, branches and tags, and commits; search by name,
message, date, or hash. Back or Escape returns to the comparison without losing
the other choices. The active source file determines the manuscript folder;
**Folder** also lets you choose another workspace folder or local directory.

**From** is the starting wording; **To** is the proposed wording. **Working files**
captures saved tracked files, including staged new files, as a fixed snapshot.
Choosing a **selected draft** for **From** starts a new round with its decisions, original baseline,
and discussion preserved. Choosing a Git version starts a fresh comparison whose
baseline is that version. Both versions remain visible above the focused review;
hover to inspect their exact hashes, or click to choose another comparison.
**This round** compares the starting and proposed drafts; **Since baseline** compares
the original baseline with your current selected wording.

**PDF document** selects the LaTeX entry file; choose **Source only** to skip compilation.
**Fetch latest commits** updates available history without moving the selected versions
or changing your working files. For a GitHub manuscript, run **Clone manuscript from
GitHub**, choose a parent directory, then open a review in the cloned folder.
A manuscript repository needs at least one commit and tracked source files.

## Edit and discuss

Select source text and run **Comment on selection** (⌘/Ctrl+Shift+M), or use the editor
context menu. With no selection, the comment covers the current line. Responses and
follow-ups stay together in VS Code's Comments view. **Resolve comment** closes a thread;
**Reopen comment** returns it to the queue. Resolved threads collapse and retain their
messages across revisions. **Previous comment** and **Next comment** (⌘/Ctrl+Alt+[ / ])
visit unresolved threads across files; **Manuscript Review: Comment navigation → All** in the Command Palette includes resolved
threads. The Comments view also provides its native resolved/unresolved filter. Comment shortcuts apply
while a review is open and the source editor has focus; remap them in Keyboard Shortcuts.

Clicking proposed text in the focused review opens the source file at the change.
Focused review shows the exact word changes with faded surrounding context. Click
that context to expand the passage; click the source editor to restore the full file’s
visibility for editing.
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

Accept/reject selects wording. Resolve/reopen settles a discussion. These actions are
independent: accepting an edit or receiving a response leaves its thread status intact.
The focused review’s **Unresolved / All** filter and **Resolve / Reopen** controls use
the same thread state as native comments.

## Work with an agent

Press **Enter** in a comment to save it and open your selected agent’s task tab;
**Shift+Enter** adds a newline. Choose Codex or Claude Code from the chooser beside
Send, or the arrow in a native comment’s toolbar. The choice is remembered.
**Add comment** saves a native comment without dispatching it. **Send to agent**
also works on a saved comment.

If another extension captures these keys in Markdown comment editors, add the scoped
Enter and Shift+Enter bindings from this extension’s `package.json` to your user
keyboard shortcuts. They apply only to Manuscript Review comments.

Install the agent’s VS Code extension, finish its introduction, and sign in first. The macOS preview includes
automatic sending through Accessibility: the helper verifies the new native tab’s
complete request and presses its Send button once.
Enable **Visual Studio Code** in **System Settings → Privacy
& Security → Accessibility** (called **Device Control and Data Access** on newer
macOS versions). After confirmed submission, focus returns to your
manuscript or review while the agent works beside it. Without that permission, or
on other platforms and remote workspaces, Claude opens with the request prepared;
Codex opens a fresh tab with the request copied for you to paste and send.

Each task receives one saved comment,
its review, and the bundled command launcher. It appends only its final response to
the discussion; its working conversation stays in the agent tab.

Revision passes follow the manuscript repository’s branch and commit conventions,
run its build checks, and publish a diff against the version reviewed before the pass.
Responses identify that revision. The author reviews the wording and resolves settled
threads. Ordinary Git commits and PRs can supply the comparison versions; the app
retains its annotations and decisions without changing Git HEAD or staging.

With pending review decisions or unsaved source, the task thinks through the comment
and replies without editing files. Once decisions are complete, it can make surgical
changes and publish a new review round. Applying decisions remains an author action.

**Copy agent request** still prepares a request for your preferred external chat.
The skill reads comments and earlier
responses, makes the requested surgical changes, publishes a new round, and appends
replies. Existing prose is settled wording; a style guide alone does not authorize
rewriting it. Agent conversations stay in your agent's interface.

**Reload review** refreshes comments after replies. **Open manuscript review** selects
a new round; the agent can also return a link of the form
`vscode://njwfish.manuscript-review/review/REVIEW_ID` to open it directly. **This round**
shows the latest pass and **Since baseline** shows accumulated selected changes.
Replies without source changes stay in the same round.

## Build

Build on macOS with Xcode Command Line Tools to include the universal native sending
helper. Builds on other platforms retain manual submission in the agent tab.

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
