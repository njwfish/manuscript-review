const keys = new Set(['a', 's', 'd', 'f', 'u', 'c', 'r', 'v', 't', 'g', 'e']);

export function reviewKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
    if (!keys.has(event.key?.toLowerCase())) return;
    return {type: 'review-pdf-key', key: event.key, shiftKey: Boolean(event.shiftKey), repeat: Boolean(event.repeat)};
}

export function reviewMessage(event, origin, parent) {
    if (event.source === parent && event.origin === origin && event.data?.type === 'review-pdf') return event.data;
}
