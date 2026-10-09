import {reviewMarks} from './highlights.mjs';

const keys = new Set(['a', 's', 'd', 'f', 'j', 'k', 'u', 'c', 'r', 'v', 't', 'g', 'e', 'p', 'n', 'q', 'm', 'i', '?', '[', ']']);

export function reviewKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
    if (!keys.has(event.key?.toLowerCase())) return;
    return {type: 'review-pdf-key', key: event.key, shiftKey: Boolean(event.shiftKey), repeat: Boolean(event.repeat)};
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
            const marks = reviewMarks(message.marks || []);
            if (!application.pdfDocument || key === undefined || key !== documentKey) {
                const data = pending.data;
                if (!(data instanceof Uint8Array || data instanceof ArrayBuffer)) throw new Error('PDF review data is missing.');
                pending.data = undefined;
                highlights.set([], message.color, false);
                await application.open({data: data instanceof Uint8Array ? data : new Uint8Array(data), isEvalSupported: false});
                documentKey = key;
            }
            if (ticket === generation) highlights.set(marks, message.color, message.active !== false);
        }).catch(error => {
            if (ticket === generation) onError({type: 'review-pdf-error', document: key, error: error.message});
        });
        return loading;
    };
}
