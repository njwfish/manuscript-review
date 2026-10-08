# First comparison

Use this only when the manuscript has no saved review. Preserve the actual starting draft before editing; an empty comparison is not needed. Use the same skill launcher as in SKILL.md:

```sh
"/path/to/skill/scripts/review-agent" checkpoint --repo /absolute/path/to/manuscript
```

Keep the returned `starting_version`. The checkpoint includes tracked working files and staged new files, and leaves HEAD and the Git index unchanged. Edit the manuscript within the requested scope and run its relevant checks. Stage any new source files that should enter the comparison.

Create the first review using that starting version and the relative LaTeX entry file:

```sh
"/path/to/skill/scripts/review-agent" compare --repo /absolute/path/to/manuscript --base STARTING_VERSION --entry main.tex
"/path/to/skill/scripts/review-agent" feedback --review REVIEW_ID
```

Compare returns the review ID, saved path, and edit count. Verify the proposed changes and add explanations using the main skill. Open the round from the Library. Later passes use the saved review's begin/finish commands. For a separate library, pass `--home /absolute/path/to/library` before each subcommand.
