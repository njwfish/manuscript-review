import {EditorState, StateField, Compartment} from '@codemirror/state';
import {EditorView, Decoration, keymap, lineNumbers, drawSelection} from '@codemirror/view';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {search, searchKeymap, closeSearchPanel} from '@codemirror/search';

const highlights = StateField.define({
  create: () => [],
  update: (value, transaction) => {
    value = value.map(range => ({...range, from: transaction.changes.mapPos(range.from, -1), to: transaction.changes.mapPos(range.to, 1)}));
    if(transaction.selection){
      const point=transaction.selection.main.head,selected=value.find(range=>range.from<=point&&point<=range.to);
      if(selected)value=value.map(range=>({...range,current:range.id===selected.id}));
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, ranges => Decoration.set(ranges.filter(range => range.to > range.from).map(range =>
    Decoration.mark({inclusive: true, class: 'review-change' + (range.rejected ? ' review-rejected' : '') + (range.current ? ' review-current' : '')}).range(range.from, range.to)), true))
});

// Editing only: review state, source versions, drafts, and writes stay in the app.
export function createSourceState(text, ranges, position, extensions = []) {
  const separator = text.includes('\r\n') && !text.replaceAll('\r\n', '').includes('\n') ? '\r\n' : '\n';
  const offset = value => {
    value = Math.max(0, Math.min(value, text.length));
    return separator === '\r\n' ? value - (text.slice(0, value).split('\r\n').length - 1) : value;
  };
  return EditorState.create({
    doc: text,
    selection: {anchor: offset(position)},
    extensions: [EditorState.lineSeparator.of(separator), highlights.init(() => ranges.map(range => ({...range, from: offset(range.from), to: offset(range.to)}))), ...extensions]
  });
}

export function createEditor(parent, {text, ranges, position, onChange, onSelect, onSave, onClose}) {
  const editable = new Compartment();
  const view = new EditorView({
    parent,
    state: createSourceState(text, ranges, position, [
        history(), lineNumbers(), drawSelection(), EditorView.lineWrapping,
        editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        search({top: true}),
        keymap.of([
          {key: 'Mod-Enter', run: () => {onSave(); return true;}},
          {key: 'Mod-s', run: () => {onSave(); return true;}},
          {key: 'Escape', run: view => {if(!closeSearchPanel(view))onClose(); return true;}},
          ...searchKeymap, ...historyKeymap, ...defaultKeymap
        ]),
        EditorView.contentAttributes.of({'aria-label': 'File source', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off'}),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChange(update.state.sliceDoc());
          }
          if (update.selectionSet) {
            const point=update.state.selection.main.head,selected=update.state.field(highlights).find(range=>range.from<=point&&point<=range.to);
            if(selected)onSelect(selected.id);
          }
        }),
        EditorView.theme({
          '&': {height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)'},
          '&.cm-focused': {outline: 'none'},
          '.cm-scroller': {fontFamily: 'var(--mono)', fontSize: '14px', lineHeight: '1.75', overflow: 'auto'},
          '.cm-content': {padding: '16px 0', caretColor: 'var(--ink)'},
          '.cm-line': {padding: '0 20px 0 12px'},
          '.cm-gutters': {backgroundColor: 'var(--paper)', color: 'var(--faint)', border: 'none', fontSize: '11px'},
          '.cm-lineNumbers .cm-gutterElement': {padding: '0 10px 0 12px'},
          '.cm-cursor': {borderLeftColor: 'var(--ink)'},
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {backgroundColor: 'var(--selection)'},
          '.cm-panels': {backgroundColor: 'var(--bg)', color: 'var(--ink)', borderColor: 'var(--line)'},
          '.cm-textfield': {backgroundColor: 'var(--field)', color: 'var(--ink)', borderColor: 'var(--line)'},
          '.cm-button': {backgroundImage: 'none', backgroundColor: 'var(--control)', color: 'var(--ink)', borderColor: 'var(--line)'},
          '.review-change': {backgroundColor: 'var(--insbg)', color: 'var(--ins)'},
          '.review-rejected': {backgroundColor: 'var(--delbg)', color: 'var(--del)'},
          '.review-current': {borderBottom: '2px solid var(--accent)'},
        })
      ])
  });
  view.dispatch({effects: EditorView.scrollIntoView(view.state.selection.main.head, {y: 'center'})});
  view.focus();
  return {
    focus: () => view.focus(),
    text: () => view.state.sliceDoc(),
    destroy: () => view.destroy(),
    setReadOnly: value => view.dispatch({effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)])}),
    goTo: id => {const range=view.state.field(highlights).find(range=>range.id===id);if(range){view.dispatch({selection:{anchor:range.from},effects:EditorView.scrollIntoView(range.from,{y:'center'})});view.focus();}}
  };
}
