# Manuscript Review for VS Code

This preview brings Manuscript Review into the normal VS Code source editor. Native
comments retain the same notes and responses as the standalone app. **Focus review**
opens its word-level comparison beside your source; **PDF** uses an adapted LaTeX
Workshop viewer with the selected change highlighted on the original and proposed PDFs.

## Try the preview

Install the `.vsix` through **Extensions → Install from VSIX…**, then open your
manuscript folder. You need Git and Python 3.12 or newer on the machine hosting the
workspace. Set **Manuscript Review: Python Path** if `python3` is not that interpreter.
PDF previews also need `latexmk`, `pdflatex`, and Poppler (`pdftocairo`, `pdftotext`,
`pdfinfo`). The extension starts its local service only when you open a review.

Run **Manuscript Review: Open manuscript review** from the command palette. Choose
the current or an earlier saved review, or open the current manuscript for annotation.
By default it shares the standalone app's library. A separate library can be selected
in **Manuscript Review: Library Directory**.

Select source text and run **Comment on selection** (⌘/Ctrl+Shift+M), or use the editor
context menu. With no selection, the comment covers the current line. Responses and
follow-ups remain together in VS Code's Comments view. **Previous comment** and **Next
comment** (⌘/Ctrl+Shift+[ / ]) move through them across files. Comment shortcuts apply
only while a review is open and the source editor has focus; they can be remapped in
Keyboard Shortcuts.

**Focus review** uses the app's A/S decisions and D/F navigation without binding those
letters in the source editor. Clicking proposed source opens the real file at the
change. Source remains a normal VS Code document: saving, undo, syntax highlighting,
and LaTeX Workshop compilation retain their usual behavior. Source change backgrounds
and hovers show reviewed replacements against the exact current editor buffer.

After saving manual source changes, run **Review saved source changes**. This creates
a new round against the preceding selected draft and retains the original baseline and
discussion. Unsaved source buffers must be saved first. **Reload review** refreshes
comments and comparisons after an agent prepares a round or responds; **Open manuscript
review** selects the new round. **Since baseline** shows accumulated selected changes.

This preview saves decisions and comments from its focused panel. Apply the completed
review in the standalone app before asking an agent to revise selected wording. Use
the same installed [manuscript-review agent skill](https://github.com/njwfish/manuscript-review/blob/main/skills/manuscript-review/SKILL.md)
and **Copy agent request**. Agent chats stay in your agent's interface; the review keeps
comments and responses. Standalone file drafts stay in the app. Save or discard them
there before changing decisions in that file or starting another round.

**Show location in LaTeX Workshop PDF** uses the installed Workshop extension's
ordinary SyncTeX navigation for your live source. The review viewer displays immutable
comparison PDFs; it does not replace Workshop's compiler or its live PDF view.

## Build

From this repository's `vscode/` directory:

```sh
npm ci
npm test
npm run package
```

The VSIX is written under `dist/`. The build bundles the same Python review engine and
frontend as the standalone app; Python is a local prerequisite rather than a copied
interpreter. No Marketplace publication or VS Code settings changes are required.
The viewer's pinned upstream sources and license notices are documented in
`viewer/UPSTREAM.json`. This is an early integration preview; interactive VS Code testing
and visual polish remain necessary before a stable release.
