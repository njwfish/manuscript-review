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
button starts focused review in the source editor. No separate text review tab opens.
**Open manuscript review** from the Command Palette selects the manuscript, and
**Focus review in editor** starts keyboard review. **Browse review library** groups
saved rounds by manuscript. **Import saved review** imports a `review.json` through
the shared record operations.

**Compare versions** opens this sidebar. Click **From**, **To**, or **PDF** to change
a field, then choose **Compare** to open that pair and its proposal source. The current review and its
decisions stay intact while you choose another comparison.
Source highlights clear until you open the chosen comparison.
Version pickers group review drafts, branches and tags, and commits; search by name,
message, date, or hash. Escape closes a picker without changing the other fields. The initial manuscript folder comes from the active source file.
The folder name also lets you choose another workspace folder or local directory.

**From** is the starting wording; **To** is the proposed wording. **Working files**
captures saved tracked files, including staged new files, as a fixed snapshot.
Choosing a **selected draft** for **From** starts a new round with its decisions, original baseline,
and discussion preserved. Choosing a Git version starts a fresh comparison whose
baseline is that version. The sidebar shows both endpoints; hover to inspect their
exact hashes, or click to choose another comparison. Select an earlier draft or the
original Git baseline as **From** to inspect accumulated changes.

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
context menu or the comment button in the editor title. With no selection, the comment covers the current line. Responses and
follow-ups stay together in VS Code's Comments view. **Resolve comment** closes a thread;
**Reopen comment** returns it to the queue. Resolved threads collapse and retain their
messages across revisions. **Previous comment** and **Next comment** (⌘/Ctrl+Alt+[ / ])
visit unresolved threads across files; **Manuscript Review: Comment navigation → All** in the Command Palette includes resolved
threads. The Comments view also provides its native resolved/unresolved filter. New-comment shortcuts require source comments to be on; navigation stays available
for saved threads. These shortcuts require source editor focus and can be remapped in Keyboard Shortcuts.

The source editor drives the review. Focused review outlines the current change, dims surrounding
text, and shows **Accept A**, **Reject S**, **Previous D**, **Next F**, **Comment C**,
and **Edit E** above its source line. It starts at the change under your cursor, or
the next change in that file. Clicking ordinary source or pressing **E/Escape**
returns to typing. Clicking a highlighted change selects it. The review toolbar
button resumes keyboard review.

Source remains a normal VS Code document with saving, undo, syntax highlighting, and
LaTeX Workshop compilation. Change backgrounds show replacements against the exact current editor buffer.
**Original on focus** opens a hover with the exact original and proposed source in
monospace. You can also hover over a change yourself. Removed prose stays in the
hover so source wrapping and line breaks remain intact. Review decorations never
enter your file or Undo history.

If a reviewed file has been removed or moved, its saved source opens in a read-only
editor. Existing comments remain accessible there. Opening saved source never
restores a deleted file; an already open source buffer retains your unsaved text.

Saving a native source edit refreshes the current comparison automatically. With
**Edit: Proposal**, **From** stays at A and **To** becomes B plus your refinements.
With **Edit: Your draft**, ordinary drafting becomes the author side of an agent comparison.
The intent is pinned when typing starts, so changing that choice before Save cannot
reclassify an edit. New manual edits are accepted;
unaffected choices remain, and comments on revised edits move into discussion.
The original baseline stays fixed. Parallel agent revisions join the current proposal
through the bundled skill; **Review saved source changes** captures edits made outside this editor.

Source editing uses B’s checkout. If the open folder contains another version or
unrelated changes, the review creates a separate Git worktree containing its selected
draft. **Manuscript Review: Open editing folder** in the Command Palette opens that source as a normal VS Code
folder for Git, terminals, and LaTeX Workshop. Your original checkout stays intact;
create a branch in the editing folder when you want to commit or publish its changes.

**Saved source drafts** opens retained drafts from the shared library as untitled editor
copies, or discards them explicitly. Opening a copy keeps the saved draft and working
file intact. Keep the recovery copy open, discard the retained draft, then save the
copy to the intended source file. New source edits use VS Code's normal unsaved buffers
and recovery behavior.

## Review and apply

In focused source review, **A/S** accepts or rejects and advances, **D/F** moves
backward or forward, and **Shift+A/S** decides the passage. **Ctrl+A/S** decides the
file, **U** resets a decision, and **C** opens an editable native comment. **E/Escape** returns
to ordinary editing. Outside focus mode, **Ctrl+Alt+D/F** navigates highlighted edits.
**Exit review** in the editor title turns off highlights and review shortcuts.

**Open manuscript PDF** in the sidebar title opens the selected manuscript using the
bundled LaTeX Workshop viewer. It follows the selected edit and retains zoom and search.
The PDF shows your current selected wording, including rejections. While focused
review is active, the same decision and navigation keys work there; **E/Escape**
returns focus to source. An already open matching LaTeX Workshop PDF also follows
saved source through SyncTeX. Compilation runs in the background; unavailable exact
geometry falls back to the corresponding page.

Native decisions update clean saved source through undoable edits. Decided changes
become ordinary text and review advances to the next pending change. **Toggle reviewed
change highlights** in the Command Palette shows their markup again. **Apply review**
appears in the sidebar when every edit has a decision and files still need applying,
including new or deleted files. Save or discard unsaved manuscript buffers first.
Apply preserves Git HEAD and staging and refuses intervening source changes.

Accept/reject selects wording. Resolve/reopen settles a discussion independently.
Accepting an edit or receiving a response leaves its thread status intact.

## Work with an agent

Press **Enter** in a comment to save it and dispatch it through the selected agent's
CLI; **Shift+Enter** adds a newline. The sidebar chooses **Agent** (Codex or Claude
Code) and **Model**; **CLI default** uses that provider's own settings. The arrow in
a native comment toolbar also chooses the provider. Both choices are remembered. **Add comment**
saves without dispatching; **Send to agent** also works on a saved comment.

[Install and sign in to the CLI](../docs/INSTALL.md#agent-clis) first. No provider tab
opens and focus stays in your manuscript. Several agents can work while you continue
editing or reviewing. Each receives one saved discussion, earlier replies, and the
bundled command launcher. Working transcripts stay with the provider; only the final
response is appended to the discussion. Launch details are in the Manuscript Review
Output channel and the library's `agent-output/` directory. **Open agent session…**
in the sidebar reopens that conversation in its CLI or desktop app, or shows its launch log.

For source changes, the agent starts a separate proposal checkout with
`begin --parallel`, follows the manuscript's Git workflow and build checks, then
publishes with `finish --workspace`. Clean changes join the current comparison as
undecided edits, preserving your choices, drafts, discussion, and other agent results.
Sending from native source starts one **Your saved draft →
Agent changes** comparison. Clean results join saved source through native undoable
edits. Dirty buffers wait for your next Save. Your own saves update the author side,
so the diff contains agent changes; the original baseline and archived comparisons
remain available. **Agent changes** in the sidebar also brings existing results into
this workflow. Clean results can join source while focused review is active. Overlapping author and agent wording stays visible for review; neither
version is lost. New or deleted files use explicit Apply. Pending decisions and unsaved source
do not block agent revisions. The author reviews wording and resolves settled threads.

Returned changes and replies refresh native source and comments automatically.
Unsaved source stays in its native buffer. An explicitly requested separate revision
pass can still create a new round.

**Review highlights** in the sidebar turns diff highlighting and surrounding dimming
off or on, independently of editing intent and **Source comments**. Automatic delivery
reveals changes without changing **Edit**. Opening focused review selects **Proposal**.
Existing comments remain available.

The source versions, Save transitions and recovery rules are documented in
[Editing model](../docs/EDITING.md).

## Build

From this repository's `vscode/` directory:

```sh
npm ci
npm test
npm run package
```

The VSIX is written under `dist/`. The build includes the shared Python engine,
native controls, PDF viewer, skill, and commands. Python is a local prerequisite;
the engine has no third-party Python dependencies. No standalone app installation is
required. The viewer's pinned upstream sources and license notices are documented in
`viewer/UPSTREAM.json`.
