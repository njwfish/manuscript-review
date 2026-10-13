export function createDecorations(vscode) {
  const fixed = { rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
  const types = {
    changed: vscode.window.createTextEditorDecorationType({ ...fixed,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground') }),
    rejected: vscode.window.createTextEditorDecorationType({ ...fixed,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground') }),
    point: vscode.window.createTextEditorDecorationType({ ...fixed, borderWidth: '0 0 0 2px', borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground') }),
    near: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.68' }),
    middle: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.4' }),
    far: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.2' })
  };
  const editors = new Map(), prepared = new WeakMap();
  let disposed = false, focused, enabled = true, removals = true;

  function paint(editor, groups) {
    for (const [kind, values] of Object.entries(groups)) editor.setDecorations(types[kind], values);
  }

  function erase(editor) {
    paint(editor, Object.fromEntries(Object.keys(types).map(kind => [kind, []])));
    editors.delete(editor);
  }

  function prune() {
    for (const editor of editors.keys()) {
      if (!vscode.window.visibleTextEditors.includes(editor)) editors.delete(editor);
    }
  }

  function valid(state) {
    return state.version === state.projection.document.version && state.revision === state.data.revision;
  }

  function changesFor(state) {
    const { projection, file } = state;
    const groups = { changed: [], rejected: [], point: [] };
    const edits = new Map((file?.edits || []).map(edit => [edit.id, edit]));
    for (const span of projection.ranges) {
      const edit = edits.get(span.id);
      if (!edit || !Number.isInteger(span.from) || !Number.isInteger(span.to)
        || span.from < 0 || span.to < span.from || span.to > projection.text.length) continue;
      if (projection.text.slice(span.from, span.to) !== (span.rejected ? edit.old : edit.new)) continue;
      const hover = new vscode.MarkdownString();
      hover.isTrusted = false;
      for (const [label, text] of [['Original', edit.old], ['Proposed', edit.new]]) {
        hover.appendMarkdown(`**${label}**\n\n`);
        hover.appendCodeblock(text, projection.document.languageId);
        hover.appendMarkdown('\n\n');
      }
      const decoration = {
        range: new vscode.Range(projection.document.positionAt(span.from), projection.document.positionAt(span.to)),
        hoverMessage: hover
      };
      if (removals && !span.rejected && edit.old) {
        decoration.renderOptions = { before: { contentText: edit.old.replace(/\s+/g, ' '),
          color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
          backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
          textDecoration: 'line-through', margin: '0 .3em 0 0' } };
      }
      groups[span.from === span.to ? 'point' : span.rejected ? 'rejected' : 'changed'].push(decoration);
    }
    return groups;
  }

  function paintFocus(editor, entry) {
    const { state } = entry, { projection } = state;
    if (!valid(state)) { erase(editor); return; }
    const context = focused?.file === projection.file ? state.contexts.get(focused.edit) : undefined;
    if (!state.focusGroups || state.context !== context) {
      const bands = context ? focusBands(projection.text, context.from, context.to, state.starts ??= lineStarts(projection.text))
        : { near: [], middle: [], far: [] };
      state.focusGroups = Object.fromEntries(Object.entries(bands).map(([kind, spans]) =>
        [kind, spans.map(([from, to]) => new vscode.Range(projection.document.positionAt(from), projection.document.positionAt(to)))]));
      state.context = context;
    }
    if (entry.focusGroups !== state.focusGroups) {
      paint(editor, state.focusGroups);
      entry.focusGroups = state.focusGroups;
    }
  }

  function update(projection, data) {
    if (disposed || !enabled) return false;
    prune();
    const visible = vscode.window.visibleTextEditors.filter(editor => editor.document === projection.document);
    if (!visible.length) return false;
    const file = data.files.find(file => file.path === projection.file);
    let state = prepared.get(projection);
    if (!state || !valid(state) || state.file !== file || state.revision !== data.revision || state.removals !== removals) {
      if (projection.revision !== data.revision || projection.document.getText() !== projection.text) {
        for (const editor of visible) erase(editor);
        return false;
      }
      const passages = new Map((projection.passages || []).map(span => [span.id, span]));
      const ids = new Set((file?.edits || []).map(edit => edit.id));
      const contexts = new Map(projection.ranges.filter(span => ids.has(span.id)).map(span => [span.id, span]));
      for (const passage of file?.hunks || []) {
        const context = passages.get(passage.id);
        if (context) for (const edit of passage.edits) if (ids.has(edit.id)) contexts.set(edit.id, context);
      }
      state = { projection, data, file, revision: data.revision, version: projection.document.version,
        contexts, removals };
      state.changes = changesFor(state);
      prepared.set(projection, state);
    }
    for (const editor of visible) {
      let entry = editors.get(editor);
      if (entry?.state !== state) {
        paint(editor, state.changes);
        entry = { state };
        editors.set(editor, entry);
      }
      paintFocus(editor, entry);
    }
    return true;
  }

  function repaintFocus() {
    prune();
    for (const [editor, entry] of editors) paintFocus(editor, entry);
  }

  function focus(file, edit) {
    if (disposed) return;
    focused = { file, edit };
    repaintFocus();
  }

  function reveal() {
    if (!focused) return;
    focused = undefined;
    repaintFocus();
  }

  function setRemovals(value) {
    if (disposed || value === removals) return;
    removals = value;
    prune();
    for (const state of new Set([...editors.values()].map(entry => entry.state))) {
      if (valid(state)) { state.changes = changesFor(state); state.removals = removals; }
    }
    for (const [editor, { state }] of editors) {
      if (valid(state)) paint(editor, state.changes);
      else erase(editor);
    }
  }

  function clear() {
    for (const editor of editors.keys()) erase(editor);
    focused = undefined;
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    for (const type of Object.values(types)) type.dispose();
  }

  return { update, focus, reveal, clear, dispose, setRemovals,
    setEnabled(value) { enabled = value; if (!enabled) clear(); } };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let low = 0, high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** Keep the selected lines clear; fade nearby lines before the rest of the file. */
export function focusBands(text, from, to, starts = lineStarts(text)) {
  const result = { near: [], middle: [], far: [] };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) return result;
  const first = lineAt(starts, from), last = lineAt(starts, Math.max(from, to - 1));
  for (const [kind, begin, end] of [
    ['far', 0, first - 5], ['middle', first - 5, first - 2], ['near', first - 2, first],
    ['near', last + 1, last + 3], ['middle', last + 3, last + 6], ['far', last + 6, starts.length]
  ]) {
    const start = starts[Math.max(0, begin)], stop = starts[Math.min(starts.length, end)] ?? text.length;
    if (start !== undefined && end > 0 && start < stop) result[kind].push([start, stop]);
  }
  return result;
}
