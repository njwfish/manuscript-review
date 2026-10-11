Manuscript Review 0.14.10 includes the standalone macOS app and VS Code extension 0.1.17, built from the same commit. Both interfaces and the shared engine are maintained on `main`.

This release keeps a paragraph comment's native gutter icon on the blank line immediately following its selected text. VS Code repeats whole-line icons on soft-wrapped rows; a paragraph break gives the comment one marker. Saved source anchors remain exact, and navigation and replies use the original selection. Comments without a following paragraph break retain their existing placement.

Review records, decisions, discussions, and manuscript files need no migration or rewriting. The native comment thread and its unfinished inputs remain intact across refreshes.

Download the app ZIP for Apple Silicon macOS 13 or later, or install the `.vsix` through **Extensions → Install from VSIX…**. The extension runs independently on macOS and Linux with Git and Python 3.12 or later. [Installation](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md) covers prerequisites and agent skill setup; the [VS Code guide](https://github.com/njwfish/manuscript-review/blob/main/vscode/README.md) and [standalone guide](https://github.com/njwfish/manuscript-review/blob/main/README.md#review-in-the-standalone-app) describe the review cycle. Reload VS Code after updating. **Setup and agent skill** refreshes the bundled instructions and command launcher.

Reviews from 0.14.2 or newer need no format migration. For older libraries, close review windows and run the bundled agent command with `migrate` before reopening. The migration preserves decisions, comments, replies, source versions, and drafts, retains original records, and leaves manuscript files unchanged. [Upgrade instructions](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md#upgrade-an-existing-library) cover both installations.

The macOS app includes Python and is locally signed, without notarization. LaTeX and Poppler are optional for typeset and PDF previews. The browser interface runs from source on macOS and Linux. Review state stays in the local library; replacing either package preserves it.
