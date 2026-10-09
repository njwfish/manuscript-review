export function reviewMarks(value) {
    if (!Array.isArray(value)) throw new Error('PDF highlights need a list of page locations.');
    return value.map(mark => {
        if (!Number.isInteger(mark.page) || mark.page < 1) throw new Error('Invalid PDF highlight page.');
        if (mark.bounds == null) return {page: mark.page, bounds: null};
        const bounds = mark.bounds;
        if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(number => !Number.isFinite(number) || number < 0 || number > 1)
                || bounds[0] > bounds[2] || bounds[1] > bounds[3]) throw new Error('Invalid PDF highlight bounds.');
        return {page: mark.page, bounds: [...bounds]};
    });
}

/** Bounds are normalized in the PDF's original displayed orientation. */
export function viewportBounds(bounds, pageView) {
    const original = pageView.pdfPage.getViewport({scale: 1});
    const start = original.convertToPdfPoint(bounds[0] * original.width, bounds[1] * original.height);
    const end = original.convertToPdfPoint(bounds[2] * original.width, bounds[3] * original.height);
    const [x, y] = pageView.viewport.convertToViewportPoint(...start);
    const [right, bottom] = pageView.viewport.convertToViewportPoint(...end);
    return {left: Math.min(x, right), top: Math.min(y, bottom), width: Math.abs(right - x), height: Math.abs(bottom - y)};
}

export function createHighlights(application) {
    const {pdfViewer, eventBus} = application;
    let marks = [], color = 'added', frame, focused = false;

    function draw() {
        frame = undefined;
        for (const overlay of document.querySelectorAll('.review-highlights')) overlay.remove();
        for (const page of new Set(marks.map(mark => mark.page))) {
            const view = pdfViewer.getPageView(page - 1);
            if (!view?.pdfPage) continue;
            const overlay = document.createElement('div');
            overlay.className = 'review-highlights';
            for (const mark of marks.filter(mark => mark.page === page && mark.bounds)) {
                const rectangle = viewportBounds(mark.bounds, view), box = document.createElement('span');
                box.className = 'review-highlight ' + color;
                for (const [name, value] of Object.entries(rectangle)) box.style[name] = value + 'px';
                overlay.append(box);
            }
            view.div.append(overlay);
        }
        if (focused) focus();
    }

    function redraw() {
        frame ??= requestAnimationFrame(draw);
    }

    function focus() {
        const selected = marks[0];
        if (!selected) { focused = false; return; }
        if (!pdfViewer.pagesCount || application.isInitialViewSet === false) return;
        if (selected.page > pdfViewer.pagesCount) { focused = false; return; }
        pdfViewer.currentPageNumber = selected.page;
        const view = pdfViewer.getPageView(selected.page - 1);
        if (!view?.pdfPage) return;
        const scroll = pdfViewer.container;
        const page = view.div.getBoundingClientRect(), container = scroll.getBoundingClientRect();
        const rectangle = selected.bounds ? viewportBounds(selected.bounds, view) : {left: 0, top: 0, width: 0, height: 0};
        scroll.scrollTop += page.top - container.top + rectangle.top - scroll.clientHeight * .35;
        if (rectangle.width && rectangle.width < scroll.clientWidth) {
            scroll.scrollLeft += page.left - container.left + rectangle.left - (scroll.clientWidth - rectangle.width) / 2;
        }
        focused = false;
    }

    const events = ['pagerendered', 'scalechanging', 'rotationchanging', 'pagesinit', 'documentinit'];
    for (const event of events) eventBus.on(event, redraw);
    const observer = new ResizeObserver(redraw);
    observer.observe(pdfViewer.container);

    return {
        set(value, nextColor = 'added', active = true) {
            marks = reviewMarks(value);
            color = nextColor === 'removed' ? 'removed' : 'added';
            focused = active;
            redraw();
        },
        dispose() {
            if (frame !== undefined) cancelAnimationFrame(frame);
            for (const event of events) eventBus.off(event, redraw);
            observer.disconnect();
        }
    };
}
