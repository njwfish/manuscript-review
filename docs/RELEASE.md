Manuscript Review 0.18.0 includes VS Code extension 0.4.0 and the standalone macOS app.

The native source editor now drives review. Opening a review no longer creates a
separate text comparison tab. Inline Accept, Reject and Comment controls, cached
navigation, and focused A/S/D/F shortcuts use the same source and selected wording.
Clicking source or pressing E/Escape returns to typing; Exit review turns highlights off.
Queued decisions cannot cross into another review, and editing cancels pending advance.

An optional PDF view follows the selected change and displays rejected wording too.
It retains PDF bytes and locations between selections, compiles in the background,
and delegates actions to the source editor. Selected PDF generation skips unused SVG
conversion. An already open matching LaTeX Workshop PDF follows saved source.

Review records, earlier decisions, comments, replies and manuscript files are preserved.
The standalone review interface remains available with the same engine and library.
