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
  return {tools,providers,dispose,call:(name,args={},signal=new AbortController().signal)=>tools.get(name).execute(args,{signal})};
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

test('render returns attachment content and provider disappears with its tools on disposal',async t=>{
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
  const provider=f.providers.get(Plugin.name), [candidate]=await provider.list();
  const skill=await provider.get(candidate,{});
  assert.equal(skill.name,candidate.name);
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});
test('automatic hide runs once and explicit show remains visible for later document calls',async t=>{
  const wire=transport(t,()=>({ok:true}));const f=register(t,config());
  await f.call('powerpoint_execute_office_js',{code:'return 1;'});await f.call('powerpoint_execute_office_js',{code:'return 2;'});
  assert.equal(wire.sent.filter(m=>m.params.expression.includes('Office.addin.hide')).length,1);
  await f.call('powerpoint_pane_visibility',{visible:true});await f.call('powerpoint_execute_office_js',{code:'return 3;'});
  assert.equal(wire.sent.filter(m=>m.params.expression.includes('Office.addin.hide')).length,1);
  assert.ok(wire.sent.some(m=>m.params.expression.includes('Office.addin.showAsTaskpane')));
});
test('native client tools forward typed arguments and preserve replacement IDs without a generic dispatch alias',async t=>{
  const args={slide_id:'256#example',code:'const xml = "<a:t>引号与 &amp; 内容</a:t>"; return xml;',autosize_shape_ids:['3']};
  const calls=[];
  const runtime={execute:async(name,value)=>{calls.push({name,value});return {result:'readback',slide_id_update:{[value.slide_id]:'257#replacement'}};}};
  transport(t,code=>Function('globalThis','return '+code)({OfficeClientRuntime:runtime}));
  const f=register(t,config({autoHide:false}));
  for(const definition of Plugin.clientToolDefinitions){
    const value=await f.call(definition.name,args);
    assert.deepEqual(calls.at(-1),{name:definition.clientName,value:args});
    assert.equal(value.slide_id_update[args.slide_id],'257#replacement');
    assert.equal(f.tools.get(definition.name).parameters,definition.parameters);
  }
  assert.ok(![...f.tools.keys()].some(name=>name.includes('client_tool')||name.includes('client_catalog')));
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

test('helper backend sends deck size into render and keeps helper error codes', async t => {
  const requests=[];
  const png=Buffer.from([137,80,78,71,13,10,26,10,9,9]);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const href=String(url);requests.push({href,body:JSON.parse(init.body)});
    if(href.endsWith('/eval'))return {ok:true,json:async()=>({value:{slideCount:7}})};
    return {ok:true,arrayBuffer:async()=>png};
  });
  const saved=[];const ref={attachmentId:'image-helper',mediaType:'image/png',bytes:png.length,width:10,height:5};
  const f=register(t,config({backend:'helper',helperUrl:'http://127.0.0.1:19999',autoHide:false,renderBackend:'com'}),{saveImage:async value=>{saved.push(value);return ref;}});
  const value=await f.call('powerpoint_render_slide',{slide:2});
  assert.deepEqual(saved[0].data,png);
  assert.equal(value.image.attachmentId,'image-helper');
  assert.equal(new URL(requests[0].href).host,'127.0.0.1:19999');
  assert.equal(new URL(requests[0].href).pathname,'/eval');
  assert.equal(new URL(requests[1].href).pathname,'/render');
  assert.deepEqual(requests[1].body,{slide:2,width:1280,height:720,expectSlides:7});
});

test('helper failures surface the helper code instead of a bare status', async t => {
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:503,json:async()=>({error:{
    code:'powerpoint-not-running',message:'PowerPoint is not running in the current session.'}})}));
  await assert.rejects(Plugin.evaluate(config({backend:'helper'}),'return 1;'),/powerpoint-not-running: PowerPoint is not running/);
});
