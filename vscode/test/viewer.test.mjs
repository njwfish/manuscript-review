import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildViewer} from '../src/build-viewer.mjs';
import {reviewMarks, viewportBounds} from '../viewer/highlights.mjs';
import {createPDFReview, reviewKey, reviewMessage} from '../viewer/interaction.mjs';

const source = fileURLToPath(new URL('../viewer/', import.meta.url));

function samplePDF(rotation = 0) {
    const text = 'BT /F1 12 Tf 50 700 Td (A sentence.) Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [20 30 580 770] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
    ];
    let document = '%PDF-1.4\n';
    const offsets = [];
    for (const [index, value] of objects.entries()) {
        offsets.push(document.length);
        document += `${index + 1} 0 obj\n${value}\nendobj\n`;
    }
    const start = document.length;
    document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
    document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(document));
}

function close(actual, expected) {
    for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs(actual[key] - value) < .0001, `${key}: ${actual[key]} should be ${value}`);
}

test('PDF page geometry preserves highlights through crop, intrinsic rotation, zoom, and extra rotation', async t => {
    for (const rotation of [0, 90, 180, 270]) {
        const loading = getDocument({data: samplePDF(rotation),
            standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url))});
        t.after(() => loading.destroy());
        const document = await loading.promise, page = await document.getPage(1);
        const original = page.getViewport({scale: 1}), bounds = [.1, .2, .4, .3];
        const view = {pdfPage: page, viewport: page.getViewport({scale: 2})};
        close(viewportBounds(bounds, view), {left: original.width * .2, top: original.height * .4, width: original.width * .6, height: original.height * .2});
        view.viewport = page.getViewport({scale: 2, rotation: (rotation + 90) % 360});
        close(viewportBounds(bounds, view), {left: original.height * 1.4, top: original.width * .2, width: original.height * .2, height: original.width * .6});
        view.viewport = page.getViewport({scale: .5, rotation: (rotation + 180) % 360});
        close(viewportBounds(bounds, view), {left: original.width * .3, top: original.height * .35, width: original.width * .15, height: original.height * .05});
        view.viewport = page.getViewport({scale: 1, rotation: (rotation + 270) % 360});
        close(viewportBounds(bounds, view), {left: original.height * .2, top: original.width * .6, width: original.height * .1, height: original.width * .3});
        assert.equal((await page.getTextContent()).items[0].str, 'A sentence.');
    }
});

test('marks retain page-only locations and refuse invalid normalized regions', () => {
    const supplied = [{page: 2, bounds: [.1, .2, .3, .4]}, {page: 3, bounds: null}];
    assert.deepEqual(reviewMarks(supplied), supplied);
    reviewMarks(supplied)[0].bounds[0] = 0;
    assert.equal(supplied[0].bounds[0], .1);
    for (const value of [null, [{page: 0, bounds: null}], [{page: 1, bounds: [0, 0, Infinity, 1]}],
        [{page: 1, bounds: [-.1, 0, 1, 1]}], [{page: 1, bounds: [.6, 0, .2, 1]}]]) {
        assert.throws(() => reviewMarks(value), /PDF highlight/);
    }
});

test('only the parent window at its pinned origin can load PDF review data', () => {
    const parent = {}, origin = 'https://example.vscode-cdn.net', data = {type: 'review-pdf', marks: []};
    assert.equal(reviewMessage({source: parent, origin, data}, origin, parent), data);
    assert.equal(reviewMessage({source: {}, origin, data}, origin, parent), undefined);
    assert.equal(reviewMessage({source: parent, origin: 'https://other.test', data}, origin, parent), undefined);
    assert.equal(reviewMessage({source: parent, origin, data: {type: 'other'}}, origin, parent), undefined);
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

test('a queued document keeps its bytes when a newer selection arrives during a previous load', async () => {
    const initial = deferred(), opens = [], selections = [], errors = [];
    const application = {
        async open(options) {
            opens.push([...options.data]);
            if (options.data[0] === 1) await initial.promise;
            this.pdfDocument = {};
        }
    };
    const update = createPDFReview(application, {set: (...args) => selections.push(args)}, error => errors.push(error));
    const first = update({document: '/assets/first.pdf', data: Uint8Array.of(1), marks: []});
    await Promise.resolve();
    assert.deepEqual(opens, [[1]]);
    const next = update({document: '/assets/next.pdf', data: Uint8Array.of(2), marks: [{page: 1, bounds: [0, 0, .1, .1]}]});
    const marks = [{page: 3, bounds: [.2, .3, .4, .5]}];
    const latest = update({document: '/assets/next.pdf', marks, color: 'removed'});
    initial.resolve();
    await Promise.all([first, next, latest]);
    assert.deepEqual(opens, [[1], [2]]);
    assert.deepEqual(selections.at(-1), [marks, 'removed', true]);
    assert.deepEqual(errors, []);
    await update({document: '/assets/next.pdf', marks, active: false});
    assert.deepEqual(opens, [[1], [2]]);
    assert.deepEqual(selections.at(-1), [marks, undefined, false]);
});

test('only the latest document opens after a pending document and its obsolete load failure', async () => {
    const initial = deferred(), opens = [], selections = [], errors = [];
    const application = {
        async open(options) {
            opens.push([...options.data]);
            if (options.data[0] === 1) await initial.promise;
            this.pdfDocument = {};
        }
    };
    const update = createPDFReview(application, {set: (...args) => selections.push(args)}, error => errors.push(error));
    const first = update({document: '/assets/first.pdf', data: Uint8Array.of(1)});
    await Promise.resolve();
    const skipped = update({document: '/assets/skipped.pdf', data: Uint8Array.of(2)});
    const final = update({document: '/assets/final.pdf', data: Uint8Array.of(3)});
    const marks = [{page: 4, bounds: null}];
    const selection = update({document: '/assets/final.pdf', marks, color: 'added'});
    initial.reject(new Error('The obsolete PDF failed.'));
    await Promise.all([first, skipped, final, selection]);
    assert.deepEqual(opens, [[1], [3]]);
    assert.deepEqual(selections.at(-1), [marks, 'added', true]);
    assert.deepEqual(errors, []);
});

test('PDF failures identify their document and do not poison later document loading', async () => {
    const errors = [], selections = [];
    const application = {
        async open(options) {
            if (options.data[0] === 1) throw new Error('Invalid historical PDF.');
            this.pdfDocument = {};
        }
    };
    const update = createPDFReview(application, {set: (...args) => selections.push(args)}, error => errors.push(error));
    await update({document: '/assets/invalid.pdf', data: Uint8Array.of(1)});
    assert.deepEqual(errors, [{type: 'review-pdf-error', document: '/assets/invalid.pdf', error: 'Invalid historical PDF.'}]);
    const marks = [{page: 1, bounds: [0, 0, .1, .1]}];
    await update({document: '/assets/valid.pdf', data: Uint8Array.of(2), marks});
    assert.deepEqual(selections.at(-1), [marks, undefined, true]);
    assert.equal(errors.length, 1);
});

test('review shortcuts leave PDF search and modified editing shortcuts untouched', () => {
    assert.deepEqual(reviewKey({key: 'A', shiftKey: true}), {type: 'review-pdf-key', key: 'A', shiftKey: true, repeat: false});
    assert.equal(reviewKey({key: 'f', repeat: true}).repeat, true);
    assert.equal(reviewKey({key: 'e'}).key, 'e');
    for (const key of ['[', ']', 'p', 'n', 'q', 'm', 'i', '?']) assert.equal(reviewKey({key}).key, key);
    for (const event of [{key: 'a', metaKey: true}, {key: 'f', ctrlKey: true}, {key: 'r', altKey: true},
        {key: 'a', isComposing: true}, {key: 'c', defaultPrevented: true}, {key: '+'},
        {key: 'a', target: {isContentEditable: true}}, {key: 's', target: {closest: () => ({})}}]) {
        assert.equal(reviewKey(event), undefined);
    }
});

test('the packaged viewer retains pinned Workshop sources, PDF engine resources, and notices', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'manuscript-review-viewer-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const destination = join(directory, 'viewer');
    await buildViewer(destination);
    const upstream = JSON.parse(await readFile(join(destination, 'UPSTREAM.json'), 'utf8'));
    assert.equal(upstream.commit, '52f8c9e87b710d17293c4e150a7378ebc9cb801e');
    assert.equal(upstream.pdfjs, '6.2.108');
    for (const file of ['viewer.mjs', 'viewer.css', 'latexworkshop.css']) {
        assert.equal(createHash('sha256').update(await readFile(join(destination, file))).digest('hex'), upstream.upstream_sha256[file]);
    }
    for (const file of ['review.mjs', 'highlights.mjs', 'interaction.mjs', 'review.css', 'build/pdf.mjs', 'build/pdf.worker.mjs',
        'locale/en-US/viewer.ftl', 'locale/locale.json', 'cmaps/LICENSE', 'standard_fonts/LICENSE_LIBERATION', 'wasm/LICENSE_OPENJPEG', 'iccs/LICENSE']) {
        await access(join(destination, file));
    }
    assert.match(await readFile(join(destination, 'LICENSE-LATEX-WORKSHOP.txt'), 'utf8'), /MIT License/);
    assert.match(await readFile(join(destination, 'LICENSE-PDFJS.txt'), 'utf8'), /Apache License/);
    assert.match(await readFile(join(destination, 'LICENSE-CORE-JS.txt'), 'utf8'), /CoreJS Company/);
    const html = await readFile(join(destination, 'viewer.html'), 'utf8');
    assert.match(html, /src="review\.mjs"/);
    assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1);
    assert.doesNotMatch(html, /ws:\/\/|out\/viewer\/latexworkshop/);
    assert.match(await readFile(join(destination, 'build/pdf.mjs'), 'utf8'), /pdfjsVersion = 6\.2\.108/);
    await assert.rejects(buildViewer(source), /outside its source directory/);
});
