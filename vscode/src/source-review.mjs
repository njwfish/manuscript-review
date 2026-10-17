import path from 'node:path';

export const originalScheme = 'manuscript-review-original';

/** Reverse only undecided, validated edits in a read-only display copy. */
export function originalSource(projection, data) {
  const file = data.files.find(file => file.path === projection.file);
  const edits = new Map(file?.edits.map(edit => [edit.id, edit]));
  const pending = projection.ranges.filter(span =>
    !['accept', 'reject'].includes(data.decisions?.[span.id])
    && Number.isInteger(span.from) && Number.isInteger(span.to)
    && span.from >= 0 && span.to >= span.from && span.to <= projection.text.length
    && edits.has(span.id) && !span.rejected
    && projection.text.slice(span.from, span.to) === edits.get(span.id).new
  ).sort((a, b) => a.from - b.from);
  let cursor = 0, text = '';
  for (const span of pending) {
    if (span.from < cursor) throw new Error('Review changes overlap in this source.');
    text += projection.text.slice(cursor, span.from) + edits.get(span.id).old;
    cursor = span.to;
  }
  return text + projection.text.slice(cursor);
}

/** The modified side is the real manuscript; the original side is display only. */
export function createSourceReview(vscode) {
  const changed = new vscode.EventEmitter(), entries = new Map(), settings = new Map();
  const inlineSettings = {renderSideBySide: false, 'experimental.useTrueInlineView': true, codeLens: true};
  let documents = new WeakMap(), generation = 0, disposed = false, changing = Promise.resolve();
  const provider = vscode.workspace.registerTextDocumentContentProvider(originalScheme, {
    onDidChange: changed.event,
    provideTextDocumentContent: uri => entries.get(uri.toString())?.text || ''
  });

  function update(projection, data) {
    if (disposed || projection.document.uri.scheme !== 'file'
      || projection.document.version !== projection.documentVersion
      || projection.text !== projection.document.getText() || projection.revision !== data.revision) return;
    const uri = vscode.Uri.from({scheme: originalScheme, authority: data.id, path: '/' + projection.file});
    const text = originalSource(projection, data), key = uri.toString(), previous = entries.get(key);
    entries.set(key, {text, uri, document: projection.document});
    documents.set(projection.document, uri);
    if (previous?.text !== text) changed.fire(uri);
  }

  async function configure(document) {
    const config = vscode.workspace.getConfiguration('diffEditor', document);
    const {Global, Workspace, WorkspaceFolder} = vscode.ConfigurationTarget;
    const languageScopes = [['workspaceFolderLanguageValue', WorkspaceFolder],
      ['workspaceLanguageValue', Workspace], ['globalLanguageValue', Global]];
    const scopes = [['workspaceFolderValue', WorkspaceFolder], ['workspaceValue', Workspace], ['globalValue', Global]];
    for (const [key, value] of Object.entries(inlineSettings)) {
      if (config.get(key) === value) continue;
      const inspected = config.inspect(key);
      const override = languageScopes.find(([field]) => inspected?.[field] !== undefined);
      const language = Boolean(override || inspected?.defaultLanguageValue !== undefined);
      const [field, target] = override || (language ? ['globalLanguageValue', Global]
        : scopes.find(([field]) => inspected?.[field] !== undefined) || ['globalValue', Global]);
      const folder = target === WorkspaceFolder ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() : '';
      const identity = [key, target, language ? document.languageId : '', folder].join('/');
      if (!settings.has(identity)) settings.set(identity, {config, key, field, target, language, previous: inspected?.[field]});
      await config.update(key, value, target, language);
    }
  }

  async function restoreSettings() {
    for (const {config, key, field, target, language, previous} of settings.values()) {
      // Preferences changed by the author while reviewing belong to the author.
      if (config.inspect(key)?.[field] === inlineSettings[key]) await config.update(key, previous, target, language);
    }
    settings.clear();
  }

  function serialize(action) {
    const pending = changing.catch(() => {}).then(action);
    changing = pending;
    return pending;
  }
  const owned = tab => tab?.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === originalScheme;

  function column(editor) {
    if (!editor) return;
    if (editor.viewColumn) return editor.viewColumn;
    const key = editor.document.uri.toString();
    const contains = group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key
      || owned(tab) && tab.input.modified.toString() === key);
    const active = vscode.window.tabGroups.activeTabGroup;
    return (contains(active) ? active : vscode.window.tabGroups.all.find(contains))?.viewColumn;
  }

  function show(editor, {preserveFocus = false} = {}) {
    const uri = documents.get(editor.document);
    if (!uri) return Promise.resolve(editor);
    const ticket = ++generation, source = editor.document, version = source.version;
    const viewColumn = column(editor), selection = editor.selection;
    return serialize(async () => {
      const valid = () => !disposed && ticket === generation && source.version === version
        && documents.get(source)?.toString() === uri.toString();
      if (!valid()) return;
      const group = vscode.window.tabGroups.all.find(group => group.viewColumn === viewColumn);
      const plain = group?.tabs.filter(tab => tab.input instanceof vscode.TabInputText
        && tab.input.uri.toString() === source.uri.toString());
      const active = () => {
        const group = vscode.window.tabGroups.activeTabGroup, tab = group.activeTab;
        return valid() && group.viewColumn === viewColumn && owned(tab) && tab.input.original.toString() === uri.toString();
      };
      try {
        await configure(source);
        if (!valid()) return;
        await vscode.commands.executeCommand('vscode.diff', uri, source.uri, path.basename(source.uri.fsPath),
          {viewColumn, preview: false, preserveFocus});
        if (!valid() || !preserveFocus && !active()) return;
        if (!preserveFocus) {
          await vscode.commands.executeCommand('workbench.action.compareEditor.focusSecondarySide');
          if (!active()) return;
        }
        const current = vscode.window.visibleTextEditors.find(item => item.document === source
          && (item.viewColumn === viewColumn || item.viewColumn === undefined));
        if (!current) return;
        current.selection = selection;
        if (plain?.length) await vscode.window.tabGroups.close(plain, true);
        if (valid()) return current;
      } catch (error) {
        await restoreSettings();
        throw error;
      }
    });
  }

  function hide(preferred = editor()) {
    const ticket = ++generation;
    const location = preferred && {document: preferred.document, column: column(preferred),
      selection: preferred.selection, version: preferred.document.version};
    documents = new WeakMap();
    // Clear stale markup immediately, including during a pending view transition.
    for (const entry of entries.values()) {
      entry.text = entry.document.getText();
      changed.fire(entry.uri);
    }
    return serialize(async () => {
      if (disposed || ticket !== generation) return;
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(owned)
        .map(tab => ({tab, viewColumn: group.viewColumn})));
      const selected = item => location?.document.uri.toString() === item.tab.input.modified.toString()
        && location.column === item.viewColumn;
      // Reopen the current source last so tab conversion retains its location.
      tabs.sort((a, b) => Number(selected(a)) - Number(selected(b)));
      for (const {tab, viewColumn} of tabs) {
        if (disposed || ticket !== generation) return;
        const source = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === tab.input.modified.toString()
          && (editor.viewColumn === viewColumn || editor.viewColumn === undefined));
        const current = selected({tab, viewColumn}) ? location : undefined;
        const selection = current?.selection || source?.selection, version = current?.version ?? source?.document.version;
        const document = await vscode.workspace.openTextDocument(tab.input.modified);
        if (disposed || ticket !== generation) return;
        const editor = await vscode.window.showTextDocument(document, {viewColumn, preserveFocus: true});
        if (disposed || ticket !== generation) return;
        if (selection && document.version === version) {
          editor.selection = selection;
          editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        await vscode.window.tabGroups.close(tab, true);
      }
      if (location && tabs.length && !tabs.some(selected) && ticket === generation && !disposed) {
        const current = await vscode.window.showTextDocument(location.document, {viewColumn: location.column, preserveFocus: true});
        if (ticket === generation && location.document.version === location.version) current.selection = location.selection;
      }
      if (ticket === generation) {
        entries.clear();
        await restoreSettings();
      }
    });
  }

  function editor() {
    const active = vscode.window.activeTextEditor;
    if (active?.document.uri.scheme !== originalScheme) return active;
    const group = vscode.window.tabGroups.activeTabGroup, tab = group.activeTab;
    if (owned(tab)) return vscode.window.visibleTextEditors.find(editor =>
      editor.document.uri.toString() === tab.input.modified.toString()
      && (editor.viewColumn === undefined || editor.viewColumn === group.viewColumn));
  }
  return {update, show, hide, editor, column, dispose() {
    disposed = true;
    generation++;
    provider.dispose();
    changed.dispose();
    entries.clear();
    return changing.catch(() => {}).then(restoreSettings);
  }};
}
