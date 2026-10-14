export function createDecorations(vscode) {
  const fixed = { rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
  const types = {
    changed: vscode.window.createTextEditorDecorationType({ ...fixed,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground') }),
    rejected: vscode.window.createTextEditorDecorationType({ ...fixed,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground') }),
    point: vscode.window.createTextEditorDecorationType({ ...fixed, borderWidth: '0 0 0 2px', borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground') }),
    near: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.7' }),
    middle: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.4' }),
    far: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.22' }),
    context: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '.62' }),
    selected: vscode.window.createTextEditorDecorationType({ ...fixed, opacity: '1',
      border: '1px solid', borderRadius: '3px', borderColor: new vscode.ThemeColor('focusBorder'),
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground') })
  };
  const editors = new Map(), prepared = new WeakMap();
  let disposed = false, focused, enabled = true, reviewed = false;

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
    const { projection, edits } = state;
    const groups = { changed: [], rejected: [], point: [] };
    state.decorated = new Map();
    for (const span of state.spans.values()) {
      const edit = edits.get(span.id);
      if (!reviewed && ['accept', 'reject'].includes(state.data.decisions?.[span.id])) continue;
      const hover = changeHover(vscode, edit, projection.document.languageId);
      const decoration = {
        range: new vscode.Range(projection.document.positionAt(span.from), projection.document.positionAt(span.to)),
        hoverMessage: hover
      };
      state.decorated.set(span.id, decoration);
      groups[span.from === span.to ? 'point' : span.rejected ? 'rejected' : 'changed'].push(decoration);
    }
    return groups;
  }

  function paintFocus(editor, entry) {
    const { state } = entry, { projection } = state;
    if (!valid(state)) { erase(editor); return; }
    const id = focused?.file === projection.file ? focused.edit : undefined;
    const span = state.spans.get(id), context = state.contexts.get(id);
    if (!state.focusGroups || state.selected !== id) {
      const bands = context ? focusBands(projection.text, context.from, context.to, state.starts ??= lineStarts(projection.text))
        : { near: [], middle: [], far: [] };
      state.focusGroups = Object.fromEntries(Object.entries(bands).map(([kind, spans]) =>
        [kind, spans.map(([from, to]) => new vscode.Range(projection.document.positionAt(from), projection.document.positionAt(to)))]));
      state.focusGroups.context = [];
      state.focusGroups.selected = [];
      if (context && span) {
        for (const [from, to] of [[context.from, span.from], [span.to, context.to]]) {
          if (from < to) state.focusGroups.context.push(new vscode.Range(projection.document.positionAt(from), projection.document.positionAt(to)));
        }
        const [from, to] = visibleSpan(projection.text, span);
        if (from < to) state.focusGroups.selected.push({
          range: new vscode.Range(projection.document.positionAt(from), projection.document.positionAt(to)),
          hoverMessage: state.decorated.has(id) ? undefined : changeHover(vscode, state.edits.get(id), projection.document.languageId)
        });
      }
      state.selected = id;
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
    if (!state || !valid(state) || state.file !== file || state.revision !== data.revision || state.reviewed !== reviewed) {
      if (projection.revision !== data.revision || projection.document.getText() !== projection.text) {
        for (const editor of visible) erase(editor);
        return false;
      }
      const passages = new Map((projection.passages || []).map(span => [span.id, span]));
      const edits = new Map((file?.edits || []).map(edit => [edit.id, edit]));
      const spans = new Map(projection.ranges.filter(span => {
        const edit = edits.get(span.id);
        return edit && Number.isInteger(span.from) && Number.isInteger(span.to)
          && span.from >= 0 && span.to >= span.from && span.to <= projection.text.length
          && projection.text.slice(span.from, span.to) === (span.rejected ? edit.old : edit.new);
      }).map(span => [span.id, span]));
      const contexts = new Map(spans);
      for (const passage of file?.hunks || []) {
        const context = passages.get(passage.id);
        if (context) for (const edit of passage.edits) if (spans.has(edit.id)) contexts.set(edit.id, context);
      }
      state = { projection, data, file, revision: data.revision, version: projection.document.version,
        contexts, edits, spans, reviewed };
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

  function setReviewed(value) {
    if (disposed || value === reviewed) return;
    reviewed = value;
    prune();
    for (const state of new Set([...editors.values()].map(entry => entry.state))) {
      if (valid(state)) { state.changes = changesFor(state); state.reviewed = reviewed; state.focusGroups = undefined; }
    }
    for (const [editor, { state }] of editors) {
      if (valid(state)) paint(editor, state.changes);
      else erase(editor);
    }
    repaintFocus();
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

  return { update, focus, reveal, clear, dispose, setReviewed,
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

function changeHover(vscode, edit, language) {
  const hover = new vscode.MarkdownString();
  hover.isTrusted = false;
  if (!edit) return hover;
  for (const [label, text] of [['Original', edit.old], ['Proposed', edit.new]]) {
    hover.appendMarkdown(`**${label}**\n\n`);
    hover.appendCodeblock(text, language);
    hover.appendMarkdown('\n\n');
  }
  return hover;
}

// A deletion needs a visible hover target, while its review anchor stays empty.
function visibleSpan(text, { from, to }) {
  if (from !== to || !text.length) return [from, to];
  let after = from, before = from;
  while (after < text.length && /\s/u.test(text[after])) after++;
  while (before > 0 && /\s/u.test(text[before - 1])) before--;
  if (after < text.length && (!before || after - from <= from - before))
    return [after, after + (text.codePointAt(after) > 0xffff ? 2 : 1)];
  if (!before) return [from, to];
  const previous = text.charCodeAt(before - 1);
  return [before - (previous >= 0xdc00 && previous <= 0xdfff ? 2 : 1), before];
}
