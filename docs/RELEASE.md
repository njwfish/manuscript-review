Saving a passage now writes only that passage, preserving the rest of the working
file and its review decisions. The word diff and discussion still update immediately.
This release also fixes passage saves that could stall in reviews opened from the Library.

**Library → Setup** checks Git and optional equation-preview tools and installs the
bundled skill for Codex or Claude Code. Existing skill paths are preserved. The macOS
app also opens Setup with **⌘+,**.

Review explanations now appear before decision controls. When every edit has a decision,
**Review complete** stands out in the header and the status line shows the apply shortcut.
Comparison and apply labels are consistent.

Quit the app before replacing it with this release. Existing schema-5 libraries need
no migration from 0.8.0; saved reviews and manuscripts stay outside the app bundle.
Download the app ZIP and move the app to **Applications**. See the
[installation guide](https://github.com/njwfish/manuscript-review/blob/main/docs/INSTALL.md).

The app supports Apple Silicon Macs on macOS 13 or later. It is locally signed and
has not been notarized. The browser interface runs from source on macOS and Linux
with Git and Python 3.12 or later.
