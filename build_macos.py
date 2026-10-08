#!/usr/bin/env python3
"""Build a self-contained local macOS app; run with a Python that has PyInstaller."""
import plistlib
import importlib.metadata
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path
from manuscript_review import __version__

root = Path(__file__).resolve().parent
build = root / 'build'
dist = root / 'dist'
app = dist / 'Manuscript Review.app'
if app.exists():
    shutil.rmtree(app)
contents = app / 'Contents'
resources = contents / 'Resources'
macos = contents / 'MacOS'
macos.mkdir(parents=True)
resources.mkdir()
command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'ManuscriptReviewBackend',
           '--paths', str(root), '--distpath', str(build / 'backend-dist'), '--workpath', str(build / 'pyinstaller'), '--specpath', str(build)]
for asset in sorted((root / 'manuscript_review').iterdir()):
    if asset.suffix in ('.html', '.js'):
        command.extend(['--add-data', str(asset) + ':manuscript_review'])
subprocess.run(command + [str(root / 'macos/backend.py')], check=True)
shutil.copytree(build / 'backend-dist/ManuscriptReviewBackend', resources / 'Backend')
shutil.copytree(root / 'skills', resources / 'skills')
shutil.copytree(root / 'docs', resources / 'docs')
for name in ('README.md', 'ARCHITECTURE.md', 'LICENSE'):
    if (root / name).exists():
        shutil.copy2(root / name, resources / name)
notices = resources / 'ThirdPartyLicenses'
notices.mkdir()
shutil.copy2(Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt', notices / 'Python.txt')
distribution = importlib.metadata.distribution('pyinstaller')
license_file = next(path for path in distribution.files if str(path).endswith('COPYING.txt'))
shutil.copy2(distribution.locate_file(license_file), notices / 'PyInstaller.txt')
launcher = macos / 'manuscript-review-agent'
launcher.write_text('''#!/bin/sh
command_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec "$command_dir/../Resources/Backend/ManuscriptReviewBackend" agent "$@"
''')
launcher.chmod(0o755)
subprocess.run(['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0',
                '-framework', 'Cocoa', '-framework', 'WebKit', str(root / 'macos/App.swift'),
                '-o', str(macos / 'ManuscriptReview')], check=True)
iconset = build / 'Review.iconset'
iconset.mkdir(exist_ok=True)
original = build / 'icon.png'
subprocess.run([str(macos / 'ManuscriptReview'), '--make-icon', str(original)], check=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        pixels = size * scale
        name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
        subprocess.run(['sips', '-z', str(pixels), str(pixels), str(original), '--out', str(iconset / name)], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(resources / 'Review.icns')], check=True)
with (contents / 'Info.plist').open('wb') as file:
    plistlib.dump({'CFBundleName': 'Manuscript Review', 'CFBundleDisplayName': 'Manuscript Review',
                  'CFBundleIdentifier': 'local.manuscript.review', 'CFBundleExecutable': 'ManuscriptReview',
                  'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': __version__, 'CFBundleVersion': __version__,
                  'CFBundleIconFile': 'Review', 'LSMinimumSystemVersion': '13.0', 'NSHighResolutionCapable': True,
                  'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}, 'NSPrincipalClass': 'NSApplication'}, file)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(dist / 'Manuscript Review.zip')], check=True)
print(app)
