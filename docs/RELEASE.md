Focused source review now uses VS Code’s native inline diff, with wrapped word changes and struck-out deletions beside additions. The optional PDF view shows both manuscript versions and follows the selected change.

- One source tab with keyboard controls; decisions clear markup while typing edits the actual file.
- No forced Original/Proposed popup. Deleted text can be toggled in Display options.
- Original and proposed PDFs use red and green change marks and focus on the selected passage. Narrow panes stack the PDFs; wide panes show them side by side.
- PDF setup follows the active source’s LaTeX root, replacing stale document choices. Unresolved includes retain a root picker.
- Source view transitions and PDF load retries retain the current comparison and focus. Navigation reuses cached PDF bytes.

Saved reviews, choices, comments, and manuscript files retain their existing format. After updating, save your work and run Developer: Reload Window.
