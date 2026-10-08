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
 const from=text.indexOf('Line 7');f.projection.ranges=[{id:'edit',from,to:from+6}];
 f.decorations.update(f.projection,f.data);f.decorations.focus('main.tex','edit');
 for(const editor of [f.first,f.split]){
  assert.equal(editor.decorations.get(f.types[3]).length,4);
  assert.equal(editor.decorations.get(f.types[4]).length,6);
  assert.equal(editor.decorations.get(f.types[5]).length,4);
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
 assert.deepEqual(bands.near,[[0,4],[14,19],[19,23]]);
 assert.deepEqual(bands.middle,[]);assert.deepEqual(bands.far,[]);
 for(const [from,to] of [[-1,3],[2,99],[4,3],[1.5,2]])assert.deepEqual(focusBands(text,from,to),{near:[],middle:[],far:[]});
});

test('hover retains exact original/proposed LaTeX as untrusted monospace code',()=>{
  const f=fixture();f.data.files[0].edits[0]={id:'edit',old:'Old \\alpha + x\n```',new:'New \\beta + y\n[link](command:run)'};
  f.decorations.update(f.projection,f.data);
  const hover=f.first.decorations.get(f.types[0])[0].hoverMessage;
  assert.equal(hover.isTrusted,false);
  assert.deepEqual(hover.blocks.filter(block=>'code' in block),[
    {code:'Old \\alpha + x\n```',language:'latex'},
    {code:'New \\beta + y\n[link](command:run)',language:'latex'}]);
  assert.equal(hover.blocks.filter(block=>block.markdown?.startsWith('**')).length,2);
  f.decorations.dispose();
});

test('rejected edits replace prior changed highlighting while retaining their exact hover',()=>{
  const f=fixture();f.decorations.update(f.projection,f.data);
  f.projection.ranges[0].rejected=true;f.decorations.update(f.projection,f.data);
  assert.deepEqual(f.first.decorations.get(f.types[0]),[]);
  assert.equal(f.first.decorations.get(f.types[1]).length,1);
  assert.equal(f.types[1].options.backgroundColor.id,'diffEditor.removedTextBackground');
  f.decorations.dispose();
});

test('deletions retain a zero-width marker and hover without inserting synthetic text',()=>{
  const f=fixture('🙂 Unchanged.');
  f.projection.ranges=[{id:'edit',from:3,to:3,rejected:false}];
  f.data.files[0].edits=[{id:'edit',old:'Removed words',new:''}];
  f.decorations.update(f.projection,f.data);
  const [point]=f.first.decorations.get(f.types[2]);
  assert.deepEqual(point.range.start,point.range.end);
  assert.equal(point.hoverMessage.blocks.find(block=>block.code==='Removed words').language,'latex');
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
