import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Plugin from '../plugins/powerpoint.mjs';

function config(input = {}) { const result = Plugin.Config['~standard'].validate(input); assert.ok(!result.issues); return result.value; }
function directory(t) { const dir = mkdtempSync(join(tmpdir(),'powerpoint-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
function register(t, settings, attachments = {}) {
  const tools = new Map(), providers = new Map(), effects = [];
  Plugin.apply({tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name);}},
    skills:{registerProvider(create){const p=create();providers.set(p.name,p);return ()=>providers.delete(p.name);}},
    attachments,effect(fn){effects.push(fn());}},settings);
  const dispose=()=>effects.splice(0).reverse().forEach(fn=>fn()); t.after(dispose);
  return {tools,providers,dispose,call:(name,args={},signal=new AbortController().signal,sessionId)=>tools.get(name).execute(args,{signal,...(sessionId === undefined ? {} : {agent:{session:{id:sessionId}}})})};
}
function transport(t, respond) {
  const sent=[], sockets=[];
  t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>[
    {type:'page',url:'https://unrelated.invalid/',webSocketDebuggerUrl:'ws://wrong.invalid/other'},
    {type:'page',url:'https://pivot.claude.ai/auth/login',webSocketDebuggerUrl:'ws://localhost:1/devtools/page/office'},
  ]}));
  const Original=globalThis.WebSocket;
  globalThis.WebSocket=class {
    constructor(url){this.url=String(url);sockets.push(this);queueMicrotask(()=>this.onopen?.());}
    send(raw){const msg=JSON.parse(raw);sent.push(msg);Promise.resolve().then(()=>respond(msg.params.expression,this)).then(value=>{
      if(value?.exceptionDetails) this.onmessage?.({data:JSON.stringify({id:msg.id,result:value})});
      else this.onmessage?.({data:JSON.stringify({id:msg.id,result:{result:{value}}})});
    });}
    close(){this.closed=true;}
  };
  t.after(()=>{globalThis.WebSocket=Original;});
  return {sent,sockets};
}

test('CDP selects Office target, rewrites tunneled host and closes connections on success and exception',async t=>{
  let fail=false;
  const wire=transport(t,()=>fail?{exceptionDetails:{exception:{description:'Office sync failed'}}}:{count:3});
  const c=config({endpoint:'http://127.0.0.1:34567'});
  assert.deepEqual(await Plugin.evaluate(c,'return-value'),{count:3});
  assert.equal(new URL(wire.sockets[0].url).host,new URL(c.endpoint).host);
  assert.equal(new URL(wire.sockets[0].url).pathname,'/devtools/page/office');
  fail=true;
  await assert.rejects(Plugin.evaluate(c,'partial-write'),/Office sync failed/);
  assert.equal(wire.sent.length,2);
  assert.ok(wire.sockets.every(s=>s.closed));
});

test('caller abort closes the socket and does not resend an unknown write',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const wire=transport(t,()=>{entered();return new Promise(()=>{});});
  const controller=new AbortController();
  const pending=Plugin.evaluate(config(),'write',controller.signal);
  await ready;controller.abort();
  await assert.rejects(pending,/inspect before retrying/);
  assert.equal(wire.sent.length,1);assert.equal(wire.sockets[0].closed,true);
});

test('shared tools run sequentially and a failed call does not poison the queue',async t=>{
  let finish;const first=new Promise(resolve=>{finish=resolve;});
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const wire=transport(t,async code=>{if(code.includes('first')){entered();await first;return {exceptionDetails:{text:'failed first'}};}return 'second';});
  const f=register(t,config({autoHide:false}));
  const one=f.call('powerpoint_execute_office_js',{code:'return "first";'});const rejection=assert.rejects(one,/failed first/);
  await ready;
  const two=f.call('powerpoint_execute_office_js',{code:'return "second";'});
  assert.equal(wire.sent.length,1);finish();await rejection;assert.equal(await two,'second');assert.equal(wire.sent.length,2);
});

test('image bytes and placement use Office API after slide selection outside its callback',async()=>{
  const calls=[];
  const Office={GoToType:{Index:'Index'},context:{document:{
    goToByIdAsync(slide,type,cb){calls.push({kind:'select',slide,type});cb({});calls.push({kind:'callback-returned'});},
    setSelectedDataAsync(base64,opts,cb){calls.push({kind:'image',base64,opts});cb({});},
  }}};
  const PowerPoint={run:fn=>fn({presentation:{slides:{items:[{id:'s1'}],load(){}}},sync:async()=>{}})};
  const evaluate=Function('Office','PowerPoint','return '+Plugin.imageExpression(1,'YWJj',{imageWidth:300,imageLeft:12}));
  assert.deepEqual(await evaluate(Office,PowerPoint),{slide:1,inserted:true});
  assert.deepEqual(calls.map(c=>c.kind),['select','callback-returned','image']);
  assert.equal(calls[2].base64,'YWJj');assert.equal(calls[2].opts.imageWidth,300);assert.equal(calls[2].opts.imageHeight,undefined);
});

test('shape reads load null status before text and compact only the outline text',async()=>{
  const frame={loaded:false,textLoaded:false,load(fields){if(fields==='isNullObject')this.loaded=true;else if(fields==='textRange/text')this.textLoaded=true;},
    get isNullObject(){assert.ok(this.loaded);return false;},get textRange(){assert.ok(this.textLoaded);return {text:'a'.repeat(400)};}};
  const shape={id:'a',name:'text',type:'TextBox',left:0,top:0,width:10,height:10,getTextFrameOrNullObject:()=>frame};
  const PowerPoint={run:fn=>fn({presentation:{slides:{load(){},items:[{id:'one',shapes:{load(){},items:[shape]}}]}},sync:async()=>{}})};
  const run=code=>Function('PowerPoint','return '+code)(PowerPoint);
  assert.equal((await run(Plugin.outlineExpression(1,true)))[0].shapes[0].text.length,200);
  assert.equal((await run(Plugin.outlineExpression(1)))[0].shapes[0].text.length,400);
  await assert.rejects(run(Plugin.outlineExpression(2)),/outside/);
});

test('COM render returns attachment content and tools are removed on disposal',async t=>{
  const dir=directory(t);const ps=join(dir,'powershell');
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
  writeFileSync(ps,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(png.toString('base64'))+');\n',{mode:0o700});
  transport(t,()=>[]);
  const saved=[];const ref={attachmentId:'image-one',mediaType:'image/png',bytes:png.length,width:100,height:50};
  const f=register(t,config({powershell:ps,renderBackend:'com'}),{saveImage:async value=>{saved.push(value);return ref;}});
  const value=await f.call('powerpoint_render_slide',{slide:1});
  assert.deepEqual(saved[0].data,png);
  const rendered=f.tools.get('powerpoint_render_slide').output.render({},value);
  assert.deepEqual(rendered[1],{type:'image',attachment:ref});
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});
test('native client tools forward arguments untouched and preserve replacement ID results',async t=>{
  const args={slide_id:'256#example',code:'const xml = "<a:t>引号与 &amp; 内容</a:t>"; return xml;',autosize_shape_ids:['3']};
  const calls=[];
  const runtime={execute:async(name,value)=>{calls.push({name,value});return {result:'readback',slide_id_update:{[value.slide_id]:'257#replacement'}};}};
  transport(t,code=>Function('globalThis','return '+code)({OfficeClientRuntime:runtime}));
  const f=register(t,config({autoHide:false}));
  for(const definition of Plugin.clientToolDefinitions){
    const value=await f.call(definition.name,args);
    assert.deepEqual(calls.at(-1),{name:definition.clientName,value:args});
    assert.equal(value.slide_id_update[args.slide_id],'257#replacement');
  }
  assert.equal(calls.length,Plugin.clientToolDefinitions.length);
});

test('Office.js rendering reads the bound slide and preserves returned image bytes',async t=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10,4,3,2,1]);const requests=[];
  const shapes=[{id:'first'},{id:'second',getImageAsBase64(options){requests.push(options);return {value:png.toString('base64')};}}];
  const PowerPoint={run:fn=>fn({presentation:{slides:{load(){},items:shapes}},sync:async()=>{}})};
  transport(t,code=>Function('PowerPoint','return '+code)(PowerPoint));
  assert.deepEqual(await Plugin.renderSlide(config({renderWidth:987}),2),png);
  assert.deepEqual(requests,[{width:987}]);
});

const helperPng=Buffer.from([137,80,78,71,13,10,26,10,3,2,1]);
const presentationPane=(sessionId,label)=>({sessionId,label,documentUrl:'file:///Presentations/'+encodeURIComponent(label)+'.pptx',connectedAt:5678});
function paneHelper(t,initialPanes){
  const state={panes:initialPanes,requests:[],resolved:[]};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const route=new URL(url),body=options.body === undefined ? undefined : JSON.parse(options.body);
    state.requests.push({route,body,options});
    const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
    if(route.pathname === '/panes')return reply({host:'PowerPoint',panes:state.panes});
    const target=body?.target;
    const pane=target === undefined ? (state.panes.length === 1 ? state.panes[0] : undefined) : state.panes.find(p=>p.sessionId === target);
    if(!pane){
      const code=target !== undefined ? 'target-not-found' : state.panes.length ? 'multiple-panes' : 'taskpane-not-open';
      const message=code === 'taskpane-not-open' ? 'No PowerPoint Helper taskpane is connected. Open PowerPoint Helper in the target PowerPoint document.' : 'Choose a connected PowerPoint presentation.';
      return reply({error:{code,message,panes:state.panes}},code === 'taskpane-not-open' ? 503 : 409);
    }
    state.resolved.push(pane.sessionId);
    if(route.pathname === '/render')return new Response(helperPng);
    const value=body.code.includes('getImageAsBase64') ? helperPng.toString('base64') : body.code.includes('slideCount: items.length') ? {slideCount:4,target:pane.sessionId} : {target:pane.sessionId};
    return reply({value});
  });
  return state;
}

test('presentation selection validates panes and isolates DSH sessions and no-agent calls',async t=>{
  const a=presentationPane('pane-a','Research'),b=presentationPane('pane-b','Teaching');
  const wire=paneHelper(t,[a,b]),f=register(t,config({backend:'helper',autoHide:false}));
  assert.deepEqual(await f.call('powerpoint_list_presentations',{},undefined,'alpha'),{host:'PowerPoint',panes:[a,b],selectedTarget:null});
  await f.call('powerpoint_select_presentation',{target:a.sessionId},undefined,'alpha');
  await f.call('powerpoint_select_presentation',{target:b.sessionId},undefined,'beta');
  await f.call('powerpoint_select_presentation',{target:b.sessionId});
  for(const [sessionId,pane] of [['alpha',a],['beta',b],[undefined,b]]){
    assert.equal((await f.call('powerpoint_list_presentations',{},undefined,sessionId)).selectedTarget,pane.sessionId);
    assert.equal((await f.call('powerpoint_deck_info',{},undefined,sessionId)).target,pane.sessionId);
    assert.equal(wire.requests.at(-1).body.target,pane.sessionId);
  }
  await assert.rejects(f.call('powerpoint_select_presentation',{target:'gone'},undefined,'alpha'),error=>{
    assert.match(error.message,/target-not-found/);assert.ok(error.message.includes(JSON.stringify(wire.panes)));return true;
  });
  assert.equal((await f.call('powerpoint_deck_info',{},undefined,'alpha')).target,a.sessionId);
  assert.equal((await f.call('powerpoint_list_presentations',{},undefined,'new-session')).selectedTarget,null);
});

test('selected pane is forwarded through all native handlers, images and both rendering backends',async t=>{
  const pane=presentationPane('pane /+?','Target'),other=presentationPane('other','Other');
  const wire=paneHelper(t,[other,pane]);
  for(const renderBackend of ['officejs','com']){
    const settings=config({backend:'helper',autoHide:false,renderBackend});
    const saved=[],image={attachmentId:renderBackend,mediaType:'image/png',bytes:helperPng.length,width:20,height:10};
    const f=register(t,settings,{saveImage:async value=>{saved.push(value);return image;}});
    await f.call('powerpoint_select_presentation',{target:pane.sessionId});
    for(const definition of Plugin.clientToolDefinitions) await f.call(definition.name,{probe:definition.clientName});
    await f.call('powerpoint_insert_image',{slide:1,base64:'YWJj'});
    await f.call('powerpoint_slide_outline',{slide:1});
    await f.call('powerpoint_render_slide',{slide:2});
    assert.deepEqual(saved[0].data,helperPng);
    assert.equal(wire.requests.at(-1).body.target,pane.sessionId);
    if(renderBackend === 'com')assert.equal(wire.requests.at(-1).body.expectSlides,4);
    else assert.ok(wire.requests.at(-1).body.code.includes('getImageAsBase64'));
  }
  assert.ok(wire.requests.filter(r=>r.body).every(r=>r.body.target === pane.sessionId));
  assert.ok(wire.resolved.every(id=>id === pane.sessionId));
});

test('pane failures expose the pane list and select tool without dropping a stale selection',async t=>{
  const a=presentationPane('pane-a','Original deck'),b=presentationPane('pane-b','Not the target');
  const wire=paneHelper(t,[a,b]),f=register(t,config({backend:'helper',autoHide:false}));
  await assert.rejects(f.call('powerpoint_deck_info'),error=>{
    assert.match(error.message,/multiple-panes/);assert.ok(error.message.includes(b.label));
    assert.match(error.message,/powerpoint_list_presentations.*powerpoint_select_presentation/);return true;
  });
  assert.equal(wire.requests.at(-1).body.target,undefined);
  await f.call('powerpoint_select_presentation',{target:a.sessionId});wire.panes=[b];
  const before=wire.requests.length;
  await assert.rejects(f.call('powerpoint_render_slide',{slide:1}),/target-not-found.*powerpoint_list_presentations.*powerpoint_select_presentation/);
  assert.equal(wire.requests.length,before+1);assert.equal(wire.requests.at(-1).body.target,a.sessionId);
  assert.equal((await f.call('powerpoint_list_presentations')).selectedTarget,a.sessionId);
  wire.panes=[];
  await assert.rejects(f.call('powerpoint_deck_info',{},undefined,'unselected'),/taskpane-not-open.*No PowerPoint Helper.*powerpoint_select_presentation/);
  assert.equal(wire.requests.at(-1).body.target,undefined);
});

test('helper auto-hide is once per pane including auto-picked panes and honors explicit show',async t=>{
  const a=presentationPane('pane-a','A'),b=presentationPane('pane-b','B'),c=presentationPane('pane-c','C');
  const wire=paneHelper(t,[a]),f=register(t,config({backend:'helper'}));
  await f.call('powerpoint_deck_info');await f.call('powerpoint_deck_info');
  assert.ok(wire.requests.filter(r=>r.body).every(r=>r.body.target === undefined));
  wire.panes=[a,b,c];
  await f.call('powerpoint_select_presentation',{target:b.sessionId});await f.call('powerpoint_deck_info');
  await f.call('powerpoint_select_presentation',{target:a.sessionId});await f.call('powerpoint_deck_info');
  await f.call('powerpoint_select_presentation',{target:c.sessionId});await f.call('powerpoint_pane_visibility',{visible:true});await f.call('powerpoint_deck_info');
  const hides=wire.requests.filter(r=>r.body?.code.includes('Office.addin.hide'));
  assert.deepEqual(hides.map(r=>r.body.target),[undefined,b.sessionId]);
  assert.equal(wire.requests.find(r=>r.body?.code.includes('Office.addin.showAsTaskpane')).body.target,c.sessionId);
  wire.panes=[presentationPane('reopened-pane','Reopened')];
  await f.call('powerpoint_deck_info',{},undefined,'fresh-session');
  assert.equal(wire.requests.filter(r=>r.body?.code.includes('Office.addin.hide')).length,3);
});

test('direct CDP refuses helper document selection instead of silently ignoring it',async t=>{
  const wire=transport(t,()=>({})),f=register(t,config());
  await assert.rejects(f.call('powerpoint_list_presentations'),/requires backend: helper/);
  await assert.rejects(f.call('powerpoint_select_presentation',{target:'pane'}),/requires backend: helper/);
  assert.equal(wire.sent.length,0);
});

test('helper failures surface the helper code instead of a bare status', async t => {
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:503,json:async()=>({error:{
    code:'powerpoint-not-running',message:'PowerPoint is not running in the current session.'}})}));
  await assert.rejects(Plugin.evaluate(config({backend:'helper'}),'return 1;'),/powerpoint-not-running: PowerPoint is not running/);
});
