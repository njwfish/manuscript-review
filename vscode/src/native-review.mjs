/** One source selection drives decisions, keyboard review and PDF navigation. */
export function createNativeReview(vscode, {
  runtime, enabled, sourceEdits, delivery, onOpen, onChange, onFocus, onMode,
  onComment, onError, isPDFActive = () => false
}) {
  let projections = new WeakMap(), indexes = new WeakMap();
  let focused, lastFocus, sourceEditor, commentFocus, focusMode = false;
  let actions = Promise.resolve(), navigationEpoch = 0, generation = 0;
  let openingSource = false, disposed = false, lensKey, lensDocument;
  const changed = new vscode.EventEmitter();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60);
  status.command = 'manuscriptReview.focusedReview';
  const sameSource = (left, right) => left?.document === right?.document && left?.viewColumn === right?.viewColumn;
  const activeEditor = () =>
    vscode.window.activeTextEditor || ((isPDFActive() || commentFocus)
      && sourceEditor?.document && !sourceEditor.document.isClosed ? sourceEditor : undefined);
  const current = (nearest = false) => {
    if (disposed || !enabled()) return;
    const editor = activeEditor(),
      projection = projections.get(editor?.document),
      review = runtime()?.review;
    if (
      !projection ||
      projection.data.id !== review?.id ||
      projection.data.revision !== review.revision
    )
      return;
    if (projection.version === undefined || projection.version !== editor.document.version) {
      projection.exact = editor.document.getText() === projection.source.text;
      projection.version = editor.document.version;
    }
    if (!projection.exact) return;
    const cursor = editor.document.offsetAt(editor.selection.active);
    const pinned = focused?.file === projection.source.file && projection.ranges.get(focused.edit);
    const span =
      (pinned && pinned.from <= cursor && cursor <= pinned.to ? pinned : undefined) ||
      projection.source.ranges.find((span) => span.from <= cursor && cursor <= span.to) ||
      (nearest &&
        (projection.source.ranges.find((span) => span.from >= cursor) ||
          projection.source.ranges.at(-1)));
    return span ? { editor, ...projection, span } : undefined;
  };
  function reviewIndex(data) {
    const cached = indexes.get(data);
    if (cached) return cached;
    const edits = [],
      positions = new Map();
    let done = 0;
    for (const file of data.files)
      for (const edit of file.edits) {
        positions.set(edit.id, edits.length);
        edits.push({ file: file.path, edit: edit.id });
        if (data.decisions[edit.id] && data.decisions[edit.id] !== 'pending') done++;
      }
    const index = {
      edits,
      positions,
      progress: { total: edits.length, done, complete: done === edits.length }
    };
    indexes.set(data, index);
    return index;
  }
  function setMode(value) {
    if (focusMode === value) return;
    focusMode = value;
    onMode?.(value);
  }
  function select(selected) {
    if (!selected) return;
    sourceEditor = selected.editor;
    focused = { file: selected.source.file, edit: selected.span.id };
    const key = [selected.data.id, selected.data.revision, focused.file, focused.edit, focusMode].join('/');
    if (key !== lastFocus) {
      lastFocus = key;
      onFocus?.(focused.file, focused.edit, selected, focusMode);
    }
  }
  async function open(message) {
    openingSource = true;
    try {
      return (sourceEditor = await onOpen(message));
    } finally {
      openingSource = false;
    }
  }
  function refresh() {
    const exact = current();
    const key = exact
      ? [
          exact.data.id,
          exact.data.revision,
          exact.source.file,
          exact.span.id,
          exact.span.from,
          exact.span.to,
          exact.data.decisions[exact.span.id],
          focusMode
        ].join('/')
      : undefined;
    if (key !== lensKey || exact?.editor.document !== lensDocument) {
      lensKey = key;
      lensDocument = exact?.editor.document;
      changed.fire();
    }
    const selected = exact || current(true);
    if (!selected) {
      status.hide();
      return;
    }
    const progress = reviewIndex(selected.data).progress;
    status.text = (focusMode ? 'Review ' : '') + (progress.complete ? 'Reviewed' : progress.done + '/' + progress.total);
    status.tooltip = progress.complete
      ? selected.data.applied
        ? 'All changes reviewed and saved.'
        : 'All changes reviewed. Apply review in the sidebar.'
      : focusMode
        ? 'A accept, S reject, D previous, F next, C comment. E or Escape edits the source.'
        : 'Review manuscript changes';
    status.show();
  }
  async function move(direction, { undecided = false } = {}) {
    const ticket = generation;
    await sourceEdits().flush();
    if (disposed || ticket !== generation) return false;
    const service = runtime(),
      review = service.review.id,
      live = current(true),
      data = live?.data || (await service.data());
    if (disposed || ticket !== generation) return false;
    if (
      runtime() !== service ||
      service.review.id !== review ||
      service.review.revision !== data.revision
    )
      throw new Error('The review changed. Navigate its current changes.');
    const { edits: all, positions } = reviewIndex(data);
    const selected = current(),
      anchor = selected ? { file: selected.source.file, edit: selected.span.id } : undefined;
    let index = positions.get(anchor?.edit);
    if (index === undefined && live) {
      const cursor = live.editor.document.offsetAt(live.editor.selection.active);
      const after = all.findIndex(item => item.file > live.source.file
        || item.file === live.source.file && live.ranges.get(item.edit)?.from > cursor);
      index = after < 0 ? all.length - 1 : after - 1;
      if (direction < 0) index++;
    }
    index ??= direction > 0 ? -1 : 0;
    for (let step = 1; step <= all.length; step++) {
      const at = (index + direction * step + all.length) % all.length;
      const item = all[at];
      if (undecided && ['accept', 'reject'].includes(data.decisions[item.edit])) continue;
      const target = live?.source.file === item.file && live.ranges.get(item.edit);
      if (target) {
        const point = live.editor.document.positionAt(target.from);
        live.editor.selection = new vscode.Selection(point, point);
        live.editor.revealRange(
          live.editor.selection,
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      } else await open({ file: item.file, edit: item.edit });
      if (disposed || ticket !== generation) return false;
      if (
        runtime() !== service ||
        service.review.id !== review ||
        service.review.revision !== data.revision
      )
        throw new Error('The review changed while opening this change.');
      setMode(true);
      focused = item;
      const latest = current();
      if (latest?.span.id === item.edit) select(latest);
      refresh();
      return true;
    }
    if (undecided) { setMode(false); lastFocus = undefined; onFocus?.(); }
    refresh();
    return false;
  }
  async function begin(entry) {
    const ticket = generation;
    if (entry)
      await open({
        file: entry.file,
        ...(entry.target?.kind === 'edit' ? { edit: entry.target.id } : {}),
        ...(entry.id ? { comment: entry.id } : {})
      });
    if (disposed || ticket !== generation) return;
    const selected = current(true);
    if (selected) {
      setMode(true);
      focused = { file: selected.source.file, edit: selected.span.id };
      const position = selected.editor.document.positionAt(selected.span.from);
      selected.editor.selection = new vscode.Selection(position, position);
      selected.editor.revealRange(
        selected.editor.selection,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
      select(selected);
      refresh();
      return;
    }
    await move(1, { undecided: true });
  }
  async function decide(id, revision, file, edit, value, scope = 'edit') {
    try {
      const service = runtime(),
        selected = current(),
        epoch = navigationEpoch,
        version = selected?.editor.document.version;
      if (
        !selected ||
        selected.data.id !== id ||
        selected.data.revision !== revision ||
        selected.source.file !== file ||
        selected.span.id !== edit
      )
        throw new Error('The source comparison changed. Choose its current edit.');
      await delivery().flush();
      await sourceEdits().flush();
      const latest = current();
      if (
        runtime() !== service ||
        !latest ||
        latest.data.id !== id ||
        latest.data.revision !== revision ||
        latest.source.file !== file ||
        latest.span.id !== edit ||
        latest.editor !== selected.editor ||
        latest.source.text !== selected.source.text ||
        selected.editor.document.version !== version ||
        selected.editor.document.isDirty
      )
        throw new Error('Save your source edits before deciding this change.');
      const source = selected.data.files.find((item) => item.path === file),
        group = source?.edits.find((item) => item.id === edit);
      const before = selected.editor.document.getText(),
        { from, to } = selected.span;
      if (
        !group ||
        !['accept', 'reject', 'reset'].includes(value) ||
        !['edit', 'passage', 'file'].includes(scope)
      )
        throw new Error('Choose a current source change.');
      if (![group.old, group.new].includes(before.slice(from, to)))
        throw new Error(
          'The editor differs from this proposal. Save it before deciding the change.'
        );
      const targets = {
        edit: [group],
        passage: source.hunks.find(passage => passage.edits.some(item => item.id === edit))?.edits || [],
        file: source.edits
      }[scope];
      if (!targets.length) throw new Error('The passage changed. Select its current edit.');
      const decisions = { ...selected.data.decisions };
      for (const target of targets) {
        if (value === 'reset') delete decisions[target.id];
        else decisions[target.id] = value;
      }
      setMode(true);
      await service.request('/save', { revision, decisions, comments: selected.data.comments });
      if (runtime() !== service || service.review.id !== id)
        throw new Error(
          'The decision was saved in its original review. Return there to update its source.'
        );
      await delivery().refresh({ force: true });
      await onChange();
      if (value !== 'reset' && epoch === navigationEpoch) await move(1, { undecided: true });
      else select(current());
    } catch (error) {
      onError(error);
    } finally {
      refresh();
    }
  }
  function decideCurrent(value, scope) {
    const selected = current();
    if (!selected) throw new Error('Select a current manuscript change first.');
    return decide(
      selected.data.id,
      selected.data.revision,
      selected.source.file,
      selected.span.id,
      value,
      scope
    );
  }
  function edit() {
    generation++;
    navigationEpoch++;
    commentFocus = undefined;
    setMode(false);
    lastFocus = undefined;
    onFocus?.();
    refresh();
    return sourceEditor;
  }
  function enqueue(action) {
    const ticket = generation,
      review = runtime()?.review?.id;
    const pending = actions
      .catch(() => {})
      .then(() => {
        if (!disposed && ticket === generation && runtime()?.review?.id === review) return action();
      });
    actions = pending;
    return pending;
  }
  const subscriptions = [
    changed,
    status,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: 'file' }, { scheme: 'manuscript-review-source' }],
      {
        onDidChangeCodeLenses: changed.event,
        provideCodeLenses(document) {
          const selected = current();
          if (!selected || selected.editor.document !== document) return [];
          const point = document.positionAt(selected.span.from),
            range = new vscode.Range(point, point);
          const decision = selected.data.decisions[selected.span.id];
          const shortcut = (label, key) => focusMode ? `${label} ${key}` : label;
          const controls = [
            ['accept', 'Accept', 'Accepted', 'A'],
            ['reject', 'Reject', 'Rejected', 'S']
          ].map(([value, label, chosen, key]) => new vscode.CodeLens(range, {
            title: decision === value ? chosen : shortcut(label, key),
            command: 'manuscriptReview.decideSource',
            arguments: [selected.data.id, selected.data.revision, selected.source.file, selected.span.id, value]
          }));
          for (const [command, label, key] of [
            ['previousChange', 'Back', 'D'], ['nextChange', 'Next', 'F'], ['commentChange', 'Comment', 'C']
          ]) controls.push(new vscode.CodeLens(range, { title: shortcut(label, key), command: 'manuscriptReview.' + command }));
          controls.push(new vscode.CodeLens(range, {
            title: focusMode ? 'Edit E' : 'Review',
            command: focusMode ? 'manuscriptReview.editSource' : 'manuscriptReview.focusedReview'
          }));
          if (decision) controls.push(new vscode.CodeLens(range, {
            title: shortcut('Reset', 'U'), command: 'manuscriptReview.resetChange'
          }));
          return controls;
        }
      }
    ),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== activeEditor()) return;
      if (event?.kind === vscode.TextEditorSelectionChangeKind.Mouse && (!focusMode || !current())) {
        focused = undefined;
        edit();
      } else if ([vscode.TextEditorSelectionChangeKind.Keyboard, vscode.TextEditorSelectionChangeKind.Mouse].includes(event?.kind)) navigationEpoch++;
      const selected = current();
      if (selected) select(selected);
      refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      const editor = vscode.window.activeTextEditor;
      if (commentFocus && editor && !sameSource(editor, commentFocus.editor)) edit();
      if (!current(true) && !isPDFActive() && !openingSource && !commentFocus) edit();
      refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== activeEditor()?.document) return;
      if (
        event?.reason === vscode.TextDocumentChangeReason.Undo ||
        event?.reason === vscode.TextDocumentChangeReason.Redo ||
        event.contentChanges?.length && !delivery()?.ownsChange(event.document)
      )
        edit();
      refresh();
    }),
    vscode.commands.registerCommand('manuscriptReview.decideSource', (...args) =>
      enqueue(() => decide(...args))
    )
  ];
  return {
    begin: (entry) => enqueue(() => begin(entry)),
    move: (...args) => enqueue(() => move(...args)),
    edit,
    decide: (...args) => enqueue(() => decideCurrent(...args)),
    comment: async () => {
      const selected = current();
      if (!selected) throw new Error('Select a current change first.');
      const resume = focusMode || Boolean(commentFocus?.resume&&commentFocus.epoch === navigationEpoch);
      edit();
      const pending = { review: selected.data.id, file: selected.source.file,
        edit: selected.span.id, epoch: navigationEpoch, editor: selected.editor, resume, version:selected.editor.document.version,
        point:selected.editor.document.offsetAt(selected.editor.selection.active) };
      commentFocus = pending;
      const thread = await onComment(selected);
      if (pending === commentFocus && pending) {
        pending.thread = thread;
      }
      return thread;
    },
    holdComment(thread,document) {
      if(commentFocus&&!commentFocus.thread){
        commentFocus.thread=thread;
        commentFocus.point=document.offsetAt(commentFocus.editor.selection.active);
        commentFocus.version=document.version;
        return;
      }
      const active=activeEditor();
      const editor=active?.document===document?active:vscode.window.visibleTextEditors.find(editor=>editor.document===document);
      if(!editor)return;
      const resume=commentFocus?.thread===thread&&commentFocus.epoch===navigationEpoch&&commentFocus.resume;
      edit();sourceEditor=editor;
      commentFocus={thread,review:runtime()?.review?.id,editor,epoch:navigationEpoch,resume,
        version:document.version,point:document.offsetAt(editor.selection.active),file:focused?.file,edit:focused?.edit};
    },
    async finishComment(thread, prepare) {
      const pending = commentFocus;
      const owns = () => !disposed && pending && (!pending.resume||enabled()) && pending === commentFocus
        && pending.thread === thread && pending.epoch === navigationEpoch
        && runtime()?.review?.id === pending.review && sameSource(activeEditor(), pending.editor);
      const ready = () => {
        const selected = current();
        return owns() && selected?.source.file === pending.file && selected.span.id === pending.edit;
      };
      if(!pending?.resume){
        const unchanged=()=>owns()&&pending.editor.document.version===pending.version
          &&pending.editor.document.offsetAt(pending.editor.selection.active)===pending.point;
        if(!unchanged()||!await prepare(unchanged)||!unchanged())return false;
        commentFocus=undefined;return true;
      }
      if (!owns() || !await prepare(ready) || !ready()) return false;
      const selected = current();
      if (selected?.source.file !== pending.file || selected.span.id !== pending.edit) return false;
      commentFocus = undefined;
      setMode(true);
      select(selected);
      refresh();
      return true;
    },
    selection() {
      const selected = current(true);
      return selected
        ? {
            file: selected.source.file,
            target: { id: selected.span.id, kind: 'edit' },
            source: true
          }
        : undefined;
    },
    update(source, data) {
      indexes.delete(data);
      projections.set(source.document, {
        source,
        data,
        ranges: new Map(source.ranges.map((span) => [span.id, span]))
      });
      select(current());
      refresh();
    },
    clear() {
      generation++;
      navigationEpoch++;
      projections = new WeakMap();
      indexes = new WeakMap();
      focused = lastFocus = sourceEditor = commentFocus = undefined;
      setMode(false);
      refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      generation++;
      for (const subscription of subscriptions) subscription.dispose();
      projections = new WeakMap();
      indexes = new WeakMap();
    }
  };
}
