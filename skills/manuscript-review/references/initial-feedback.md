# Initial feedback

Open or identify the manuscript review before editing. Read the external report and the current manuscript. For each actionable point, choose a relevant quote and preserve the reviewer's request in an ordinary source comment. Cite its reviewer or ledger ID when available. Keep independently actionable points separate; combine related points when one response will address them.

Read the selected file through the app's source operation so rejected changes and retained drafts are reflected in the quote:

```sh
"/path/to/skill/scripts/review-agent" source --review REVIEW_ID --file sections/methods.tex
```

Write a JSON array in a temporary file:

```json
[
  {"file": "sections/methods.tex", "quote": "We score measured leaves.", "text": "R2: The reviewer asks which observations enter this loss."}
]
```

Each quote must match the returned `text` exactly, including LaTeX and whitespace. If it occurs more than once, include more context or add `"line": 42` for its starting line. Import with the latest saved revision:

```sh
"/path/to/skill/scripts/review-agent" annotate --review REVIEW_ID --revision SAVED_REVISION --annotations /absolute/path/to/feedback.json
```

The import creates agent-authored source comments without writing manuscript files or adding artificial edits. The batch is refused if any quote is missing or ambiguous. Reimporting the same annotations against the same source does not duplicate them. A stale revision requires rereading feedback before retrying. Keep the returned discussion IDs for responses and any CSV links; verify coverage before editing. The author can step through these comments in the app, revise the corresponding manuscript text, or ask an agent to revise them.

Anchor broad requests to the passage that best illustrates the issue and say that the request applies more widely. If no manuscript passage is relevant, retain the point and its disposition in the optional ledger or author summary. Do not force a misleading anchor or invent a manuscript change.

For a revision pass, use **begin**, edit within the authorized scope, run the manuscript checks, and **finish** as described in the skill. Then use **respond** in the new round with the original discussion IDs. Explain the smallest change that addresses each point, or why the wording was retained or the point deferred. The original feedback and reply appear beside the resulting diff. For replies without text changes, stay in the existing round. Do not add a second explanation for feedback that already has a comment.
