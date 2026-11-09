import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalog, definitions, settled } from './office-catalog-fixtures.mjs';
import * as Plugin from '../plugins/powerpoint.mjs';

function config(input = {}) { const result = Plugin.Config['~standard'].validate(input); assert.ok(!result.issues); return result.value; }
function directory(t) { const dir = mkdtempSync(join(tmpdir(),'powerpoint-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
function register(t, settings, attachments = {}) {
  const tools = new Map(), providers = new Map(), effects = [];
  Plugin.apply({tools:{register(tool){tools.set(tool.name,tool);return ()=>tools.delete(tool.name);}},
    skills:{registerProvider(create){const p=create();providers.set(p.name,p);return ()=>providers.delete(p.name);}},
    attachments,effect(fn){effects.push(fn());}},settings);
  const ready=settled();
  const dispose=()=>effects.splice(0).reverse().forEach(fn=>fn()); t.after(dispose);
  return {tools,providers,dispose,call:(name,args={},signal=new AbortController().signal,sessionId)=>ready.then(()=>tools.get(name).execute(args,{signal,...(sessionId === undefined ? {} : {agent:{session:{id:sessionId}}})}))};
}
function transport(t, respond) {
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url, options)=>{
    if (new URL(url).pathname === '/catalog') return new Response(JSON.stringify(catalog('PowerPoint')));
    if (new URL(url).pathname === '/panes') return new Response(JSON.stringify({panes:[{sessionId:'test'}]}));
    const body=JSON.parse(options.body);
    sent.push({params:{expression:body.code}});
    const value=await respond(body.code);
    if (value?.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return new Response(JSON.stringify({value}));
  });
  return {sent};
}

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

test('render returns attachment content and tools are removed on disposal',async t=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
  transport(t,code=>code.includes('getImageAsBase64')?png.toString('base64'):[]);
  const saved=[];const ref={attachmentId:'image-one',mediaType:'image/png',bytes:png.length,width:100,height:50};
  const f=register(t,config({autoHide:false}),{saveImage:async value=>{saved.push(value);return ref;}});
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
  const passthrough=definitions('PowerPoint').filter(d=>d.clientName !== 'execute_office_js');
  for(const definition of passthrough){
    const value=await f.call(definition.name,args);
    assert.deepEqual(calls.at(-1),{name:definition.clientName,value:args});
    assert.equal(value.slide_id_update[args.slide_id],'257#replacement');
  }
  assert.equal(calls.length,passthrough.length);
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
    if (new URL(url).pathname === '/catalog') return new Response(JSON.stringify(catalog('PowerPoint')));
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
  const wire=paneHelper(t,[a,b]),f=register(t,config({autoHide:false}));
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
  const filePath=join(directory(t),'image.png');writeFileSync(filePath,helperPng);
  const wire=paneHelper(t,[other,pane]);
  for(const renderBackend of ['officejs','com']){
    const settings=config({autoHide:false,renderBackend});
    const saved=[],image={attachmentId:renderBackend,mediaType:'image/png',bytes:helperPng.length,width:20,height:10};
    const f=register(t,settings,{saveImage:async value=>{saved.push(value);return image;}});
    await f.call('powerpoint_select_presentation',{target:pane.sessionId});
    for(const definition of definitions('PowerPoint')) await f.call(definition.name,{probe:definition.clientName});
    await f.call('powerpoint_insert_image',{slide:1,filePath});
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
  const wire=paneHelper(t,[a,b]),f=register(t,config({autoHide:false}));
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
  const wire=paneHelper(t,[a]),f=register(t,config());
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

test('removed backend options fail configuration instead of being silently ignored',()=>{
  for (const key of ['backend','endpoint','targetUrl','powershell']) {
    const result=Plugin.Config['~standard'].validate({[key]:'legacy'});
    assert.ok(result.issues.some(issue=>issue.path[0]===key));
  }
});

test('helper failures surface the helper code instead of a bare status', async t => {
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:503,json:async()=>({error:{
    code:'powerpoint-not-running',message:'PowerPoint is not running in the current session.'}})}));
  await assert.rejects(Plugin.evaluate(config(),'return 1;'),/powerpoint-not-running: PowerPoint is not running/);
});

test('Office.js file inputs arrive as raw base64 without changing the caller arguments', async t => {
  const dir=directory(t), image=join(dir,'image.bin'), deck=join(dir,'deck.pptx');
  const imageBytes=Buffer.from([0,255,10,22]), deckBytes=Buffer.from('synthetic presentation');
  writeFileSync(image,imageBytes);writeFileSync(deck,deckBytes);
  const runtime={OfficeClientRuntime:{execute:async(name,args)=>{
    assert.equal(name,'execute_office_js');
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    return new AsyncFunction(args.code)();
  }}};
  transport(t,expression=>Function('globalThis','return '+expression)(runtime));
  const f=register(t,config({autoHide:false}));
  const args={files:{image,deck},code:'return {image:files.image,deck:files.deck};'};
  const before=structuredClone(args);
  assert.deepEqual(await f.call('powerpoint_execute_office_js',args),{
    image:imageBytes.toString('base64'),deck:deckBytes.toString('base64'),
  });
  assert.deepEqual(args,before);
  assert.equal(await f.call('powerpoint_execute_office_js',{code:'return Object.keys(files).length;'}),0);
});

test('invalid file maps fail before Office dispatch and do not poison subsequent calls', async t => {
  const dir=directory(t), missing=join(dir,'missing.pptx');
  const wire=transport(t,()=>true), f=register(t,config({autoHide:false}));
  for (const [files,pattern] of [
    [[],/files must map/],
    [{'bad-name':missing},/Invalid files identifier/],
    [{deck:'relative.pptx'},/absolute file path/],
    [{deck:missing},/Cannot read files.deck.*ENOENT/],
    [{deck:dir},/Cannot read files.deck/],
  ]) await assert.rejects(f.call('powerpoint_execute_office_js',{files,code:'return true;'}),pattern);
  assert.equal(wire.sent.length,0);
  assert.equal(await f.call('powerpoint_execute_office_js',{code:'return true;'}),true);
});

test('image tool reads file bytes and fails missing inputs before Office dispatch', async t => {
  const dir=directory(t), filePath=join(dir,'image.png'), bytes=Buffer.from([137,80,78,71,0,255]);
  writeFileSync(filePath,bytes);
  let inserted;
  const Office={GoToType:{Index:'Index'},context:{document:{
    goToByIdAsync(_slide,_type,cb){cb({});},
    setSelectedDataAsync(data,placement,cb){inserted={data,placement};cb({});},
  }}};
  const PowerPoint={run:fn=>fn({presentation:{slides:{items:[{id:'slide'}],load(){}}},sync:async()=>{}})};
  const wire=transport(t,expression=>Function('Office','PowerPoint','return '+expression)(Office,PowerPoint));
  const f=register(t,config({autoHide:false}));
  await f.call('powerpoint_insert_image',{slide:1,filePath,width:123});
  assert.equal(inserted.data,bytes.toString('base64'));
  assert.equal(inserted.placement.imageWidth,123);
  await assert.rejects(f.call('powerpoint_insert_image',{slide:1,base64:bytes.toString('base64')}));
  await assert.rejects(f.call('powerpoint_insert_image',{slide:1,filePath:join(dir,'missing.png')}),/ENOENT/);
  assert.equal(wire.sent.length,1);
});
