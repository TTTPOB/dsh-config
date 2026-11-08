import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Plugin from '../plugins/word.mjs';

function config(input={}) {
  const result=Plugin.Config['~standard'].validate(input);assert.equal(result.issues,undefined);return result.value;
}
function register(t, settings, attachments={}) {
  const tools=new Map(),providers=new Map(),effects=[];
  Plugin.apply({tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
    skills:{registerProvider(create){const provider=create();providers.set(provider.name,provider);return()=>providers.delete(provider.name);}},
    attachments,effect(fn){effects.push(fn());}},settings);
  const dispose=()=>effects.splice(0).reverse().forEach(fn=>fn());t.after(dispose);
  return {tools,providers,dispose,call:(name,args={},signal=new AbortController().signal)=>tools.get(name).execute(args,{signal})};
}
function transport(t,respond) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const request={url:String(url),options,body:options.body===undefined?undefined:JSON.parse(options.body)};requests.push(request);
    const result=await respond(request);
    const payload=result?.error || new URL(url).pathname!=='/eval' ? result : {value:result};
    return new Response(JSON.stringify(payload),{status:result?.error?503:200,headers:{'content-type':'application/json'}});
  });return requests;
}

test('client dispatch quotes user strings and preserves original handler result envelopes',async()=>{
  const args={old_text:'close("x"); throw new Error("not code")',new_text:'line one\nline two'};
  const captured=[];
  const value={success:true,result:{replaced:1}};
  const fake={WordClientRuntime:{call:async(name,input)=>{captured.push({name,input});return value;}}};
  const run=Function('globalThis','return '+Plugin.clientCallExpression('edit_doc_text',args));
  assert.deepEqual(await run(fake),value);assert.deepEqual(captured,[{name:'edit_doc_text',input:args}]);
  await assert.rejects(run({}),/not loaded/);
});

test('native definitions forward their arguments and authentication without implicit retries',async t=>{
  const settings=config({helperUrl:'http://word.example.invalid:9999',helperToken:'test-only',autoHide:false});
  const requests=transport(t,request=>({code:request.body.code}));const f=register(t,settings);
  for(const definition of Plugin.clientToolDefinitions){
    const args={probe:definition.clientName};await f.call(definition.name,args);
    assert.equal(requests.at(-1).body.code,Plugin.clientCallExpression(definition.clientName,args));
  }
  assert.ok(requests.every(r=>r.url===new URL('/eval',settings.helperUrl).href));
  assert.ok(requests.every(r=>r.options.headers.authorization==='Bearer '+settings.helperToken));
  const count=requests.length;
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('connection lost after write');});
  await assert.rejects(f.call('word_execute_office_js',{code:'return 1;'}),/connection lost after write/);
  assert.equal(requests.length,count);
});

test('list creation discovers current host style names before dispatch, without a language assumption or cache',async t=>{
  let styles={bullet:'本机项目符号',number:'本机编号'};
  const received=[];
  const requests=transport(t,async request=>{
    if(new URL(request.url).pathname==='/word/list-styles') return styles;
    return Function('globalThis','return '+request.body.code)({WordClientRuntime:{call:async(name,args,options)=>{
      received.push({name,args,options});return {success:true};
    }}});
  });
  const f=register(t,config({autoHide:false}));
  const args={action:'create_list',anchor_text:'anchor',items:['first','second'],list_style:'number'};
  await f.call('word_edit_doc_list',args);
  assert.deepEqual(received.at(-1),{name:'edit_doc_list',args,options:{listStyles:styles}});
  styles={bullet:'Updated bullets',number:'Updated numbering'};
  await f.call('word_edit_doc_list',args);
  assert.deepEqual(received.at(-1).options,{listStyles:styles});
  assert.equal(requests.filter(r=>r.options.method==='GET').length,2);
  await f.call('word_edit_doc_list',{action:'insert_item',new_item_text:'third'});
  assert.deepEqual(received.at(-1).options,{});
  assert.equal(requests.filter(r=>r.options.method==='GET').length,2);
});

test('one queue serializes operations and recovers after a rejected write',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});let release;const wait=new Promise(resolve=>{release=resolve;});
  const requests=transport(t,async request=>{if(request.body.code.includes('first')){entered();await wait;return {error:{code:'write-failed',message:'partial write'}};}return 'second';});
  const f=register(t,config({autoHide:false}));
  const first=f.call('word_execute_office_js',{code:'return "first";'});const rejected=assert.rejects(first,/write-failed.*partial write/);await ready;
  const second=f.call('word_execute_office_js',{code:'return "second";'});assert.equal(requests.length,1);
  release();await rejected;assert.equal(await second,'second');assert.equal(requests.length,2);
});

test('auto-hide is one initial request and explicit show is not immediately hidden again',async t=>{
  const requests=transport(t,()=>({success:true}));const f=register(t,config());
  await f.call('word_verify_doc');await f.call('word_verify_doc');
  assert.equal(requests.filter(r=>r.body.code.includes('Office.addin.hide')).length,1);
  await f.call('word_pane_visibility',{visible:true});await f.call('word_verify_doc');
  assert.equal(requests.filter(r=>r.body.code.includes('Office.addin.hide')).length,1);
  assert.equal(requests.filter(r=>r.body.code.includes('Office.addin.showAsTaskpane')).length,1);
});

test('PDF export joins slices and closes the Office file on both success and failure',async()=>{
  let closed=0;let fail=false;
  const file={sliceCount:2,size:8,getSliceAsync(i,done){done(fail?{status:'failed',error:{message:'slice failure'}}:{status:'ok',value:{data:[...Buffer.from(i===0?'%PDF':'-abc')]}});},closeAsync(done){closed++;done({status:'ok'});}};
  const Office={AsyncResultStatus:{Succeeded:'ok'},FileType:{Pdf:'pdf'},context:{document:{getFileAsync(type,options,done){assert.equal(type,'pdf');done({status:'ok',value:file});}}}};
  class FileReader{readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result='data:application/pdf;base64,'+Buffer.from(bytes).toString('base64');this.onload();});}}
  const run=Function('Office','FileReader','Blob','return '+Plugin.pdfExpression());
  const value=await run(Office,FileReader,Blob);assert.equal(Buffer.from(value.base64,'base64').toString(),'%PDF-abc');assert.equal(closed,1);
  fail=true;await assert.rejects(run(Office,FileReader,Blob),/slice failure/);assert.equal(closed,2);
});

test('image insertion transports bytes and uses the requested Word range and dimensions',async()=>{
  const events=[];const image={load(){},width:50,height:20};
  const target={insertInlinePictureFromBase64(base64,location){events.push({base64,location});return image;}};
  const Word={run:fn=>fn({document:{getSelection:()=>target},sync:async()=>{}})};
  const run=Function('Word','return '+Plugin.imageExpression('YWJj','selection',{width:100}));
  assert.deepEqual(await run(Word),{inserted:true,width:100,height:20});assert.equal(image.lockAspectRatio,true);
  assert.deepEqual(events,[{base64:'YWJj',location:'Replace'}]);
});

test('native rendering returns an image part and cleans its temporary PDF directory',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'word-native-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const renderer=join(dir,'pdf-renderer');const marker=join(dir,'input-path');
  const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  writeFileSync(renderer,'#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(marker)+',args.at(-2));fs.writeFileSync(args.at(-1)+".png",Buffer.from('+JSON.stringify([...png])+'));\n',{mode:0o700});
  transport(t,()=>({base64:Buffer.from('%PDF-test').toString('base64')}));
  const saved=[];const image={attachmentId:'page-image',mediaType:'image/png',bytes:png.length,width:100,height:140};
  const f=register(t,config({autoHide:false,pdfRenderer:renderer}),{saveImage:async input=>{saved.push(input);return image;}});
  const value=await f.call('word_render_page',{page:2});assert.deepEqual(saved[0].data,png);
  assert.deepEqual(f.tools.get('word_render_page').output.render({},value)[1],{type:'image',attachment:image});
  const {readFileSync}=await import('node:fs');assert.equal(existsSync(readFileSync(marker,'utf8')),false);
  await assert.rejects(f.call('word_render_page',{page:0}),/one-based/);
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});

test('rasterizer rejects invalid PDF input and leaves no owned temporary directories',async()=>{
  const before=new Set(readdirSync(tmpdir()).filter(n=>n.startsWith('dsh-word-render-')));
  await assert.rejects(Plugin.renderPdfPage(config(),Buffer.from('not pdf').toString('base64'),1),/did not return a PDF/);
  const after=new Set(readdirSync(tmpdir()).filter(n=>n.startsWith('dsh-word-render-')));assert.deepEqual(after,before);
});

test('Zotero tools bind each action to the taskpane document and preserve item data and helper results',async t=>{
  let documentUrl='file:///C:/Documents/First%20paper.docx';
  const result={document:{url:documentUrl},fields:[{kind:'citation',code:'ADDIN ZOTERO_ITEM data',text:'(Example, 2024)'}],preferences:{style:'test-style'},refresh:{status:'pending'}};
  const settings=config({autoHide:false,helperToken:'synthetic-token'});
  const requests=transport(t,request=>new URL(request.url).pathname==='/eval'
    ? Function('Office','return '+request.body.code)({context:{document:{url:documentUrl}}}) : result);
  const f=register(t,settings);
  const items=[{uri:'http://zotero.org/users/123/items/ABCD1234',itemData:{id:'ABCD1234',type:'article-journal',title:'Synthetic fixture',author:[{family:'Example'}],issued:{'date-parts':[[2024]]},custom:{nested:true}},locator:'12–14',label:'page',prefix:'see ',suffix:', discussion',suppressAuthor:true}];
  const cases=[
    ['insert_citation',{items,anchor_text:'Unique anchor "quoted"',position:'after',style_id:'test-style'},true],
    ['insert_bibliography',{anchor_text:'References',position:'replace',refresh:false},false],
    ['refresh',{},undefined],['inspect',{},undefined],
    ['set_style',{style_id:'different-style'},true],
    ['insert_citation',{items,position:'selection',refresh:false},false],
    ['insert_bibliography',{position:'end'},true],
    ['set_style',{style_id:'different-style',refresh:false},false],
  ];
  for(const [action,args,refresh] of cases){
    documentUrl=documentUrl.replace('First','Current')+'x';
    assert.deepEqual(await f.call('word_zotero_'+action,args),result);
    const [evaluation,request]=requests.slice(-2);
    assert.equal(new URL(evaluation.url).pathname,'/eval');
    assert.equal(new URL(request.url).pathname,'/word/zotero');
    assert.equal(request.options.method,'POST');
    assert.equal(request.options.headers.authorization,'Bearer '+settings.helperToken);
    assert.deepEqual(request.body,{...args,action,documentUrl,...(refresh===undefined?{}:{refresh})});
  }
  documentUrl='';
  await f.call('word_zotero_inspect');
  assert.equal(requests.at(-1).body.documentUrl,'');
  const provider=[...f.providers.values()][0];
  assert.equal((await provider.get()).name,'word');
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});

test('Zotero writes are not retried after transport or helper failure and inspection remains available',async t=>{
  let failure='transport';let writes=0;
  const requests=transport(t,request=>{
    if(new URL(request.url).pathname==='/eval')return 'file:///C:/Documents/Bound.docx';
    if(request.body.action==='inspect')return {fields:[],refresh:{status:'unknown'}};
    writes++;
    if(failure==='transport')throw new Error('timeout after insertion');
    return {error:{code:'zotero-refresh-pending',message:'inspect before retrying'}};
  });
  const f=register(t,config({autoHide:false}));
  await assert.rejects(f.call('word_zotero_insert_bibliography'),/timeout after insertion/);
  assert.equal(writes,1);
  assert.deepEqual(await f.call('word_zotero_inspect'),{fields:[],refresh:{status:'unknown'}});
  failure='helper';
  await assert.rejects(f.call('word_zotero_set_style',{style_id:'fixture-style'}),/zotero-refresh-pending.*inspect before retrying/);
  assert.equal(writes,2);
  assert.equal(requests.length,6);
});

test('Zotero URL lookup failure prevents helper writes and cancellation prevents document access',async t=>{
  const requests=transport(t,()=>{throw new Error('taskpane unavailable');});
  const f=register(t,config({autoHide:false}));
  await assert.rejects(f.call('word_zotero_refresh'),/taskpane unavailable/);
  assert.equal(requests.length,1);assert.equal(new URL(requests[0].url).pathname,'/eval');
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await assert.rejects(f.call('word_zotero_inspect',{},controller.signal),/cancelled/);
  assert.equal(requests.length,1);
});

test('Zotero and existing Word tools share the selection queue',async t=>{
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});const wait=new Promise(resolve=>{release=resolve;});
  const requests=transport(t,async request=>{
    if(new URL(request.url).pathname==='/word/zotero'){entered();await wait;return {fields:[]};}
    return 'file:///C:/Documents/Bound.docx';
  });
  const f=register(t,config({autoHide:false}));
  const first=f.call('word_zotero_refresh');await ready;
  const second=f.call('word_verify_doc');assert.equal(requests.length,2);
  release();await first;await second;assert.equal(requests.length,3);
});
