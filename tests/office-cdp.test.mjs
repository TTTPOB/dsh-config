import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Plugin from '../plugins/office-cdp.mjs';

function config(input = {}) { const result = Plugin.Config['~standard'].validate(input); assert.ok(!result.issues); return result.value; }
function directory(t) { const dir = mkdtempSync(join(tmpdir(),'office-cdp-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
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
  const one=f.call('office_run_js',{code:'return "first";'});const rejection=assert.rejects(one,/failed first/);
  await ready;
  const two=f.call('office_run_js',{code:'return "second";'});
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

test('layout checks all four bounds and ignores full containment',()=>{
  const s=(name,left,top,width,height,text='x',type='TextBox')=>({name,left,top,width,height,text,type});
  const result=Plugin.verifyLayout([{slide:1,shapes:[s('panel',0,0,100,100),s('label',10,10,20,20),s('right',95,110,10,10),s('bottom',0,195,10,10),s('empty',120,0,20,20,'','Placeholder')]}],{widthPt:100,heightPt:200});
  assert.ok(result.problems.some(p=>p.shape==='right'&&p.kind==='out-of-bounds'));
  assert.ok(result.problems.some(p=>p.shape==='bottom'&&p.kind==='out-of-bounds'));
  assert.ok(result.problems.some(p=>p.shape==='empty'&&p.kind==='empty-placeholder'));
  assert.ok(!result.problems.some(p=>p.kind==='overlap'));
});

test('render returns attachment content and provider disappears with its tools on disposal',async t=>{
  const dir=directory(t);const ps=join(dir,'powershell');
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
  writeFileSync(ps,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(png.toString('base64'))+');\n',{mode:0o700});
  transport(t,()=>[]);
  const saved=[];const ref={attachmentId:'image-one',mediaType:'image/png',bytes:png.length,width:100,height:50};
  const f=register(t,config({powershell:ps}),{saveImage:async value=>{saved.push(value);return ref;}});
  const value=await f.call('office_render_slide',{slide:1});
  assert.deepEqual(saved[0].data,png);
  const rendered=f.tools.get('office_render_slide').output.render({},value);
  assert.deepEqual(rendered[1],{type:'image',attachment:ref});
  const provider=f.providers.get(Plugin.name), [candidate]=await provider.list();
  const skill=await provider.get(candidate,{});
  for(const tool of f.tools.keys()) assert.ok(skill.content.includes(tool));
  f.dispose();assert.equal(f.tools.size,0);assert.equal(f.providers.size,0);
});
test('automatic hide runs once and explicit show remains visible for later document calls',async t=>{
  const wire=transport(t,()=>({ok:true}));const f=register(t,config());
  await f.call('office_run_js',{code:'return 1;'});await f.call('office_run_js',{code:'return 2;'});
  assert.equal(wire.sent.filter(m=>m.params.expression.includes('Office.addin.hide')).length,1);
  await f.call('office_pane_visibility',{visible:true});await f.call('office_run_js',{code:'return 3;'});
  assert.equal(wire.sent.filter(m=>m.params.expression.includes('Office.addin.hide')).length,1);
  assert.ok(wire.sent.some(m=>m.params.expression.includes('Office.addin.showAsTaskpane')));
});
