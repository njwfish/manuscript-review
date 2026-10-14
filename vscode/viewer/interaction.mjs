import {reviewMarks} from './highlights.mjs';

const keys = new Set(['a', 's', 'd', 'f', 'u', 'c', 'e', 'escape']);

export function reviewOrigin(value) {
    const url = new URL(value);
    const origin = url.protocol === 'vscode-webview:' && /^[a-z0-9-]+$/.test(url.hostname) && !url.port
        ? 'vscode-webview://' + url.hostname : url.origin;
    if (origin === 'null' || origin !== value || !['http:', 'https:', 'vscode-webview:'].includes(url.protocol))
        throw new Error('Invalid PDF review host.');
    return origin;
}

export function reviewKey(event) {
    if (event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    if (event.ctrlKey && !['a', 's'].includes(event.key?.toLowerCase())) return;
    if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
    if (!keys.has(event.key?.toLowerCase())) return;
    return {type: 'review-pdf-key', key: event.key, shiftKey: Boolean(event.shiftKey), ctrlKey: Boolean(event.ctrlKey), repeat: Boolean(event.repeat)};
}

export function reviewMessage(event, origin, parent) {
    if (event.source === parent && event.origin === origin && event.data?.type === 'review-pdf') return event.data;
}

export function createPDFReview(application, highlights, onError) {
    let documentKey, generation = 0, pending, loading = Promise.resolve();
    return message => {
        const ticket = ++generation;
        const key = typeof message.document === 'string' ? message.document : undefined;
        if (!pending || key !== pending.document) pending = {document: key, data: message.data};
        else if (message.data !== undefined) pending.data = message.data;
        loading = loading.then(async () => {
            if (ticket !== generation) return;
            const marks = reviewMarks(message.marks || []), focus = reviewMarks(message.focus || []);
            if (!application.pdfDocument || key === undefined || key !== documentKey) {
                const data = pending.data;
                if (!(data instanceof Uint8Array || data instanceof ArrayBuffer)) throw new Error('PDF review data is missing.');
                pending.data = undefined;
                highlights.set([], message.color, false);
                await application.open({data: data instanceof Uint8Array ? data : new Uint8Array(data), isEvalSupported: false});
                documentKey = key;
            }
            if (ticket === generation) highlights.set(marks, message.color, message.active !== false, focus);
            return ticket === generation;
        }).catch(error => {
            if (ticket === generation) onError({type: 'review-pdf-error', document: key, error: error.message});
            return false;
        });
        return loading;
    };
}
