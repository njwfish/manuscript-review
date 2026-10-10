export function createDecorations(vscode) {
  const fixed={rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed};
  const types={
    changed:vscode.window.createTextEditorDecorationType({...fixed,
      backgroundColor:new vscode.ThemeColor('diffEditor.insertedTextBackground')}),
    rejected:vscode.window.createTextEditorDecorationType({...fixed,
      backgroundColor:new vscode.ThemeColor('diffEditor.removedTextBackground')}),
    point:vscode.window.createTextEditorDecorationType({...fixed,borderWidth:'0 0 0 2px',borderStyle:'solid',
      borderColor:new vscode.ThemeColor('editorGutter.modifiedBackground')}),
    near:vscode.window.createTextEditorDecorationType({...fixed,opacity:'.68'}),
    middle:vscode.window.createTextEditorDecorationType({...fixed,opacity:'.4'}),
    far:vscode.window.createTextEditorDecorationType({...fixed,opacity:'.2'})
  };
  const editors=new Map();
  let disposed=false,focused,enabled=true;

  function paint(editor,groups) {
    for(const [kind,type] of Object.entries(types))editor.setDecorations(type,groups[kind]||[]);
  }

  function update(projection,data) {
    if(disposed||!enabled)return false;
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
    const selected=focused?.file===projection.file&&edits.has(focused.edit)&&projection.ranges.find(span=>span.id===focused.edit);
    if(selected){
      const bands=focusBands(projection.text,selected.from,selected.to);
      for(const [kind,spans] of Object.entries(bands))groups[kind]=spans.map(([from,to])=>new vscode.Range(projection.document.positionAt(from),projection.document.positionAt(to)));
    }
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
    for(const editor of visible){paint(editor,groups);editors.set(editor,{projection,data});}
    return true;
  }

  function clear() {
    for(const editor of editors.keys())paint(editor,{});
    editors.clear();focused=undefined;
  }

  function repaint(){for(const {projection,data} of [...editors.values()])update(projection,data);}
  function focus(file,edit){focused={file,edit};repaint();}
  function reveal(){if(!focused)return;focused=undefined;repaint();}

  function dispose() {
    if(disposed)return;
    clear();disposed=true;
    for(const type of Object.values(types))type.dispose();
  }
  return {update,focus,reveal,clear,dispose,setEnabled(value){enabled=value;if(!enabled)clear();}};
}

/** Keep the selected lines clear; fade nearby lines before the rest of the file. */
export function focusBands(text,from,to){
 const result={near:[],middle:[],far:[]};
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>text.length)return result;
 const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
 const first=starts.findLastIndex(start=>start<=from),last=starts.findLastIndex(start=>start<Math.max(from+1,to));
 for(let line=0;line<starts.length;line++){
  const distance=line<first?first-line:line>last?line-last:0;
  if(!distance)continue;
  const end=starts[line+1]??text.length;if(starts[line]===end)continue;
  result[distance<=2?'near':distance<=5?'middle':'far'].push([starts[line],end]);
 }
 return result;
}
