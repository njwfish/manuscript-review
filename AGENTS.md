# Manuscript Review

VS Code is the primary product and the target for production releases. Its extension
must support the complete review cycle without installing or running the standalone
app. Both interfaces use the same local review engine and records. Keep the interface
focused on source comparisons, decisions, and comments with responses. Agent
conversations take place outside the app.

Keep manuscript content dominant and use familiar macOS controls. Group metadata
with spacing and alignment, without middle-dot or bullet separators. Avoid decorative
badges, emoji, gradients, nested cards, and generic helper copy. Use color for source
changes, focus, actions, and status.

Use monospace for all raw manuscript text and source editing, including LaTeX prose
and inline math. Typeset previews retain the manuscript's own typography.

Read ARCHITECTURE.md before changing review persistence or source writes. Use the
same ReviewSession and Library operations from the UI and agent commands. Preserve
earlier rounds, the fixed baseline, author choices, drafts, and discussion.

Use plain values and small functions. Keep one runtime record format; retired records
belong in explicit migrations that retain their original bytes. Avoid repository-specific
paths, compatibility layers, and abstractions without a concrete caller.

Run `.venv/bin/python -m unittest discover -s tests -v` after functional changes.
Check packaged startup and actual LaTeX rendering when changing those boundaries.
Use an isolated library for write tests. Never use a person's saved review as a fixture.

The agent skill is in `skills/manuscript-review/`. It is bundled with both interfaces;
keep its commands and references portable. Follow the author's manuscript instructions
when using the tool to revise prose.
