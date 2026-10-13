Manuscript Review 0.18.1 includes VS Code extension 0.4.1 and the standalone macOS app.

The native editor remains the sole text review surface, with an optional synchronized
PDF. This release removes the retired embedded review client, bridge, hidden controls
and message protocol. The standalone client uses the review service directly.

Cursor movement reuses validated source and the review index. Inline controls refresh
when their edit changes; unchanged focus modes do not repeat external updates.
Background editor events cannot cancel focused review, and leaving review cancels
navigation waiting for source capture. Decisions retain revision, source and save checks.

Standard LaTeX equation excerpts compile without requiring an extra math package.

Review records, earlier decisions, comments, replies and manuscript files are preserved.
