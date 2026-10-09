import {cp, mkdir, readFile, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildViewer(destination = join(root, 'dist/viewer')) {
    const require = createRequire(join(root, 'package.json'));
    const packageFile = require.resolve('pdfjs-dist/package.json');
    const dependency = dirname(packageFile);
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    const upstream = JSON.parse(await readFile(join(root, 'viewer/UPSTREAM.json'), 'utf8'));
    if (metadata.version !== upstream.pdfjs) throw new Error(`The Workshop viewer requires PDF.js ${upstream.pdfjs}.`);
    const source = join(root, 'viewer'), target = resolve(destination);
    const overlaps = path => path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
    if (overlaps(relative(source, target)) || overlaps(relative(target, source))) throw new Error('Build the PDF viewer outside its source directory.');
    await rm(destination, {recursive: true, force: true});
    await cp(join(root, 'viewer'), destination, {recursive: true});
    await mkdir(join(destination, 'build'));
    for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
        await cp(join(dependency, 'legacy/build', name), join(destination, 'build', name));
    }
    for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        await cp(join(dependency, directory), join(destination, directory), {recursive: true});
    }
    return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await buildViewer(process.argv[2]);
}
