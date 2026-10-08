# First comparison

For changes already made outside the app, choose the Git commit or saved checkpoint that precedes them. Do not checkpoint the current revised files and use that as their baseline. If the pre-change source is unavailable, identify the intended comparison with the author.

Use the skill launcher to compare that version with the tracked working files, including staged new source files:

```sh
"/path/to/skill/scripts/review-agent" compare --repo /absolute/path/to/manuscript --base PRE_CHANGE_VERSION --entry main.tex
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Compare returns the review ID, saved path, and edit count. Check that it contains the intended changes, then open it from the Library. The author can annotate and review the diff; subsequent agent revisions use **begin**, **finish**, and **respond** as described in the skill. To ingest external feedback before editing, use **open** and the [initial feedback workflow](initial-feedback.md).

If a separate workflow needs a baseline before changes have begun, **checkpoint --repo /absolute/path/to/manuscript** pins the actual working files without changing HEAD or the Git index. Its returned `starting_version` can be used as `--base` after editing. For a separate library, pass `--home /absolute/path/to/library` before each subcommand.
