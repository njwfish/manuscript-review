export function createDecorations(vscode) {
  const fixed={rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed};
  const types={
    changed:vscode.window.createTextEditorDecorationType({...fixed,
      backgroundColor:new vscode.ThemeColor('diffEditor.insertedTextBackground')}),
    rejected:vscode.window.createTextEditorDecorationType({...fixed,
      backgroundColor:new vscode.ThemeColor('diffEditor.removedTextBackground')}),
    point:vscode.window.createTextEditorDecorationType({...fixed,borderWidth:'0 0 0 2px',borderStyle:'solid',
      borderColor:new vscode.ThemeColor('editorGutter.modifiedBackground')})
  };
  const editors=new Set();
  let disposed=false;

  function paint(editor,groups) {
    for(const [kind,type] of Object.entries(types))editor.setDecorations(type,groups[kind]);
  }

  function update(projection,data) {
    if(disposed)return false;
    const visible=vscode.window.visibleTextEditors.filter(editor=>editor.document===projection.document);
    if(!visible.length)return false;
    if(projection.revision!==data.revision||projection.document.getText()!==projection.text) {
      for(const editor of visible) {
        paint(editor,{changed:[],rejected:[],point:[]});editors.delete(editor);
      }
      return false;
    }
    const file=data.files.find(file=>file.path===projection.file);
    const edits=new Map((file?.edits||[]).map(edit=>[edit.id,edit]));
    const groups={changed:[],rejected:[],point:[]};
    for(const span of projection.ranges) {
      const edit=edits.get(span.id);
      if(!edit||!Number.isInteger(span.from)||!Number.isInteger(span.to)
        ||span.from<0||span.to<span.from||span.to>projection.text.length)continue;
      const hover=new vscode.MarkdownString();
      hover.isTrusted=false;
      for(const [label,text] of [['Original',edit.old],['Proposed',edit.new]]) {
        hover.appendMarkdown(`**${label}**\n\n`);
        hover.appendCodeblock(text,projection.document.languageId);
        hover.appendMarkdown('\n\n');
      }
      const decoration={range:new vscode.Range(projection.document.positionAt(span.from),projection.document.positionAt(span.to)),
        hoverMessage:hover};
      groups[span.from===span.to?'point':span.rejected?'rejected':'changed'].push(decoration);
    }
    for(const editor of visible){paint(editor,groups);editors.add(editor);}
    return true;
  }

  function clear() {
    for(const editor of editors)paint(editor,{changed:[],rejected:[],point:[]});
    editors.clear();
  }

  function dispose() {
    if(disposed)return;
    clear();disposed=true;
    for(const type of Object.values(types))type.dispose();
  }
  return {update,clear,dispose};
}
