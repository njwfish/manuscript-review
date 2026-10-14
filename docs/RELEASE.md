Manuscript Review 0.18.4 includes VS Code extension 0.4.4 and the standalone macOS app.

The sidebar now offers **PDF beside source**. It opens the selected manuscript's PDF
beside the native source editor, highlights the current change, and follows review
navigation. Reopening reuses the viewer while keeping source visible.

The **PDF** field changes the rendering root without changing the comparison, decisions,
or comments. A deleted or renamed root is replaced from the selected manuscript version
when opening PDF. Preview caches track the root in every comparison scope. Rendering
and service errors remain visible in the PDF panel.

This release also includes 0.4.3's native review fixes: normal source wrapping, visible
A/S/D/F/C/E controls, editable comments, active-word focus, and plain text after decisions.
There is no separate text review tab. Review records and manuscript files are preserved.

Save open edits and run **Developer: Reload Window** after installing to load the update.
