import {createHighlights} from './highlights.mjs';
import {createPDFReview, reviewKey, reviewMessage} from './interaction.mjs';

const origin = new URL(location.href).searchParams.get('parentOrigin');
if (!origin || origin === 'null') throw new Error('The PDF viewer requires its review host.');
const target = new URL(origin).origin;
if (target !== origin) throw new Error('Invalid PDF review host.');
const send = value => window.parent.postMessage(value, target);

// Workshop applies these options immediately before PDF.js initializes.
function configure(event) {
    if (event.detail?.source !== window) return;
    window.PDFViewerApplicationOptions.setAll({
        defaultUrl: '', disablePreferences: true, disableHistory: true,
        enableScripting: false, annotationMode: 1, annotationEditorMode: -1, sidebarViewOnLoad: 0,
        enableComment: false, enableMerge: false, enableSplitMerge: false,
        workerSrc: new URL('./build/pdf.worker.mjs', import.meta.url).href,
        cMapUrl: new URL('./cmaps/', import.meta.url).href,
        standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
        wasmUrl: new URL('./wasm/', import.meta.url).href,
        iccUrl: new URL('./iccs/', import.meta.url).href,
        externalLinkTarget: 2
    });
    document.removeEventListener('webviewerloaded', configure);
    try { window.parent.document.removeEventListener('webviewerloaded', configure); } catch {}
}
document.addEventListener('webviewerloaded', configure);
try { window.parent.document.addEventListener('webviewerloaded', configure); } catch {}
const {PDFViewerApplication: application} = await import('./viewer.mjs');
await application.initializedPromise;
const highlights = createHighlights(application);
const reviewPDF = createPDFReview(application, highlights, send);

window.addEventListener('message', event => {
    const message = reviewMessage(event, target, window.parent);
    if (message) reviewPDF(message);
});

window.addEventListener('keydown', event => {
    const message = reviewKey(event);
    if (!message) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(message);
}, {capture: true});

// A historical comparison must keep displaying its pinned PDF.
document.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}, {capture: true});

// Retain Workshop's toolbar behavior without its server-specific controls.
const toolbar = document.querySelector('.toolbar');
let hideTimer;
document.getElementById('outerContainer').addEventListener('mousemove', event => {
    if (event.clientY <= 64) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
        toolbar.classList.remove('hide');
    } else if (!hideTimer) {
        hideTimer = setTimeout(() => {
            if (!application.findBar.opened && !application.viewsManager.isOpen && !application.secondaryToolbar.isOpen) toolbar.classList.add('hide');
            hideTimer = undefined;
        }, 1500);
    }
});
window.addEventListener('pagehide', () => { highlights.dispose(); clearTimeout(hideTimer); });
send({type: 'review-pdf-ready'});
