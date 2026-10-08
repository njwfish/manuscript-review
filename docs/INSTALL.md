# Installation

## macOS app

Download the app ZIP from the [latest release](https://github.com/njwfish/manuscript-review/releases/latest), unzip it, and move **Manuscript Review.app** into **Applications**. Open the app to start reviewing. The app supports Apple Silicon Macs running macOS 13 or later and includes its Python runtime.

**Library → Setup** checks Git and preview tools and installs the bundled agent skill. In the macOS app, **⌘+,** also opens Setup.

Git must be installed. Apple's Command Line Tools provide it:

```sh
xcode-select --install
```

The distributed app is locally signed and has not been notarized. If macOS blocks the first launch, follow Apple's [instructions for opening a trusted app](https://support.apple.com/en-us/102445), or use the source installation below.

For typeset equation and algorithm previews, install a TeX distribution such as [MacTeX](https://www.tug.org/mactex/) containing `latexmk` and `pdflatex`, plus Poppler’s `pdftocairo`, `pdftotext`, and `pdfinfo` for full-page PDF highlights. An existing MacTeX installation usually supplies the TeX tools. With Homebrew, Poppler is:

```sh
brew install poppler
```

The app finds tools on your PATH and in `/Library/TeX/texbin`, `/opt/homebrew/bin`, and `/usr/local/bin`. Word-level review works without these optional preview tools. Manuscripts with custom styles or packages need their usual TeX dependencies installed.

To update, quit the app and replace it with the new release. Your review library stays in `~/Library/Application Support/Manuscript Review`, outside the app bundle.

## Install the agent skill

The skill gives an agent the commands and review cycle needed to read your comments, append responses, and create another round. It requires an agent with local filesystem and shell access on the same machine as your manuscript and review library.

Open **Library → Setup** and click **Install skill** beside Codex or Claude Code. The app links its bundled skill into the agent’s personal skills directory, preserving any existing skill. Start a new agent session after installing.

For manual setup with Codex, link the bundled skill into its [personal skills directory](https://developers.openai.com/codex/skills):

```sh
mkdir -p ~/.agents/skills
[ ! -e ~/.agents/skills/manuscript-review ] && [ ! -L ~/.agents/skills/manuscript-review ] && \
  ln -s "/Applications/Manuscript Review.app/Contents/Resources/skills/manuscript-review" ~/.agents/skills/manuscript-review
```

For Claude Code, use its [personal skills directory](https://code.claude.com/docs/en/skills):

```sh
mkdir -p ~/.claude/skills
[ ! -e ~/.claude/skills/manuscript-review ] && [ ! -L ~/.claude/skills/manuscript-review ] && \
  ln -s "/Applications/Manuscript Review.app/Contents/Resources/skills/manuscript-review" ~/.claude/skills/manuscript-review
```

These commands preserve any existing skill at that name by refusing to replace it. If you already have an older copy, replace its link deliberately. Start a new agent session if the skill does not appear. Other agents that read `SKILL.md` can use the same folder.

The skill contains its own command launcher, so you do not need to add anything to PATH. To check the bundled commands directly:

```sh
"/Applications/Manuscript Review.app/Contents/MacOS/manuscript-review-agent" --version
```

Then use **Copy agent request** in a review and paste the prompt into your agent's chat. Codex can also invoke the skill as `$manuscript-review`; Claude Code can use `/manuscript-review`.

## Run from source

The browser interface runs on macOS and Linux with Git and Python 3.12 or later. The native macOS app is the packaged desktop interface; Windows is not currently supported.

```sh
git clone https://github.com/njwfish/manuscript-review.git
cd manuscript-review
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/manuscript-review
```

The command opens your browser and keeps the local service running in that terminal. Stop it with Ctrl+C after your work has saved. Pass `--home /path/to/library` to choose a separate library; Linux defaults to `~/.local/share/manuscript-review`, respecting `XDG_DATA_HOME`.

To install the skill from this checkout, run one of these from the repository root:

```sh
# Codex
mkdir -p ~/.agents/skills
[ ! -e ~/.agents/skills/manuscript-review ] && [ ! -L ~/.agents/skills/manuscript-review ] && \
  ln -s "$PWD/skills/manuscript-review" ~/.agents/skills/manuscript-review

# Claude Code
mkdir -p ~/.claude/skills
[ ! -e ~/.claude/skills/manuscript-review ] && [ ! -L ~/.claude/skills/manuscript-review ] && \
  ln -s "$PWD/skills/manuscript-review" ~/.claude/skills/manuscript-review
```

Keep the checkout and its `.venv` in place while using the linked skill. See [Development](DEVELOPMENT.md) to build the native app.

## Upgrade an existing library

Version 0.11 uses full-file source drafts. Before opening an existing version 0.10 library in the updated app, quit the old app, replace it, and run:

```sh
"/Applications/Manuscript Review.app/Contents/MacOS/manuscript-review-agent" migrate
```

For a source installation, use `.venv/bin/manuscript-review-agent migrate`. Add `--home /path/to/library` before `migrate` for a separate library. The command preserves review choices, comments, replies, and source versions, combines saved passage drafts into file drafts, and archives each original record under `migration-v5/review.json`. It leaves manuscript files unchanged and is safe to repeat. Then open the updated app.

## Prepare a manuscript folder

The app compares text sources in a Git repository with at least one commit. Use an existing manuscript repository, or initialize an ordinary LaTeX folder before opening it in the app:

```sh
cd /path/to/manuscript
git init
git add main.tex
# Add any included section files, bibliography, and local styles as well.
git commit -m "Initial manuscript"
```

Keep source files tracked; add generated PDFs and TeX build products to `.gitignore`. Save or commit a proposed revision, then compare the starting commit against **Working files** or the revision commit. An Overleaf download can use this same setup.
