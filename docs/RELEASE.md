# Manuscript Review 0.8.0

The first public release includes word-level manuscript comparisons, typeset LaTeX
previews with changed terms highlighted, keyboard review, whole-passage editing,
and saved comments with agent responses. Review rounds preserve an original baseline
so you can inspect both the latest pass and accumulated changes.

Download the app ZIP, unzip it, and move the app to **Applications**.
The app includes its Python runtime and agent skill. Follow the repository's
[installation guide](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md)
to install Git, optional LaTeX preview tools, and the skill for Codex or Claude Code.

This build supports Apple Silicon Macs on macOS 13 or later. It is locally signed
and has not been notarized. macOS and Linux users can also run the browser interface
from source with Python 3.12 or later.

Existing schema-5 review libraries need no migration from 0.7.0. Reviews and manuscript
files stay outside the app bundle, so replacing the app preserves them.
