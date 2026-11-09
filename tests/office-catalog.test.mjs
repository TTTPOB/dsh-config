import test from 'node:test';
import assert from 'node:assert/strict';
import * as PowerPoint from '../plugins/powerpoint.mjs';
import * as Word from '../plugins/word.mjs';
import { catalog, settled } from './office-catalog-fixtures.mjs';

function registry(t, plugin, config) {
  const tools=new Map(), providers=new Map(), effects=[], events=[], warnings=[];
  plugin.apply({
    tools:{register(tool){
      assert.ok(!tools.has(tool.name),'duplicate live registration');
      tools.set(tool.name,tool);events.push(['register',tool.name]);
      return()=>{tools.delete(tool.name);events.push(['dispose',tool.name]);};
    }},
    skills:{registerProvider:create=>{const p=create();providers.set(p.name,p);return()=>providers.delete(p.name);}}, attachments:{},
    logger:{warn:message=>warnings.push(message)}, effect(fn){effects.push(fn());},
  },config);
  const dispose=()=>effects.splice(0).reverse().forEach(fn=>fn());
  t.after(dispose);
  return {tools,providers,events,warnings,dispose};
}

for (const [host, plugin] of [['PowerPoint',PowerPoint],['Word',Word]]) {
  const prefix=host.toLowerCase()+'_';
  const config=()=>plugin.Config['~standard'].validate({autoHide:false,catalogRefreshMs:100,catalogRetryInitialMs:5,catalogRetryMaxMs:20,helperToken:'synthetic'}).value;
  test(host+': startup online, revision stability, fetch-before-swap, and offline calls retain tools',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let response=catalog(host,['alpha','beta']), offline=false, invalid=false;
    const requests=[];
    t.mock.method(globalThis,'fetch',async(url,options)=>{
      requests.push({url,options});
      if(offline)throw new Error('helper not connected');
      if(new URL(url).pathname==='/catalog')return new Response(JSON.stringify(invalid?{error:{code:'catalog-unavailable',message:'not yet extracted'}}:response),{status:invalid?503:200});
      return new Response(JSON.stringify({value:{ok:true}}));
    });
    const f=registry(t,plugin,config());
    assert.ok(f.tools.has(prefix+'execute_office_js'),'our own tools register synchronously');
    assert.ok(!f.tools.has(prefix+'alpha'),'activation does not wait for discovery');
    await settled();
    const alpha=f.tools.get(prefix+'alpha');
    assert.ok(alpha);assert.equal(alpha.description,response.tools[0].description);
    assert.deepEqual(alpha.parameters,response.tools[0].inputSchema);assert.equal(alpha.deferLoading,true);
    assert.equal(requests[0].options.headers.authorization,'Bearer synthetic');
    const initialEvents=f.events.length;
    t.mock.timers.tick(100);await settled();
    assert.equal(f.events.length,initialEvents);assert.equal(f.tools.get(alpha.name),alpha);
    invalid=true;t.mock.timers.tick(100);await settled();
    assert.equal(f.events.length,initialEvents);assert.equal(f.tools.get(alpha.name),alpha);
    invalid=false;response=catalog(host,['gamma']);
    t.mock.timers.tick(5);await settled();
    assert.ok(!f.tools.has(alpha.name));assert.ok(!f.tools.has(prefix+'beta'));assert.ok(f.tools.has(prefix+'gamma'));
    const changes=f.events.slice(initialEvents);
    assert.deepEqual(changes.map(e=>e[0]),['dispose','dispose','register']);
    const gamma=f.tools.get(prefix+'gamma'), before=f.events.length;
    offline=true;t.mock.timers.tick(100);await settled();
    assert.equal(f.events.length,before);assert.equal(f.tools.get(gamma.name),gamma);
    await assert.rejects(gamma.execute({},{}),/helper not connected/);
    assert.equal(f.tools.get(gamma.name),gamma);
    offline=false;t.mock.timers.tick(5);await settled();
    assert.equal(f.events.length,before,'same revision after reconnect keeps exact objects');
    f.dispose();assert.equal(f.tools.size,0);
    const calls=requests.length;t.mock.timers.tick(1000);await settled();assert.equal(requests.length,calls);
  });
  test(host+': offline startup retries with bounded backoff until discovery succeeds',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let online=false, attempts=0;
    const response=catalog(host,['later']);
    t.mock.method(globalThis,'fetch',async()=>{
      attempts++;if(!online)throw new Error('helper not connected');
      return new Response(JSON.stringify(response));
    });
    const f=registry(t,plugin,config());await settled();
    assert.ok(f.tools.has(prefix+'execute_office_js'));assert.ok(!f.tools.has(prefix+'later'));
    for(const delay of [5,10,20,20]){
      const before=attempts;t.mock.timers.tick(delay-1);await settled();assert.equal(attempts,before);
      t.mock.timers.tick(1);await settled();assert.equal(attempts,before+1);
    }
    online=true;t.mock.timers.tick(20);await settled();assert.ok(f.tools.has(prefix+'later'));
  });
  test(host+': malformed next generations and static name collisions never remove current tools',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let response=catalog(host,['current']);
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(response)));
    const f=registry(t,plugin,config());await settled();
    const original=f.tools.get(prefix+'current'), before=f.events.length;
    const candidates=[
      {...catalog(host,['duplicate','duplicate'])},
      {...catalog(host,['bad']),host:host==='Word'?'PowerPoint':'Word'},
      catalog(host,['pane_visibility']),
      {...catalog(host,['bad']),tools:[{clientName:'bad',description:'Synthetic',inputSchema:[]} ]},
    ];
    for(const candidate of candidates){
      response=candidate;t.mock.timers.tick(100);await settled();
      assert.equal(f.tools.get(original.name),original);assert.equal(f.events.length,before);
    }
  });
  test(host+': disposing during fetch aborts discovery and never registers a late generation',async t=>{
    let finish,signal;
    t.mock.method(globalThis,'fetch',(_url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});});
    const f=registry(t,plugin,config());f.dispose();assert.equal(signal.aborted,true);
    finish(new Response(JSON.stringify(catalog(host,['late']))));await settled();assert.equal(f.tools.size,0);
  });
}
test('Word skill provider follows committed catalog generations, including missing skills and failed refreshes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let response=catalog('Word',[]), fail=false;
  t.mock.method(globalThis,'fetch',async()=>{
    if(fail)throw new Error('helper not connected');
    return new Response(JSON.stringify(response));
  });
  const config=Word.Config['~standard'].validate({catalogRefreshMs:100,catalogRetryInitialMs:5}).value;
  const f=registry(t,Word,config), provider=f.providers.get(Word.name);
  assert.deepEqual(await provider.list(),[]);await settled();
  assert.deepEqual(await provider.list(),[]);await assert.rejects(provider.get(),/no skill/);
  const skill={name:'word',description:'Synthetic editing help',content:'# Synthetic skill\nUse the test document.'};
  response=catalog('Word',[],skill);t.mock.timers.tick(100);await settled();
  const listed=await provider.list(), full=await provider.get();
  assert.equal(listed.length,1);assert.equal(listed[0].name,skill.name);assert.equal(listed[0].description,skill.description);
  assert.deepEqual({name:full.name,description:full.description,content:full.content},skill);
  const updated={...skill,content:'# Updated synthetic help'};
  response=catalog('Word',[],updated);fail=true;t.mock.timers.tick(100);await settled();
  assert.equal((await provider.get()).content,skill.content);
  fail=false;t.mock.timers.tick(5);await settled();assert.equal((await provider.get()).content,updated.content);
  response=catalog('Word',[]);t.mock.timers.tick(100);await settled();
  assert.deepEqual(await provider.list(),[]);await assert.rejects(provider.get(),/no skill/);
});
