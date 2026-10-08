# Development

Install the source as described in [Installation](INSTALL.md). The Python service has no third-party runtime dependencies; the native wrapper uses Cocoa and WebKit. For the full test suite, also install Node.js and the locked editor dependencies:

```sh
npm ci
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/manuscript-review --home /absolute/path/to/test-library
```

Node.js runs the client model, editor, and save-queue checks in the test suite. To change the editor, edit `frontend/editor.js` and regenerate the checked-in bundle with `npm run build`. Both CI and release builds check that regeneration produces the same bundle. Without Node, client checks are skipped. Use an isolated library for write tests. The [architecture](../ARCHITECTURE.md) describes persistence and source-write boundaries.

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

Build the distributable VSIX on macOS with Xcode Command Line Tools to compile its
universal Accessibility helper for Apple Silicon and Intel. Linux builds omit that
helper and use manual agent submission. Test automatic native sending from the
actual extension host after granting VS Code Accessibility; a shell permission probe
does not establish that host’s authorization. Use synthetic comments, verify the
provider’s complete composer and its submitted message, and confirm that author
focus and clipboard contents return. Never retry an uncertain Send.

## Build the macOS app

Build on Apple Silicon with Xcode Command Line Tools and Python 3.12 or later:

```sh
.venv/bin/python -m pip install 'pyinstaller==6.22.3'
.venv/bin/python build_macos.py
```

The build writes `dist/Manuscript Review.app` and `dist/Manuscript Review.zip`. The bundle includes the runtime, command interface, agent skill, and documentation. Its local code signature supports testing; distribution with Apple's verified developer identity would require Developer ID signing and notarization.

The version lives in `manuscript_review/__init__.py` and supplies both package and app metadata. Before releasing, run the tests, check actual LaTeX previews, and open the built app with a separate library. Tag the verified commit as `vVERSION`; the release workflow builds and tests the app, then creates a draft GitHub release. Publish that draft after checking its artifact and release notes.

## Existing review libraries

The runtime reads one current record format. If an older installation needs a format upgrade, quit the app and use the explicit migration command documented in [Installation](INSTALL.md#upgrade-an-existing-library). Earlier retired formats have matching scripts in `migrations/`. These scripts validate the library and retain byte-exact originals. They do not run automatically. Release notes identify any required migration.
