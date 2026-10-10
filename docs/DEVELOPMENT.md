# Development

Install the source as described in [Installation](INSTALL.md). The Python service has no third-party runtime dependencies; the native wrapper uses Cocoa and WebKit. For the full test suite, also install Node.js and the locked editor dependencies:

```sh
npm ci
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/manuscript-review --home /absolute/path/to/test-library
```

Node.js runs the client model, editor, and save-queue checks in the test suite. To change the editor, edit `frontend/editor.js` and regenerate the checked-in bundle with `npm run build`. Both CI and release builds check that regeneration produces the same bundle. Without Node, client checks are skipped. Use an isolated library for write tests. The [architecture](../ARCHITECTURE.md) describes persistence and source-write boundaries.

Dispatch tests use mocked subprocesses to check the exact prompt, argument boundaries, and revision checks; client checks cover save failures and concurrent editing. For a live check, create a synthetic repository and separate review library, dispatch one comment through each installed CLI, and verify its final response in the saved discussion. Confirm that manuscript bytes, decisions, and resolution remain unchanged for a reply-only task. Also verify that a source revision can write Git checkpoints, accumulate its diff, and return a response in the current review while author input stays intact. Check provider session persistence separately from desktop visibility. Do not use a person's saved review as a live fixture.

## Repository and releases

Maintain both interfaces on `main`, with shared behavior in `manuscript_review/` and
VS Code adapters in `vscode/`. Feature branches merge back into `main`; separate
product branches would duplicate fixes to the same engine and records.

Each release tag pins both packages to one commit. The engine version in
`manuscript_review/__init__.py` determines the `vVERSION` tag; the extension version
in `vscode/package.json` determines its VSIX name. The release workflow runs both
test suites and builds the app ZIP and VSIX together, then creates a draft release.
Check the packaged startup, source review, and actual LaTeX previews before publishing.

## Build the VS Code extension

VS Code is the primary product. Build and test its adapters from `vscode/`:

```sh
npm ci
npm test
npm run package
```

The VSIX includes the shared Python engine, interface, comparison viewer, and agent
skill. Python remains a workspace-host prerequisite. The extension version is in
`vscode/package.json`; the package filename uses that version. Verify the extracted
VSIX with an isolated library and real LaTeX before distribution, then check the
native editor, comments, word and PDF navigation, Apply, and setup in an extension
development host. Promote a preview to a production release after those checks pass.

Comment dispatch uses the shared CLI operation on macOS and Linux. Test it with an
isolated library and synthetic comments: verify the exact prompt, detached process,
proposal publication, and final response while the author continues editing. Keep
provider startup out of the interface request, and retain its output for diagnostics.

## Build the macOS app

Build on Apple Silicon with Xcode Command Line Tools and Python 3.12 or later:

```sh
.venv/bin/python -m pip install 'pyinstaller==6.22.3'
.venv/bin/python build_macos.py
```

The build writes `dist/Manuscript Review.app` and `dist/Manuscript Review.zip`. The bundle includes the runtime, command interface, agent skill, and documentation. Its local code signature supports testing; distribution with Apple's verified developer identity would require Developer ID signing and notarization.

The engine version also supplies the app metadata. Open the built app with a separate library before publishing; see [Repository and releases](#repository-and-releases) for the release process.

## Existing review libraries

The runtime reads one current record format. If an older installation needs a format upgrade, quit the app and use the explicit migration command documented in [Installation](INSTALL.md#upgrade-an-existing-library). Earlier retired formats have matching scripts in `migrations/`. These scripts validate the library and retain byte-exact originals. They do not run automatically. Release notes identify any required migration.
