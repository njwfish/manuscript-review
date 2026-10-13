Manuscript Review 0.18.2 includes VS Code extension 0.4.2 and the standalone macOS app.

Focused navigation reuses word highlights and hovers. Only focus shading changes,
using a few continuous ranges shared across split editors. Unchanged comment
projections use native document versions without rereading whole buffers.

Delayed sidebar loads preserve newly staged comparisons. Unfinished comment replies
stay with their original review round, even when a later round carries the same
discussion. Cancelling a comment edit restores current saved wording; successful
saves remain visible when source typing interrupts the anchor refresh.

The VS Code runtime exposes only the operations used by its native editor and PDF.
Retired review-tab export routes and asset modes have been removed.

Review records, earlier decisions, comments, replies and manuscript files are preserved.
