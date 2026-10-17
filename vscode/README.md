# Manuscript Review for VS Code

Review manuscripts in the normal VS Code source editor, with source comments,
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

## Write

Open **Manuscript Review** from the activity bar, or run **Open manuscript** from the
Command Palette. The sidebar starts in **Write** and resumes the latest review for
that editing folder. Your manuscript stays in its normal source editor, with native
Save, Undo, syntax highlighting, and LaTeX Workshop compilation.

Select source text and press **⌘/Ctrl+Shift+M** to comment. With no selection, the
comment covers the current line. The sidebar lists open comments; click one to visit
its source and read its responses. The arrows or **⌘/Ctrl+Alt+[ / ]** step through
unresolved comments. The native Comments view and **Comment navigation → All** also
include resolved threads.

Write a comment in the sidebar. **Enter** or **Send** dispatches it to the selected
Codex or Claude Code CLI; **⌘/Ctrl+Enter** or **Save** saves it without dispatch.
**Shift+Enter** adds a line. Choose the provider and model beside the input, or expand
**Agent and comments**. [Install and sign in to the CLI](../docs/INSTALL.md#agent-clis)
first. Agent transcripts stay with the provider; the comment receives its final response.
**Agent sessions** reopens a provider session or its launch log.

Agents work in separate proposal checkouts while you continue writing. Clean results
join saved source through native, undoable edits; dirty buffers wait for Save. The
sidebar offers **Review N changes** when wording awaits a decision. Incoming results
refresh comments and that count while keeping Write active and preserving editor focus.
Overlapping changes retain both versions for review.

Your saves in Write advance the author side of an agent comparison. Accepted and
rejected choices, comments, and the original baseline remain available. Explicit Git
comparisons retain their chosen starting version. The editing activity is pinned when
typing starts, so changing activities before Save does not reclassify an unfinished edit.

**Resolve comment** settles a discussion; **Reopen comment** returns it to the queue.
Wording decisions and thread resolution are independent. **Source comments** in
**Agent and comments** controls new-comment actions; saved threads remain available.

## Review

Choose **Review N changes**, the sidebar's **Review** activity, or **Review manuscript**
in the source toolbar. Review uses the same manuscript and saved decisions. Its
sidebar shows **From**, **To**, and **PDF**, with progress and comparison controls.
**Review changes** resumes keyboard review at the change under the cursor or the next
change in that file.

| Key | Action |
| --- | --- |
| A / S | Accept / reject and advance |
| D / F | Previous / next change |
| Shift+A / Shift+S | Accept / reject the passage |
| Ctrl+A / Ctrl+S | Accept / reject the file |
| C | Open the change's comment |
| U | Reset its decision |
| E / Escape | Return to Write |

The focused change is outlined and surrounding source is subdued. Clicking source
restores normal typing. **Deleted text** in **Display options** uses VS Code's native
inline diff, with struck-out deletions beside additions and native line wrapping.
The modified side is your actual manuscript. Your manual refinements are accepted;
unaffected decisions and comments remain. Accepting or rejecting clears the decided
change's markup and advances to the next pending change. **Reviewed changes** can
show decided markup again.

Choose **Write** or **Return to writing** in the source toolbar to restore the ordinary
editor at the same location and close the comparison PDF. The comparison, decisions,
and discussion remain saved. VS Code's inline diff preferences are restored without
replacing preferences you changed yourself. Reopening the workspace starts in Write.

Native decisions update clean saved source immediately through Undo. **Apply remaining
changes** appears only when every edit has a decision and files still need applying,
including new or deleted files. Save or discard unsaved manuscript buffers first.
Apply preserves Git HEAD and staging and refuses intervening source changes.

## Compare versions

**Compare manuscript versions** opens Review. Choose **From** and **To**, then
**Compare** to prepare that pair. Pickers group selected drafts, proposal history,
branches and tags, and commits; search by name, date, message, or hash. **Working files**
captures saved tracked files, including staged new files, without changing HEAD or
staging. The current review stays intact while another pair is staged. Returning to
Write discards staged comparison choices.

A selected draft used as **From** starts a follow-up round that preserves the original
baseline and discussion. A Git starting version establishes a new baseline. Manual
edits in a commit comparison refine B while A stays fixed. If B requires another
checkout, the review uses a separate Git worktree. **Open editing folder** opens it
for normal Git, terminals, and LaTeX work; the original checkout stays intact.

The folder name chooses another manuscript. **Browse review library** lists earlier
rounds by manuscript; **Import saved review** imports a saved record through the shared
engine. **Review saved source changes** captures external revisions as a new round.
**Fetch manuscript history** fetches without merging. **Clone manuscript from GitHub**
opens the cloned folder. A repository needs at least one commit and tracked source.

**Saved source drafts** opens a retained draft as an untitled editor copy or discards
it explicitly. Opening a copy retains both the saved draft and working file. New edits
use VS Code's normal unsaved buffers and recovery.

## PDF review

**PDF beside source** opens original and selected PDFs in the bundled LaTeX Workshop
viewer. Wide panes place them side by side; narrow panes stack them. Deletions use red,
additions use green, and both PDFs outline the selected edit and subdue its surroundings.
Review keys work in either PDF. **E/Escape** returns to writing.

PDF setup follows the active source's root hint or includes, and offers a root picker
when needed. **PDF** changes the rendering root without changing decisions. Compilation
runs in the background; unavailable word geometry uses a source-linked region or page.
An already open matching LaTeX Workshop PDF also follows saved source through SyncTeX.

If a source file was removed, its saved text opens read-only. Existing comments remain
accessible, and opening that text does not recreate the file.

The source versions, Save transitions, and recovery rules are described in
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
