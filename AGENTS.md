# Manuscript Review

Keep the app local and the interface focused on source comparisons, decisions, and
comments with responses. Agent conversations take place outside the app.

Read ARCHITECTURE.md before changing review persistence or source writes. Use the
same ReviewSession and Library operations from the UI and agent commands. Preserve
earlier rounds, the fixed baseline, author choices, drafts, and discussion.

Use plain values and small functions. Keep one runtime record format; retired records
belong in explicit migrations that retain their original bytes. Avoid repository-specific
paths, compatibility layers, and abstractions without a concrete caller.

Run `.venv/bin/python -m unittest discover -s tests -v` after functional changes.
Check packaged startup and actual LaTeX rendering when changing those boundaries.
Use an isolated library for write tests. Never use a person's saved review as a fixture.

The agent skill is in `skills/manuscript-review/`. It is bundled with the macOS app;
keep its commands and references portable. Follow the author's manuscript instructions
when using the tool to revise prose.
