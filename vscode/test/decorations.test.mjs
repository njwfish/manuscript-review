import assert from 'node:assert/strict';
import test from 'node:test';
import {createDecorations,focusBands} from '../src/decorations.mjs';

class Position {constructor(line,character){Object.assign(this,{line,character});}}
class Range {constructor(start,end){Object.assign(this,{start,end});}}
class ThemeColor {constructor(id){this.id=id;}}
class MarkdownString {
  constructor(){this.blocks=[];}
  appendMarkdown(text){this.blocks.push({markdown:text});return this;}
  appendCodeblock(text,language){this.blocks.push({code:text,language});return this;}
}

function document(text,file='main.tex') {
  return {text,version:1,languageId:'latex',uri:{toString:()=>`file:///manuscript/${file}`},
    getText(){return this.text;},positionAt(offset){
      const lines=this.text.slice(0,offset).split('\n');return new Position(lines.length-1,lines.at(-1).length);}};
}

function fixture(text='🙂 New words.') {
  const doc=document(text),types=[];
  const editor=document=>({document,decorations:new Map(),setDecorations(type,values){this.decorations.set(type,values);}});
  const first=editor(doc),split=editor(doc),unrelated=editor(document('Another source','other.tex'));
  const vscode={Range,ThemeColor,MarkdownString,DecorationRangeBehavior:{ClosedClosed:1},window:{
    visibleTextEditors:[first,split,unrelated],createTextEditorDecorationType(options){
      const type={options,dispose(){this.disposed=true;}};types.push(type);return type;}}};
  const decorations=createDecorations(vscode);
  const projection={document:doc,file:'main.tex',text,revision:5,ranges:[{id:'edit',from:3,to:12,rejected:false}]};
  const data={revision:5,files:[{path:'main.tex',edits:[{id:'edit',old:'Old words',new:'New words'}]}]};
  return {decorations,vscode,types,doc,first,split,unrelated,projection,data};
}

test('uses exact projected UTF-16 spans in every visible split without decorating another file',()=>{
  const f=fixture();assert.equal(f.decorations.update(f.projection,f.data),true);
  for(const editor of [f.first,f.split]) {
    const [change]=editor.decorations.get(f.types[0]);
    assert.deepEqual(change.range,new Range(new Position(0,3),new Position(0,12)));
    assert.equal(editor.document.getText(),'🙂 New words.');
  }
  assert.equal(f.unrelated.decorations.size,0);
  assert.equal(f.types[0].options.backgroundColor.id,'diffEditor.insertedTextBackground');
  assert.equal(f.types.every(type=>type.options.rangeBehavior===1),true);
  f.decorations.dispose();
});

test('focused review fades context symmetrically and entering the source restores every line',()=>{
 const text=Array.from({length:15},(_,i)=>`Line ${i}`).join('\n'),f=fixture(text);
 f.data.files[0].edits[0].new='Line 7';const from=text.indexOf('Line 7');f.projection.ranges=[{id:'edit',from,to:from+6}];
 f.decorations.update(f.projection,f.data);f.decorations.focus('main.tex','edit');
 for(const editor of [f.first,f.split]){
  assert.equal(editor.decorations.get(f.types[3]).length,2);
  assert.equal(editor.decorations.get(f.types[4]).length,2);
  assert.equal(editor.decorations.get(f.types[5]).length,2);
  assert.equal(editor.decorations.get(f.types[3]).some(range=>range.start.line===7),false);
 }
 f.decorations.reveal();
 assert.equal(f.types.slice(3).every(type=>f.first.decorations.get(type).length===0),true);
 assert.equal(f.first.decorations.get(f.types[0]).length,1);assert.equal(f.doc.getText(),text);
 f.decorations.dispose();
});

test('a multiline change keeps every changed line clear and malformed focus spans leave the file visible',()=>{
 const text='One\nTwo\nThree\nFour\nFive';
 const bands=focusBands(text,4,14);
 assert.deepEqual(bands.near,[[0,4],[14,23]]);
 assert.deepEqual(bands.middle,[]);assert.deepEqual(bands.far,[]);
 for(const [from,to] of [[-1,3],[2,99],[4,3],[1.5,2]])assert.deepEqual(focusBands(text,from,to),{near:[],middle:[],far:[]});
});


test('rejected edits replace prior changed highlighting while retaining their exact hover',()=>{
  const f=fixture();f.decorations.update(f.projection,f.data);
  f.doc.text='🙂 Old words.';f.doc.version++;f.projection.text=f.doc.text;f.projection.ranges[0].rejected=true;f.decorations.update(f.projection,f.data);
  assert.deepEqual(f.first.decorations.get(f.types[0]),[]);
  assert.equal(f.first.decorations.get(f.types[1]).length,1);
  assert.equal(f.types[1].options.backgroundColor.id,'diffEditor.removedTextBackground');
  f.decorations.dispose();
});

test('deletions retain a zero-width marker without injecting source text or a popup',()=>{
  const f=fixture('🙂 Unchanged.');
  f.projection.ranges=[{id:'edit',from:3,to:3,rejected:false}];
  f.data.files[0].edits=[{id:'edit',old:'Removed words',new:''}];
  f.decorations.update(f.projection,f.data);
  const [point]=f.first.decorations.get(f.types[2]);
  assert.deepEqual(point.range.start,point.range.end);
  assert.equal(point.hoverMessage,undefined);
  assert.equal(f.types[2].options.before,undefined);assert.equal(f.types[2].options.after,undefined);
  assert.equal(f.doc.getText(),'🙂 Unchanged.');
  f.decorations.dispose();
});

test('a changed dirty buffer clears its obsolete ranges rather than clamping old offsets',()=>{
  const f=fixture();f.decorations.update(f.projection,f.data);
  f.doc.text='🙂 Short.';f.doc.version++;
  assert.equal(f.decorations.update(f.projection,f.data),false);
  assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
  assert.equal(f.unrelated.decorations.size,0);
  f.decorations.dispose();
});

test('focused deletions use a visible adjacent glyph at paragraph breaks and EOF',()=>{
 for(const [text,offset,start,end] of [['🙂\n\nNext.',2,0,2],['\n\nNext.',0,2,3],['Last.\n\n',7,4,5]]){
  const f=fixture(text);f.projection.ranges=[{id:'edit',from:offset,to:offset}];
  f.data.files[0].edits=[{id:'edit',old:'Deleted paragraph.',new:''}];
  f.decorations.update(f.projection,f.data);f.decorations.focus('main.tex','edit');
  assert.deepEqual(f.first.decorations.get(f.types[7])[0].range,new Range(f.doc.positionAt(start),f.doc.positionAt(end)));
  assert.equal(f.projection.ranges[0].from,offset);assert.equal(f.projection.ranges[0].to,offset);
  assert.equal(f.doc.getText(),text);f.decorations.dispose();
 }
});

test('a mismatched review revision clears stale highlights',()=>{
  const f=fixture();f.decorations.update(f.projection,f.data);f.data.revision++;
  assert.equal(f.decorations.update(f.projection,f.data),false);
  assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
  f.decorations.dispose();
});

test('invalid spans and removed edit identities produce no guessed highlights',()=>{
  const f=fixture();f.projection.ranges=[
    {id:'edit',from:-1,to:2},{id:'edit',from:2,to:99},{id:'edit',from:5,to:3},
    {id:'edit',from:1.5,to:3},{id:'missing',from:3,to:12}];
  f.decorations.update(f.projection,f.data);
  assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
  f.decorations.dispose();
});

test('unreviewed files clear former highlights and clear/dispose remove all owned decorations',()=>{
  const f=fixture();f.decorations.update(f.projection,f.data);f.data.files=[];
  f.decorations.update(f.projection,f.data);
  assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
  f.data.files=[{path:'main.tex',edits:[{id:'edit',old:'Old',new:'New'}]}];
  f.decorations.update(f.projection,f.data);f.decorations.clear();
  assert.equal(f.types.every(type=>f.split.decorations.get(type).length===0),true);
  f.decorations.dispose();assert.equal(f.types.every(type=>type.disposed),true);
  assert.equal(f.decorations.update(f.projection,f.data),false);
});

test('a projection for a closed document does not decorate a reopened instance with the same URI',()=>{
  const f=fixture();f.first.document=document('🙂 New words.');f.split.document=f.first.document;
  f.decorations.update(f.projection,f.data);
  assert.equal(f.first.decorations.size,0);assert.equal(f.split.decorations.size,0);
  f.decorations.dispose();
});


test('decided changes become plain source and reviewed markup is an explicit display choice',()=>{
 const f=fixture();f.data.decisions={edit:'accept'};
 f.decorations.update(f.projection,f.data);
 assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
 f.decorations.setReviewed(true);assert.equal(f.first.decorations.get(f.types[0]).length,1);
 f.decorations.setReviewed(false);assert.equal(f.first.decorations.get(f.types[0]).length,0);
 f.doc.text='🙂 Old words.';f.doc.version++;f.projection={...f.projection,text:f.doc.text,ranges:[{id:'edit',from:3,to:12,rejected:true}]};
 f.data.decisions={edit:'reject'};f.data.revision++;f.projection.revision=f.data.revision;
 f.decorations.update(f.projection,f.data);
 assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
 f.decorations.setReviewed(true);assert.equal(f.first.decorations.get(f.types[1]).length,1);
 assert.equal(f.doc.getText(),'🙂 Old words.');f.decorations.dispose();
});

test('a selected change stands out inside a long wrapped passage without synthetic text',()=>{
 const f=fixture('Before New words after.');f.data.files[0].hunks=[{id:'passage',edits:f.data.files[0].edits}];
 f.projection.ranges=[{id:'edit',from:7,to:16}];f.projection.passages=[{id:'passage',from:0,to:23}];
 f.decorations.update(f.projection,f.data);f.decorations.focus('main.tex','edit');
 const selected=f.first.decorations.get(f.types[7])[0];
 assert.deepEqual(selected.range,new Range(new Position(0,7),new Position(0,16)));
 assert.equal(f.types[7].options.opacity,'1');assert.equal(f.types[7].options.borderColor.id,'focusBorder');
 assert.equal(f.first.decorations.get(f.types[6]).length,2);
 assert.equal(f.first.decorations.get(f.types[0])[0].renderOptions,undefined);
 f.decorations.reveal();assert.equal(f.types.slice(3).every(type=>f.first.decorations.get(type).length===0),true);
 f.decorations.dispose();
});

test('a projection onto another saved wording never paints it as the displayed proposal',()=>{
 const f=fixture('🙂 My wording.');f.projection.ranges[0].to=13;
 f.decorations.update(f.projection,f.data);assert.equal(f.first.decorations.get(f.types[0]).length,0);
 f.decorations.focus('main.tex','edit');assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
 f.decorations.dispose();
});

test('navigation reuses all change decorations and paints only bounded focus ranges across splits',t=>{
 const words=Array.from({length:1000},(_,i)=>`Proposed ${i}`),text=words.join('\n'),f=fixture(text);
 let from=0;
 f.data.files[0].edits=words.map((word,i)=>({id:String(i),old:`Original ${i}`,new:word}));
 f.projection.ranges=words.map((word,i)=>{const span={id:String(i),from,to:from+word.length};from+=word.length+1;return span;});
 f.decorations.update(f.projection,f.data);
 const changed=f.first.decorations.get(f.types[0]);
 const reads=t.mock.method(f.doc,'getText'),positions=t.mock.method(f.doc,'positionAt');
 const first=t.mock.method(f.first,'setDecorations'),split=t.mock.method(f.split,'setDecorations');
 for(let i=100;i<200;i++)f.decorations.focus('main.tex',String(i));
 assert.equal(reads.mock.callCount(),0);
 assert.ok(positions.mock.callCount()<=1800);
 for(const editor of [f.first,f.split]){
  assert.equal(editor.decorations.get(f.types[0]),changed);
  assert.equal(f.types.slice(3).every(type=>editor.decorations.get(type).length<=2),true);
 }
 for(const spy of [first,split])assert.equal(spy.mock.calls.every(call=>f.types.slice(3).includes(call.arguments[0])),true);
 const calls=first.mock.callCount();
 f.decorations.focus('main.tex','199');f.decorations.update(f.projection,f.data);
 assert.equal(first.mock.callCount(),calls);assert.equal(reads.mock.callCount(),0);
 f.decorations.dispose();
});

test('focus distinguishes neighboring edits while keeping their passage visible',t=>{
 const f=fixture('Before\nOne\nTwo\nThree\nAfter');
 f.data.files[0].edits=[{id:'one',old:'First',new:'One'},{id:'two',old:'Second',new:'Two'}];
 f.data.files[0].hunks=[{id:'passage',edits:f.data.files[0].edits}];
 f.projection.ranges=[{id:'one',from:7,to:10},{id:'two',from:11,to:14}];
 f.projection.passages=[{id:'passage',from:7,to:21}];
 f.decorations.update(f.projection,f.data);f.decorations.focus('main.tex','one');
 const ranges=f.first.decorations.get(f.types[3]);
 assert.deepEqual(ranges.map(range=>range.start.line),[0,4]);
 const calls=t.mock.method(f.first,'setDecorations');
 f.decorations.focus('main.tex','two');
 assert.equal(calls.mock.callCount(),5);
 assert.deepEqual(f.first.decorations.get(f.types[3]),ranges);
 const selected=f.first.decorations.get(f.types[7])[0];
 assert.equal(selected.range.start.line,2);assert.equal(selected.range.end.line,2);
 f.data.files=[];f.decorations.update(f.projection,f.data);
 assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
 f.decorations.dispose();
});

test('a newly visible split gets cached highlights without repainting existing editors',t=>{
 const f=fixture();f.vscode.window.visibleTextEditors=[f.first];
 f.decorations.update(f.projection,f.data);
 const calls=t.mock.method(f.first,'setDecorations'),reads=t.mock.method(f.doc,'getText');
 f.vscode.window.visibleTextEditors.push(f.split);f.decorations.update(f.projection,f.data);
 assert.equal(calls.mock.callCount(),0);assert.equal(reads.mock.callCount(),0);
 assert.equal(f.split.decorations.get(f.types[0]),f.first.decorations.get(f.types[0]));
 f.decorations.dispose();
});

test('disabled reviewed-display changes and restored source versions invalidate cached decoration state',()=>{
 const f=fixture();f.decorations.update(f.projection,f.data);
 f.decorations.setEnabled(false);f.decorations.setReviewed(true);
 f.decorations.setEnabled(true);f.decorations.update(f.projection,f.data);
 assert.equal(f.first.decorations.get(f.types[0])[0].renderOptions,undefined);
 f.doc.text='Changed source';f.doc.version++;
 f.decorations.focus('main.tex','edit');
 assert.equal(f.types.every(type=>f.first.decorations.get(type).length===0),true);
 f.doc.text=f.projection.text;f.doc.version++;
 assert.equal(f.decorations.update(f.projection,f.data),true);
 assert.equal(f.first.decorations.get(f.types[0]).length,1);
 f.decorations.dispose();
});

test('continuous focus ranges preserve exact line coverage at newline and file boundaries',()=>{
 const text='First\n\nThird\r\nFourth\nFifth\nSixth\nSeventh\nEighth\nNinth\nTenth\n';
 const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
 for(let from=0;from<=text.length;from++)for(let to=from;to<=text.length;to++){
  const first=starts.findLastIndex(start=>start<=from),last=starts.findLastIndex(start=>start<Math.max(from+1,to));
  const bands=focusBands(text,from,to);
  assert.equal(Object.values(bands).every(spans=>spans.length<=2),true);
  for(let line=0;line<starts.length;line++){
   const end=starts[line+1]??text.length;if(end===starts[line])continue;
   const distance=line<first?first-line:line>last?line-last:0;
   const expected=distance===0?undefined:distance<=2?'near':distance<=5?'middle':'far';
   const shown=Object.keys(bands).find(kind=>bands[kind].some(([a,b])=>a<=starts[line]&&b>=end));
   assert.equal(shown,expected,`span ${from}:${to}, line ${line}`);
  }
 }
});
