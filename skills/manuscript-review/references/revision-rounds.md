# Revision rounds

Use a separate round when the author explicitly wants a new pass after settling a review. For concurrent comment work, use [Parallel proposals](parallel-proposals.md) instead.

Pin the selected input:

```sh
"/path/to/skill/scripts/review-agent" begin --review REVIEW_ID
```

Begin verifies that reviewed files match the saved choices and no file draft remains unsaved. If files differ, inspect the changes. Apply choices only with the author's authorization, or capture outside edits through **Compare saved changes** and begin from that round. Never bypass the check or overwrite outside edits.

Edit in the returned workspace, follow the repository's Git workflow and build checks, and stage new source files. Use the exact values returned by begin:

```sh
"/path/to/skill/scripts/review-agent" finish --review REVIEW_ID --revision STARTING_REVISION --from STARTING_VERSION
"/path/to/skill/scripts/review-agent" feedback --review NEW_REVIEW_ID
```

Finish returns a new review ID and pinned source versions. Verify its diff, then append final responses there using the latest revision. The earlier round, original baseline, discussion, and resolution states remain. **This round** shows the new pass; **Since baseline** shows accumulated selected changes. A source pass without reviewable edits is refused. Keep replies without source changes in the existing round.
