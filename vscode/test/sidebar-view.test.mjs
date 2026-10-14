import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const script=await readFile(new URL('../src/sidebar.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/sidebar.mjs',import.meta.url),'utf8');
const draft={id:'input-a',file:'main.tex',line:3,body:'Initial text',history:[],saved:false,editing:false};

function fixture(){
 const posts=[],events={},elements=new Map();
 const document={activeElement:undefined,getElementById:id=>elements.get(id),
  querySelectorAll:()=>[...elements.values()].filter(element=>['button','input','textarea'].includes(element.tag)),
  createElement:tag=>makeElement(tag),addEventListener:(type,handler)=>events['document:'+type]=handler};
 function makeElement(tag,id){
  const listeners={},attributes={};
  return {tag,id,style:{},value:'',scrollHeight:80,hidden:false,
   setAttribute(name,value){attributes[name]=value;},getAttribute:name=>attributes[name],
   addEventListener:(type,handler)=>listeners[type]=handler,
   fire(type,event={}){let prevented=false;listeners[type]?.({...event,preventDefault(){prevented=true;}});return prevented;},
   append(...children){this.children=children;},replaceChildren(...children){this.children=children;this.replaced=(this.replaced||0)+1;},
   focus(){document.activeElement=this;},dataset:{}};
 }
 for(const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))elements.set(match[2],makeElement(match[1],match[2]));
 const context={document,window:{addEventListener:(type,handler)=>events[type]=handler},acquireVsCodeApi:()=>({postMessage:value=>posts.push(value)})};
 vm.runInNewContext(script,context);
 const message=data=>events.message({data});
 const state=(comment=draft)=>message({type:'state',state:{agent:'Codex',model:'CLI default',comment}});
 return {posts,document,state,message,element:id=>elements.get(id),key:event=>{let prevented=false;events['document:keydown']({...event,preventDefault(){prevented=true;}});return prevented;}};
}

test('sidebar refresh preserves typed text and caret while updating discussion history',()=>{
 const f=fixture();f.state();const input=f.element('comment-input');
 input.value='Unfinished source comment';input.selectionStart=input.selectionEnd=5;input.fire('input');
 assert.equal(f.posts.at(-1).action,'commentDraft');assert.equal(f.posts.at(-1).text,input.value);
 f.state({...draft,body:'Old server text',history:[{author:'Agent',body:'A new response'}]});
 assert.equal(input.value,'Unfinished source comment');assert.equal(input.selectionStart,5);
 assert.equal(f.document.activeElement,input);assert.equal(f.element('comment-history').children[0].children[1].textContent,'A new response');
 f.state({...draft,id:'input-b',body:'Other draft'});assert.equal(input.value,'Other draft');
});

test('comment keyboard actions distinguish send, save, newlines, IME, and Escape after Tab',()=>{
 const f=fixture();f.state();const input=f.element('comment-input');
 assert.equal(input.fire('keydown',{key:'Enter'}),true);assert.equal(f.posts.at(-1).action,'commentSend');
 assert.equal(input.fire('keydown',{key:'Enter',metaKey:true}),true);assert.equal(f.posts.at(-1).action,'commentSave');
 assert.equal(input.fire('keydown',{key:'Enter',ctrlKey:true}),true);assert.equal(f.posts.at(-1).action,'commentSave');
 const count=f.posts.length;
 assert.equal(input.fire('keydown',{key:'Enter',shiftKey:true}),false);
 assert.equal(input.fire('keydown',{key:'Enter',isComposing:true}),false);assert.equal(f.posts.length,count);
 f.element('comment-save').focus();assert.equal(f.key({key:'Escape'}),true);assert.equal(f.posts.at(-1).action,'commentClose');
});

test('failed Send and provider selection restore typing focus without changing a draft',()=>{
 const f=fixture();f.state();const input=f.element('comment-input');
 input.value='Still typing';
 f.element('comment-send').focus();f.message({type:'busy',busy:true});assert.equal(input.disabled,true);
 f.message({type:'error',message:'Save failed'});f.message({type:'busy',busy:false});
 assert.equal(f.document.activeElement,input);assert.equal(input.disabled,false);assert.equal(input.value,'Still typing');
 f.element('comment-agent').focus();f.message({type:'busy',busy:true});
 f.state({...draft,body:'Old text'});f.message({type:'busy',busy:false});
 assert.equal(f.document.activeElement,input);assert.equal(input.value,'Still typing');
 f.message({type:'busy',busy:true});f.state(null);f.message({type:'busy',busy:false});
 assert.equal(f.element('composer').hidden,true);
});

test('pending review decisions stay visible after agent wording has already reached source',()=>{
 const f=fixture();
 f.message({type:'state',state:{agent:'Codex',model:'CLI default',applied:true,progress:'0 of 2 reviewed'}});
 assert.equal(f.element('progress').textContent,'0 of 2 reviewed');
 f.message({type:'state',state:{agent:'Codex',model:'CLI default',applied:true}});
 assert.equal(f.element('progress').textContent,'Applied');
});
