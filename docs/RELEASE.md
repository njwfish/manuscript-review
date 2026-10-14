The VS Code sidebar now provides a compact comment composer with readable feedback and responses beside the manuscript. The source remains the only text review editor.

- Quieter comparison fields, fewer persistent controls, and a prominent Apply review action when decisions are complete.
- One comment input for annotations, corrections, and follow-ups, with monospace text and automatic sizing.
- Enter sends to the selected agent; Cmd/Ctrl+Enter saves; Shift+Enter adds a line; Escape returns to the source.
- Drafts retain their identity and anchor through failed saves, review switches, and arriving responses. Stale actions cannot replace or submit a newer draft.
- A successful save closes its input before background refresh, preventing duplicate comments if that refresh fails.

The update preserves saved reviews, decisions, comments, and source files. After updating the VS Code extension, save your work and run Developer: Reload Window.
