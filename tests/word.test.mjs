import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, definitions, settled } from './office-catalog-fixtures.mjs';
import * as Plugin from '../plugins/word.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function binaryFixture(t, bytes=Buffer.from([0,255,34,128,10,92])) {
  const directory=await mkdtemp(join(tmpdir(),'word-binary-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=join(directory,'input.bin');
  await writeFile(filePath,bytes);
  return {directory,filePath,bytes};
}

function config(input={}) {
  const result=Plugin.Config['~standard'].validate(input);assert.equal(result.issues,undefined);return result.value;
}
function register(t, settings, attachments={}) {
  const tools=new Map(),providers=new Map(),effects=[];
  Plugin.apply({tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}},
    skills:{registerProvider(create){const provider=create();providers.set(provider.name,provider);return()=>providers.delete(provider.name);}},
    attachments,effect(fn){effects.push(fn());}},settings);
  const ready=settled();
  const dispose=()=>effects.splice(0).reverse().forEach(fn=>fn());t.after(dispose);
  return {tools,providers,dispose,call:(name,args={},signal=new AbortController().signal,sessionId)=>ready.then(()=>tools.get(name).execute(args,{signal,...(sessionId === undefined ? {} : {agent:{session:{id:sessionId}}})}))};
}
function transport(t,respond) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (new URL(url).pathname === '/catalog') return new Response(JSON.stringify(catalog('Word')));
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
  for(const definition of definitions('Word')){
    const args={probe:definition.clientName};await f.call(definition.name,args);
    assert.equal(requests.at(-1).body.code,Plugin.clientCallExpression(definition.clientName,args));
  }
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

test('image insertion transports bytes and uses the requested Word range and dimensions',async()=>{
  const events=[];const image={load(){},width:50,height:20};
  const target={insertInlinePictureFromBase64(base64,location){events.push({base64,location});return image;}};
  const Word={run:fn=>fn({document:{getSelection:()=>target},sync:async()=>{}})};
  const run=Function('Word','return '+Plugin.imageExpression('YWJj','selection',{width:100}));
  assert.deepEqual(await run(Word),{inserted:true,width:100,height:20});assert.equal(image.lockAspectRatio,true);
  assert.deepEqual(events,[{base64:'YWJj',location:'Replace'}]);
});

test('Office code receives binary files without changing logged path-only arguments',async t=>{
  const fixture=await binaryFixture(t), empty=join(fixture.directory,'empty.bin');
  await writeFile(empty,Buffer.alloc(0));
  const code='return {image:files.image,template:files.模板,empty:files.$empty};';
  const args=Object.freeze({code,files:Object.freeze({image:fixture.filePath,模板:fixture.filePath,$empty:empty})});
  const before=JSON.stringify(args),captured=[];
  transport(t,request=>Function('globalThis','return '+request.body.code)({WordClientRuntime:{call:async(name,input)=>{
    captured.push({name,input});
    return new (Object.getPrototypeOf(async function(){}).constructor)(input.code)();
  }}}));
  const f=register(t,config({autoHide:false}));
  const result=await f.call('word_execute_office_js',args);
  assert.deepEqual(result,{image:fixture.bytes.toString('base64'),template:fixture.bytes.toString('base64'),empty:''});
  assert.equal(JSON.stringify(args),before);
  assert.deepEqual(Object.keys(captured[0].input),['code']);
  assert.equal(captured[0].name,'execute_office_js');
  assert.ok(!JSON.stringify(args).includes(fixture.bytes.toString('base64')));
  assert.deepEqual(await f.call('word_execute_office_js',{code:'return files;',files:{}}),{});
});

test('Office binary inputs reject invalid identifiers, relative paths and missing files before transport',async t=>{
  const fixture=await binaryFixture(t);
  const requests=transport(t,()=>null),f=register(t,config({autoHide:false}));
  for(const key of ['bad-name','9image','image.path','']){
    await assert.rejects(f.call('word_execute_office_js',{code:'return 1;',files:{[key]:fixture.filePath}}),/Invalid files identifier/);
  }
  for(const files of [null,[],42]) await assert.rejects(f.call('word_execute_office_js',{code:'return 1;',files}),/files must map/);
  for(const path of ['relative.bin',42]) await assert.rejects(f.call('word_execute_office_js',{code:'return 1;',files:{image:path}}),/files.image must be an absolute/);
  const missing=join(fixture.directory,'missing.bin');
  await assert.rejects(f.call('word_execute_office_js',{code:'return 1;',files:{image:missing}}),error=>{
    assert.match(error.message,/Cannot read files.image/);assert.ok(error.message.includes(missing));return true;
  });
  assert.equal(requests.length,0);
});

test('image tool reads local bytes, preserves arguments and rejects missing paths without transport',async t=>{
  const fixture=await binaryFixture(t),events=[];
  const image={width:20,height:30,load(){}};
  const Word={run:fn=>fn({document:{getSelection:()=>({insertInlinePictureFromBase64(bytes,where){events.push({bytes,where});return image;}})},sync:async()=>{}})};
  const requests=transport(t,request=>Function('Word','return '+request.body.code)(Word));
  const f=register(t,config({autoHide:false}));
  const args=Object.freeze({filePath:fixture.filePath,where:'selection',width:70});
  assert.deepEqual(await f.call('word_insert_image',args),{inserted:true,width:args.width,height:30});
  assert.deepEqual(events,[{bytes:fixture.bytes.toString('base64'),where:'Replace'}]);
  const count=requests.length;
  await assert.rejects(f.call('word_insert_image',{}),/filePath is required/);
  await assert.rejects(f.call('word_insert_image',{base64:fixture.bytes.toString('base64')}),/filePath is required/);
  await assert.rejects(f.call('word_insert_image',{filePath:join(fixture.directory,'missing.bin')}),/ENOENT/);
  assert.equal(requests.length,count);
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
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});

test('Zotero writes are not retried after transport or helper failure and inspection remains available',async t=>{
  let failure='transport';let writes=0;
  transport(t,request=>{
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

test('Windows rendering forwards selected target and long edge, decodes PNG, and returns page count',async t=>{
  const a=wordPane('render /?&','Rendered document'),b=wordPane('other','Other document');
  const wire=paneHelper(t,[a,b]);
  const saved=[],image={attachmentId:'page-image',mediaType:'image/png',bytes:wire.png.length,width:100,height:140};
  const settings=config({autoHide:false,renderLongEdge:1237,helperToken:'render-fixture'});
  const f=register(t,settings,{saveImage:async input=>{saved.push(input);return image;}});
  await f.call('word_select_document',{target:a.sessionId},undefined,'render-session');
  const args={page:2};const result=await f.call('word_render_page',args,undefined,'render-session');
  const request=wire.requests.at(-1);
  assert.equal(request.route.pathname,'/word/render');assert.equal(request.options.method,'POST');
  assert.equal(request.options.headers.authorization,'Bearer '+settings.helperToken);
  assert.deepEqual(request.body,{page:args.page,longEdge:settings.renderLongEdge,target:a.sessionId});
  assert.deepEqual(saved,[{data:wire.png,mediaType:image.mediaType,name:'word-page-'+args.page+'.png'}]);
  assert.deepEqual(result,{page:args.page,pageCount:wire.pageCount,image});
  const rendered=f.tools.get('word_render_page').output.render(args,result);
  assert.deepEqual(rendered[1],{type:'image',attachment:image});
  assert.ok(wire.requests.every(r=>r.route.pathname === '/panes' || r.route.pathname === '/word/render'));
  wire.panes=[b];
  await f.call('word_render_page',{page:1},undefined,'unselected');
  assert.equal(wire.requests.at(-1).body.target,undefined);
});

test('Windows render errors preserve page count, helper code and pane selection guidance without saving images',async t=>{
  const a=wordPane('render-a','Rendered document');
  const wire=paneHelper(t,[a]),saved=[];
  const f=register(t,config({autoHide:false}),{saveImage:async input=>{saved.push(input);}});
  await assert.rejects(f.call('word_render_page',{page:wire.pageCount+1}),error=>{
    assert.match(error.message,/page-out-of-range/);assert.ok(error.message.includes('Page count: '+wire.pageCount));
    assert.ok(!error.message.includes('undefined'));return true;
  });
  wire.renderError={code:'invalid-pdf'};
  await assert.rejects(f.call('word_render_page',{page:1}),/invalid-pdf/);
  delete wire.renderError;
  assert.equal(saved.length,0);
  const count=wire.requests.length,controller=new AbortController();controller.abort(new Error('cancelled render'));
  await assert.rejects(f.call('word_render_page',{page:1},controller.signal),/cancelled render/);
  for(const page of [0,-1,1.5])await assert.rejects(f.call('word_render_page',{page}),/one-based/);
  assert.equal(wire.requests.length,count);
});

test('render auto-hide runs once per selected pane and does not override an explicit show',async t=>{
  const a=wordPane('render-hide-a','A'),b=wordPane('render-hide-b','B');
  const wire=paneHelper(t,[a,b]);
  const f=register(t,config(),{saveImage:async input=>({attachmentId:'rendered',mediaType:input.mediaType,bytes:input.data.length,width:100,height:140})});
  await f.call('word_select_document',{target:a.sessionId});
  await f.call('word_render_page',{page:1});await f.call('word_render_page',{page:2});
  await f.call('word_select_document',{target:b.sessionId});await f.call('word_render_page',{page:1});
  await f.call('word_select_document',{target:a.sessionId});await f.call('word_pane_visibility',{visible:true});await f.call('word_render_page',{page:1});
  const hides=wire.requests.filter(r=>r.body?.code?.includes('Office.addin.hide'));
  assert.deepEqual(hides.map(r=>r.body.target),[a.sessionId,b.sessionId]);
  const firstRender=wire.requests.findIndex(r=>r.route.pathname === '/word/render');
  assert.ok(wire.requests[firstRender-1].body.code.includes('Office.addin.hide'));
});

function paneHelper(t, initialPanes) {
  const state={panes:initialPanes,requests:[],resolved:[],pageCount:3,png:Buffer.from([137,80,78,71,13,10,26,10,1,2,3])};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (new URL(url).pathname === '/catalog') return new Response(JSON.stringify(catalog('Word')));
    const route=new URL(url),body=options.body === undefined ? undefined : JSON.parse(options.body);
    state.requests.push({route,body,options});
    const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
    if(route.pathname === '/panes') return reply({host:'Word',panes:state.panes});
    const target=body?.target ?? route.searchParams.get('target') ?? undefined;
    const pane=target === undefined ? (state.panes.length === 1 ? state.panes[0] : undefined) : state.panes.find(p=>p.sessionId === target);
    if(!pane){
      const code=target !== undefined ? 'target-not-found' : state.panes.length ? 'multiple-panes' : 'taskpane-not-open';
      const message=code === 'taskpane-not-open' ? 'No Word Helper taskpane is connected. Open Word Helper in the target Word document.' : 'Choose a connected Word document.';
      return reply({error:{code,message,panes:state.panes}},code === 'taskpane-not-open' ? 503 : 409);
    }
    state.resolved.push(pane.sessionId);
    if(route.pathname === '/word/list-styles') return reply({bullet:pane.label+' bullets',number:pane.label+' numbers'});
    if(route.pathname === '/word/zotero') return reply({document:{url:body.documentUrl},target:pane.sessionId,action:body.action});
    if(route.pathname === '/word/render') {
      if(state.renderError) return reply({error:state.renderError},422);
      if(body.page > state.pageCount) return reply({error:{code:'page-out-of-range',pageCount:state.pageCount}},400);
      return reply({page:body.page,pageCount:state.pageCount,width:100,height:140,mimeType:'image/png',base64:state.png.toString('base64')});
    }
    const value=body.code.includes('Office.context.document.url') ? pane.documentUrl : {target:pane.sessionId};
    return reply({value});
  });
  return state;
}
const wordPane=(sessionId,label)=>({sessionId,label,documentUrl:'file:///Documents/'+encodeURIComponent(label)+'.docx',connectedAt:1234});

test('document selection is validated and isolated by DSH session, including no-agent fallback',async t=>{
  const a=wordPane('pane-A','First draft'),b=wordPane('pane-B','Second draft');
  const wire=paneHelper(t,[a,b]),f=register(t,config({autoHide:false}));
  assert.deepEqual(await f.call('word_list_documents',{},undefined,'alpha'),{host:'Word',panes:[a,b],selectedTarget:null});
  await f.call('word_select_document',{target:a.sessionId},undefined,'alpha');
  await f.call('word_select_document',{target:b.sessionId},undefined,'beta');
  await f.call('word_select_document',{target:b.sessionId});
  for(const [sessionId,pane] of [['alpha',a],['beta',b],[undefined,b]]){
    assert.equal((await f.call('word_list_documents',{},undefined,sessionId)).selectedTarget,pane.sessionId);
    assert.equal((await f.call('word_verify_doc',{},undefined,sessionId)).target,pane.sessionId);
    assert.equal(wire.requests.at(-1).body.target,pane.sessionId);
  }
  await assert.rejects(f.call('word_select_document',{target:'missing'},undefined,'alpha'),error=>{
    assert.match(error.message,/target-not-found/);assert.ok(error.message.includes(JSON.stringify(wire.panes)));return true;
  });
  assert.equal((await f.call('word_verify_doc',{},undefined,'alpha')).target,a.sessionId);
  assert.equal((await f.call('word_list_documents',{},undefined,'new-session')).selectedTarget,null);
});

test('selected target reaches client handlers, encoded style lookup, images and Zotero URL evaluation',async t=>{
  const pane=wordPane('pane /+?&','Bound document'),other=wordPane('other','Other document');
  const wire=paneHelper(t,[other,pane]),f=register(t,config({autoHide:false}));
  await f.call('word_select_document',{target:pane.sessionId});
  for(const definition of definitions('Word')) await f.call(definition.name,{probe:definition.clientName});
  await f.call('word_edit_doc_list',{action:'create_list',items:['item'],list_style:'bullet'});
  const styles=wire.requests.find(r=>r.route.pathname === '/word/list-styles');
  assert.equal(styles.options.method,'GET');assert.equal(styles.route.searchParams.get('target'),pane.sessionId);
  const fixture=await binaryFixture(t);
  await f.call('word_insert_image',{filePath:fixture.filePath});
  for(const action of ['inspect','refresh','set_style','insert_citation','insert_bibliography']){
    const result=await f.call('word_zotero_'+action,{style_id:'fixture',items:[]});
    assert.equal(result.document.url,pane.documentUrl);
    assert.equal(wire.requests.at(-1).body.target,pane.sessionId);
    assert.equal(wire.requests.at(-2).body.target,pane.sessionId);
  }
  assert.ok(wire.requests.filter(r=>r.route.pathname === '/eval').every(r=>r.body.target === pane.sessionId));
  assert.ok(wire.resolved.every(id=>id === pane.sessionId));
});

test('pane failures keep labels and selection guidance and never fall back from a closed target',async t=>{
  const a=wordPane('pane-a','Original'),b=wordPane('pane-b','Do not edit');
  const wire=paneHelper(t,[a,b]),f=register(t,config({autoHide:false}));
  await assert.rejects(f.call('word_verify_doc'),error=>{
    assert.match(error.message,/multiple-panes/);assert.ok(error.message.includes(b.label));
    assert.match(error.message,/word_list_documents.*word_select_document/);return true;
  });
  assert.equal(wire.requests.at(-1).body.target,undefined);
  await f.call('word_select_document',{target:a.sessionId});wire.panes=[b];
  const before=wire.requests.length;
  await assert.rejects(f.call('word_zotero_refresh'),/target-not-found.*word_list_documents.*word_select_document/);
  assert.equal(wire.requests.length,before+1);assert.equal(wire.requests.at(-1).body.target,a.sessionId);
  assert.equal((await f.call('word_list_documents')).selectedTarget,a.sessionId);
  wire.panes=[];
  await assert.rejects(f.call('word_verify_doc',{},undefined,'unselected'),/taskpane-not-open.*No Word Helper.*word_select_document/);
  assert.equal(wire.requests.at(-1).body.target,undefined);
});

test('auto-hide follows pane lifetime across auto-pick and selection while respecting explicit show',async t=>{
  const a=wordPane('pane-a','A'),b=wordPane('pane-b','B'),c=wordPane('pane-c','C');
  const wire=paneHelper(t,[a]),f=register(t,config());
  await f.call('word_verify_doc');await f.call('word_verify_doc');
  assert.ok(wire.requests.filter(r=>r.route.pathname === '/eval').every(r=>r.body.target === undefined));
  wire.panes=[a,b,c];
  await f.call('word_select_document',{target:b.sessionId});await f.call('word_verify_doc');
  await f.call('word_select_document',{target:a.sessionId});await f.call('word_verify_doc');
  await f.call('word_select_document',{target:c.sessionId});await f.call('word_pane_visibility',{visible:true});await f.call('word_verify_doc');
  const hides=wire.requests.filter(r=>r.body?.code.includes('Office.addin.hide'));
  assert.deepEqual(hides.map(r=>r.body.target),[undefined,b.sessionId]);
  assert.equal(wire.requests.find(r=>r.body?.code.includes('Office.addin.showAsTaskpane')).body.target,c.sessionId);
  wire.panes=[wordPane('new-pane','Reopened')];
  await f.call('word_verify_doc',{},undefined,'fresh-session');
  assert.equal(wire.requests.filter(r=>r.body?.code.includes('Office.addin.hide')).length,3);
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
