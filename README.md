# Manuscript Review

Review manuscript revisions one word change at a time, with highlighted LaTeX previews, keyboard decisions, passage editing, and comments that stay with each round.

The app is designed for authors reviewing substantial edits from students, collaborators, or agents. Text opens as a short excerpt with the exact additions and deletions highlighted. Equations and algorithms open side by side as typeset LaTeX. Reviews stay on your computer; an agent can read your saved feedback and prepare another round through the bundled skill.

![A sample manuscript review](docs/images/review.png)

## Install

Download the [macOS app](https://github.com/njwfish/manuscript-review/releases/latest), unzip it, and move **Manuscript Review.app** to **Applications**. The app supports Apple Silicon Macs on macOS 13 or later and includes Python. Git is required; LaTeX and Poppler are optional for typeset previews.

See [Installation](docs/INSTALL.md) for prerequisites, first launch, the agent skill, and running from source on macOS or Linux.

## Review a manuscript

Start with manuscript text sources in a Git repository with at least one commit; [prepare a plain manuscript folder](docs/INSTALL.md#prepare-a-manuscript-folder) if needed. Choose **Compare versions**, then a **Local folder** or **GitHub repository**. A local folder can contain a nested manuscript repository; choose one if several are found. For GitHub, paste its URL and choose a parent folder to clone into. Existing Git credentials handle private repositories.

Pick **Compare from** and **Compare to** from dropdowns of saved review checkpoints, branches, tags, and recent commits. Each commit shows its date, message, and short hash; use **Find a version** to filter them. **Working files** captures tracked files, including staged new files, without changing HEAD or the index. **Fetch latest commits** updates remote history without merging or changing your manuscript. Choose the LaTeX entry file for equation and algorithm previews.

The Library shows one card per manuscript, with its latest review and earlier rounds under **History**. **Open latest** resumes the current round. **New round** compares working files against the latest selected draft and preserves the original baseline. Earlier choices are already part of the starting draft, so rejecting a new edit keeps that earlier wording. **Compare…** lets you choose another pair of versions.

The review opens in **This round**, showing only changes from its starting draft to its proposal. Switch to **Since baseline**, or press **T**, to inspect the selected manuscript against the original baseline. This cumulative view updates with your decisions; review decisions and passage edits belong to **This round**. Earlier comments and replies remain available beside matching edits and in **All feedback**. The app reopens your last review on launch.

Use **Accept** or **A** to keep an edit, **Reject** or **S** to restore this round’s starting wording, and **Reset** or **U** to leave it undecided. Accepting or rejecting advances to the next edit; **D / F** moves backward or forward. Choices and comments save automatically. When the review is complete, **Apply review** writes the selected wording to your manuscript.

## Edit and discuss

Press **E** to edit the whole selected passage, starting from your current choices. **Save passage** or **⌘/Ctrl+Enter** writes your wording to the manuscript, rebuilds the word diff against this round’s starting draft, and marks your changes accepted. Only this passage is written; the rest of the working file and its review decisions stay as they were. Comments on superseded edits move into the discussion. Saving also refreshes equation highlights. **Esc** keeps your draft and returns to review; drafts survive app restarts. The draft indicator or **Shift+E** resumes a draft; **Discard draft** restores the selected wording.

Press **C** to comment on an edit, or **Shift+C** for a passage note. The **Comment on** selector changes the scope. Earlier feedback and replies appear above the follow-up field. **Q** opens current comments and earlier discussion, with search. Replies append, so another revision pass can retain the full exchange.

When every edit has a decision, the completion area shows **Apply review** and **Copy agent request**. The header’s **Review complete** button returns to these actions after scrolling. **⌘/Ctrl+Enter** applies the review from the review view; **Applied** confirms the selected wording is written. Save or discard passage drafts before applying. **More → Apply review** can also apply a partial review, retaining proposed wording for undecided edits.

The macOS library lives in `~/Library/Application Support/Manuscript Review/`, separate from the app. Replacing the app preserves your saved reviews. [Advanced usage](docs/USAGE.md) covers exports, manual response imports, and recovery.

## Keyboard

| Key | Action |
| --- | --- |
| D / F | Previous / next edit |
| Shift+D / Shift+F | Previous / next passage |
| [ / ] | Previous / next file |
| A / S | Accept / reject and advance |
| Shift+A / Shift+S / Shift+U | Accept / reject / reset the passage |
| Ctrl+A / Ctrl+S / Ctrl+U | Accept / reject / reset the file |
| U | Reset the current decision |
| E | Edit the whole passage |
| Shift+E | Resume a saved draft |
| C / Shift+C | Comment on edit / passage |
| Q | Search current comments and earlier replies |
| R | Copy an agent request for your chat |
| T | This round / Since baseline |
| ⌘/Ctrl+Enter | Save passage / comment; apply a completed review |
| Esc | Return to review; keep source draft |
| V | Switch word changes / rendered LaTeX |
| G | Next undecided edit |
| ? | All shortcuts |
| ⌘Shift+L / ⌘N | Library / compare versions in the native app |

Holding a key does not repeat decisions. Shortcuts pause while typing; Tab and Enter work on controls.

## Work with an agent

Use **Library → Setup** to check dependencies and install the [manuscript-review skill](skills/manuscript-review/SKILL.md) for Codex or Claude Code. The [installation guide](docs/INSTALL.md#install-the-agent-skill) also covers manual setup. The skill uses the same review operations as the app; an agent needs local filesystem and shell access to your manuscript and saved library.

The cycle is **review → apply → ask the agent → review the next round**. When you finish deciding, use **Apply review** to write the selected wording, then **Copy agent request** or **R** and paste the prompt into your agent's chat. The prompt identifies the exact review and tells the agent to read your decisions, comments, and earlier responses. You can also request responses while decisions are still in progress.

Replies without source changes stay in the current round. Text revisions create a new round against the previously selected draft, preserving earlier choices and the original baseline. Open the new round from the Library; **Since baseline** shows the accumulated selected changes. Agent conversation takes place in your existing chat, while the app keeps comments and responses beside their source context.

For an initial referee report, ask the agent to propose surgical revisions and explain each related set of changes in a passage note. For a long report, the skill can maintain an optional feedback CSV beside the manuscript. Subsequent iterations use replies to your comments.

## Development

See [Development](docs/DEVELOPMENT.md) for tests, native builds, and releases, and [Architecture](ARCHITECTURE.md) for the record model and transaction boundaries. The service uses Python's standard library, with a small JavaScript interface and a Swift macOS wrapper.

## License

[MIT](LICENSE). Bundled Python and PyInstaller notices are included in the app.
