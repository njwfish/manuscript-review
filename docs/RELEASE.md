Manuscript Review 0.18.3 includes VS Code extension 0.4.3 and the standalone macOS app.

Native review outlines the active change and dims surrounding text. Its source controls
show Accept A, Reject S, Previous D, Next F, Comment C and Edit E. Original wording
appears in an exact monospace hover, keeping source line breaks and wrapping intact.

Accepting or rejecting clears that change's markup and advances to the next pending
edit. Reviewed highlights remain available through the Command Palette. The selected
PDF uses the same display preference.

Comment C opens editable native input, including follow-ups. Enter saves and dispatches;
Shift+Enter adds a newline. Review shortcuts do not intercept comment typing. Failed
comment saves restore editable input. Native tests load the extension's real contributions
and check comment focus, submission, source delivery, decisions, Undo and PDF rendering.

Navigation reuses validated source spans and cached highlights. Native typing leaves
keyboard review, while exact delivery-owned edits retain it. There is no separate
text review tab.

Review records, earlier decisions, comments, replies and manuscript files are preserved.
