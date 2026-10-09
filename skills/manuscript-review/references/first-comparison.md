# First comparison

For changes already made outside the app, choose the Git commit or saved checkpoint that precedes them. Do not checkpoint the current revised files and use that as their baseline. If the pre-change source is unavailable, identify the intended comparison with the author.

For a PR, check out its proposal through the repository’s usual Git workflow. Compare the proposal commit against its merge base with the target branch for the complete PR diff, or against a previously reviewed commit for the latest update. Pin the commits you inspected; fetching or advancing a branch should not silently change an existing comparison. The app also accepts a saved working draft as the proposal, so a local review does not require a PR.

Use the skill launcher to compare that version with the tracked working files, including staged new source files:

```sh
"/path/to/skill/scripts/review-agent" compare --repo /absolute/path/to/manuscript --base PRE_CHANGE_VERSION --entry main.tex
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Use `--proposed PROPOSAL_COMMIT` when comparing committed versions. Compare returns the review ID, saved path, exact source versions, and edit count. Check the intended diff, then open the review. The author can annotate and review its wording; subsequent revisions use **begin**, **finish**, and **respond** within the existing branch workflow. To ingest external feedback before editing, use **open** and the [initial feedback workflow](initial-feedback.md).

If a separate workflow needs a baseline before changes have begun, **checkpoint --repo /absolute/path/to/manuscript** pins the actual working files without changing HEAD or the Git index. Its returned `starting_version` can be used as `--base` after editing. For a separate library, pass `--home /absolute/path/to/library` before each subcommand.
