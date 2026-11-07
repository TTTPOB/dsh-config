/** Native PowerPoint tools backed by an existing Office taskpane over CDP. */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const name = 'office-cdp';
export const inject = ['tools', 'skills', 'attachments'];
const runFile = promisify(execFile);

/** Dependency-free Standard Schema for deployment-specific connection settings. */
export const Config = {
  '~standard': { version: 1, vendor: name, validate(input) {
    const value = { backend: 'cdp', endpoint: 'http://127.0.0.1:9224', helperUrl: 'http://127.0.0.1:18766',
      helperToken: '', targetUrl: 'https://pivot.claude.ai/', timeoutMs: 90000,
      powershell: 'powershell.exe', renderBackend: 'officejs', renderWidth: 1280, renderHeight: 720, autoHide: true, ...input };
    const issues = [];
    if (!['cdp', 'helper'].includes(value.backend)) issues.push({ message: "backend must be 'cdp' or 'helper'", path: ['backend'] });
    if (!['officejs','com'].includes(value.renderBackend)) issues.push({ message: 'renderBackend must be officejs or com', path: ['renderBackend'] });
    if (typeof value.helperToken !== 'string') issues.push({ message: 'helperToken must be a string', path: ['helperToken'] });
    for (const key of ['endpoint', 'helperUrl', 'targetUrl']) {
      try { if (!['http:', 'https:'].includes(new URL(value[key]).protocol)) throw new Error('protocol'); }
      catch (error) { issues.push({ message: key + ' must be an HTTP(S) URL', path: [key] }); }
    }
    for (const key of ['timeoutMs', 'renderWidth', 'renderHeight']) {
      if (!Number.isSafeInteger(value[key]) || value[key] <= 0) issues.push({ message: key + ' must be a positive integer', path: [key] });
    }
    if (typeof value.autoHide !== 'boolean') issues.push({ message: 'autoHide must be boolean', path: ['autoHide'] });
    if (typeof value.powershell !== 'string' || !value.powershell) issues.push({ message: 'powershell must name an executable', path: ['powershell'] });
    return issues.length ? { issues } : { value };
  } },
};

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function helperSignal(config, signal) {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  return combined;
}

/** One request to the Windows helper; failures keep the helper's code and hint. */
async function helperRequest(config, route, body, signal, binary = false) {
  const headers = { 'content-type': 'application/json' };
  if (config.helperToken) headers.authorization = 'Bearer ' + config.helperToken;
  const response = await fetch(new URL(route, config.helperUrl), {
    method: 'POST', headers, body: JSON.stringify(body), signal: helperSignal(config, signal),
  });
  if (!response.ok) {
    let detail = null;
    try { detail = (await response.json()).error; } catch { detail = null; }
    throw new Error('office-cdp helper ' + (detail?.code ?? 'HTTP ' + response.status) + ': '
      + (detail?.message ?? 'request failed'));
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

/** Evaluate once; never retry writes whose completion is unknown. */
export async function evaluate(config, expression, signal) {
  if (config.backend === 'helper') return (await helperRequest(config, '/eval', { code: expression }, signal)).value ?? null;
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  const response = await fetch(new URL('/json/list', config.endpoint), { signal: combined });
  if (!response.ok) throw new Error('CDP discovery HTTP ' + response.status);
  const targets = await response.json();
  const matches = targets.filter(t => t.type === 'page' && t.url?.startsWith(config.targetUrl));
  if (matches.length !== 1) throw new Error('Expected exactly one matching Office pane, found ' + matches.length + '. Open the taskpane or narrow targetUrl.');
  const remote = new URL(matches[0].webSocketDebuggerUrl);
  const endpoint = new URL(config.endpoint);
  remote.host = endpoint.host;
  remote.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(remote);
  try {
    return await new Promise((resolve, reject) => {
      const fail = error => { combined.removeEventListener('abort', abort); reject(error); };
      const abort = () => fail(new Error('CDP cancelled/timed out. A document write may already have completed; inspect before retrying.', { cause: combined.reason }));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) { abort(); return; }
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
      } }));
      ws.onerror = () => fail(new Error('CDP WebSocket failed; check the taskpane and endpoint.'));
      ws.onclose = () => fail(new Error('Office pane disconnected. A write may already have completed; inspect before retrying.'));
      ws.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch (error) { fail(new Error('Invalid CDP response', { cause: error })); return; }
        if (message.id !== 1) return;
        combined.removeEventListener('abort', abort);
        if (message.error) { reject(new Error(JSON.stringify(message.error))); return; }
        const result = message.result;
        if (result.exceptionDetails) {
          reject(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)); return;
        }
        resolve(result.result.value ?? null);
      };
    });
  } finally {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
  }
}

// Office collections need an explicit sync before their loaded properties are read.
const helpers = `
async function slides(ctx) {
  const collection = ctx.presentation.slides;
  collection.load('items/id'); await ctx.sync(); return collection.items;
}
function at(items, index) {
  if (!Number.isInteger(index) || index < 1 || index > items.length) throw new Error('Slide index outside 1..' + items.length);
  return items[index - 1];
}
async function rows(ctx, slide) {
  slide.shapes.load('items/id,items/name,items/type,items/left,items/top,items/width,items/height');
  await ctx.sync();
  const pairs = slide.shapes.items.map(shape => ({ shape, frame: shape.getTextFrameOrNullObject() }));
  for (const { frame } of pairs) frame.load('isNullObject');
  await ctx.sync();
  for (const { frame } of pairs) if (!frame.isNullObject) frame.load('textRange/text');
  await ctx.sync();
  return pairs.map(({shape: s, frame: f}) => ({id:s.id,name:s.name,type:String(s.type),left:s.left,top:s.top,width:s.width,height:s.height,text:f.isNullObject ? '' : f.textRange.text}));
}
`;
const office = body => '(async () => {' + helpers + '; return await PowerPoint.run(async ctx => {' + body + '});})()';

/** Read deck metadata without COM or local file paths. */
export function infoExpression() {
  return office(`const items = await slides(ctx);
    const page = ctx.presentation.pageSetup; page.load('slideWidth,slideHeight');
    const masters = ctx.presentation.slideMasters; masters.load('items/id'); await ctx.sync();
    for (const master of masters.items) master.layouts.load('items/id,items/name'); await ctx.sync();
    return { slideCount: items.length, slideIds: items.map(s=>s.id), page: {widthPt:page.slideWidth,heightPt:page.slideHeight},
      masters: masters.items.map(m=>({id:m.id,layouts:m.layouts.items.map(l=>({id:l.id,name:l.name}))})) };`);
}

/** Build one-slide or whole-deck summaries. Indices are one-based. */
export function outlineExpression(slide, compact = false) {
  return office(`const items = await slides(ctx); const index = ${JSON.stringify(slide ?? null)};
    const selected = index === null ? items.map((s,i)=>({s,i:i+1})) : [{s:at(items,index),i:index}];
    const result=[]; for (const {s,i} of selected) { const shapes=await rows(ctx,s);
      result.push({slide:i,id:s.id,shapes:${compact ? "shapes.map(s=>({...s,text:s.text.slice(0,200)}))" : 'shapes'}}); } return result;`);
}

/** Deck size, used to refuse rendering a different PowerPoint window. */
export function deckSizeExpression(slide) {
  return office(`const items = await slides(ctx); at(items, ${JSON.stringify(slide)}); return {slideCount: items.length};`);
}

/** Geometry warnings are heuristics; they do not establish visual correctness. */
export function verifyLayout(data, page) {
  const problems = [];
  for (const slide of data) {
    for (const shape of slide.shapes) {
      if (shape.left < -1 || shape.top < -1 || shape.left + shape.width > page.widthPt + 1 || shape.top + shape.height > page.heightPt + 1)
        problems.push({ slide: slide.slide, shape: shape.name, kind: 'out-of-bounds' });
      if (shape.type === 'Placeholder' && !shape.text.trim()) problems.push({ slide: slide.slide, shape: shape.name, kind: 'empty-placeholder' });
    }
    for (let i = 0; i < slide.shapes.length; i++) for (let j = i + 1; j < slide.shapes.length; j++) {
      const a = slide.shapes[i], b = slide.shapes[j];
      const area = Math.max(0, Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left)) * Math.max(0, Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top));
      const ratio = area / (Math.min(a.width*a.height,b.width*b.height) || 1);
      if (ratio > 0.25 && ratio < 0.95) problems.push({ slide: slide.slide, shapes: [a.name,b.name], kind:'overlap', ratio });
    }
  }
  return { slidesChecked: data.length, problems, note: 'Heuristic only: containment is ignored; inspect rendered slides for clipping and intentional overlaps.' };
}

/** Render the taskpane-bound slide through Office.js, or opt into the COM transport. */
export async function renderSlide(config, slide, options = {}) {
  if (!Number.isSafeInteger(slide) || slide < 1) throw new Error('slide must be a positive integer');
  if (config.renderBackend === 'officejs') {
    const expression = office('const items=await slides(ctx);const slide=at(items,'+JSON.stringify(slide)+');'
      +'if(typeof slide.getImageAsBase64!=="function") throw new Error("This Office runtime does not support slide images; select renderBackend: com.");'
      +'const image=slide.getImageAsBase64({width:'+config.renderWidth+'});await ctx.sync();return image.value;');
    const encoded = await evaluate(config, expression, options.signal);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.subarray(0,8).equals(PNG_MAGIC)) throw new Error('Office.js did not return a PNG');
    return bytes;
  }
  const expected = Number(options.expectSlides ?? 0);
  if (config.backend === 'helper') {
    const bytes = await helperRequest(config, '/render',
      { slide, width: config.renderWidth, height: config.renderHeight, expectSlides: expected }, options.signal, true);
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('office-cdp helper did not return a PNG');
    return bytes;
  }
  const script = `$ErrorActionPreference = 'Stop'
$p = [IO.Path]::Combine([IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString() + '.png')
try {
  $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
  $deck = $app.ActivePresentation
  if (${expected} -ne 0 -and $deck.Slides.Count -ne ${expected}) { Write-Output ('MISMATCH:' + $deck.Slides.Count) }
  else {
    $deck.Slides.Item(${slide}).Export($p, 'PNG', ${config.renderWidth}, ${config.renderHeight})
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
  }
} finally { if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) } }`;
  const { stdout } = await runFile(config.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')],
    { signal: options.signal, timeout: config.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const output = stdout.trim();
  if (output.startsWith('MISMATCH:')) throw new Error('PowerPoint has a different deck active (' + output.slice(9) + ' slides); keep the deck bound to the taskpane active.');
  const bytes = Buffer.from(output, 'base64');
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('PowerPoint did not return a PNG');
  return bytes;
}

/** Encode the public Office image insertion API; data travels over CDP. */
export function imageExpression(slide, base64, placement) {
  return '(async () => {' + helpers + `
    await PowerPoint.run(async ctx=>at(await slides(ctx),${slide}));
    await new Promise((resolve,reject)=>Office.context.document.goToByIdAsync(${slide},Office.GoToType.Index,r=>r.error?reject(new Error(r.error.message)):resolve()));
    await new Promise((resolve,reject)=>Office.context.document.setSelectedDataAsync(${JSON.stringify(base64)},${JSON.stringify({coercionType:'image',...placement})},r=>r.error?reject(new Error(r.error.message)):resolve()));
    return {slide:${slide},inserted:true}; })()`;
}

const objectSchema = { type: 'object', additionalProperties: true };
const jsonSchema = { oneOf: [{type:'object',additionalProperties:true},{type:'array',items:{}},{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}] };
const textRender = (_args, value) => [{type:'text',text:JSON.stringify(value)}];
const slideParam = {type:'integer',description:'One-based slide index in the current deck.'};
const imageSchema = {type:'object',properties:{attachmentId:{type:'string'},mediaType:{type:'string'},bytes:{type:'integer'},width:{type:'integer'},height:{type:'integer'},name:{type:'string'},originalDimensions:{type:'object',properties:{width:{type:'integer'},height:{type:'integer'}},required:['width','height'],additionalProperties:false}},required:['attachmentId','mediaType','bytes','width','height'],additionalProperties:false};

/** Build a dispatch request without interpreting model-supplied argument strings as code. */
export function clientCallExpression(name, args = {}) {
  const available = 'if(!globalThis.OfficeClientRuntime) throw new Error("Client execution runtime is not loaded. Open the independent Office Helper add-in.");';
  if(name === 'catalog') return '(async()=>{'+available+'const tools=await globalThis.OfficeClientRuntime.catalog();const name='+JSON.stringify(args.name??null)+';'
    +'if(name){const tool=tools.find(t=>t.name===name);if(!tool)throw new Error("Unknown client tool: "+name);return tool;}'
    +'return tools.map(t=>({name:t.name,description:t.description,supported:t.supported,inputs:Object.keys(t.parameters?.properties??{}),required:t.parameters?.required??[]}));})()';
  return '(async()=>{'+available+'return await globalThis.OfficeClientRuntime.execute('+JSON.stringify(name)+','+JSON.stringify(args)+');})()';
}

/** Register tools and the embedded provider; serialize operations across agents sharing the deck. */
export function apply(ctx, config) {
  let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  let hidden = false;
  const evaluateNow = async (code, exec) => {
    if (config.autoHide && !hidden) {
      await evaluate(config, '(async()=>{await Office.addin.hide();return true;})()', exec.signal);
      hidden = true;
    }
    return evaluate(config, code, exec.signal);
  };
  const add = (toolName, description, properties, required, schema, execute, render = textRender) => {
    ctx.effect(() => ctx.tools.register({name:toolName,deferLoading:true,description,timeoutMs:config.timeoutMs,
      parameters:{type:'object',properties,required,additionalProperties:false},output:{schema,render},
      execute:(args,exec)=>serial(()=>{
        exec.signal?.throwIfAborted();
        if(args.slide!==undefined && (!Number.isSafeInteger(args.slide)||args.slide<1)) throw new Error('slide must be a positive integer');
        return execute(args,exec);
      })}));
  };
  add('office_pane_visibility','Hide or show the Office taskpane. Hiding keeps the document runtime available. The independent add-in uses a long shared runtime; a borrowed CDP taskpane can lose its runtime when closed.',{visible:{type:'boolean'}},['visible'],objectSchema,async(a,e)=>{
    const result=await evaluate(config,'(async()=>{await Office.addin.'+(a.visible?'showAsTaskpane':'hide')+'();return {visible:'+a.visible+'};})()',e.signal);
    hidden = true;
    return result;
  });
  add('office_deck_info','Read the live PowerPoint deck slide IDs, dimensions, masters and layouts. Use before editing; the document runtime must be loaded.',{},[],objectSchema,(_a,e)=>evaluateNow(infoExpression(),e));
  add('office_slide_outline','Read compact shape geometry and text (first 200 characters per shape). Omit slide for whole deck.',{slide:slideParam},[],{type:'array',items:objectSchema},(a,e)=>evaluateNow(outlineExpression(a.slide,true),e));
  add('office_slide_shapes','Read complete text and geometry for all shapes on one slide.',{slide:slideParam},['slide'],{type:'array',items:objectSchema},(a,e)=>evaluateNow(outlineExpression(a.slide),e));
  add('office_client_catalog','List compact client tool summaries and input field names from the loaded Office runtime. Supply name to read the full original input schema and description for one tool. Use before office_client_tool.',{name:{type:'string',description:'Optional exact client tool name; omit for compact summaries.'}},[],jsonSchema,(a,e)=>evaluateNow(clientCallExpression('catalog',a),e));
  add('office_client_tool','Execute a client tool from office_client_catalog in the independent Office runtime. Uses the extracted client implementation, not the Claude model or agent loop. Read the catalog for argument names. OOXML writeback may replace slide IDs; use slide_id_update in subsequent calls. Do not retry unknown writes.',{
    name:{type:'string',description:'Exact client tool name from office_client_catalog.'},
    arguments:{type:'object',additionalProperties:true,description:'Arguments accepted by that client tool.'},
  },['name','arguments'],jsonSchema,(a,e)=>evaluateNow(clientCallExpression(a.name,a.arguments),e));
  add('office_run_ooxml','Run an async JavaScript body against one slide PPTX archive. Provides zip, markDirty, DOMParser, XMLSerializer and escapeXml. Read-only return without markDirty does not import a replacement. After markDirty writeback confirms the replacement before deleting the original; inspect slide_id_update for the new slide ID.',{
    slide_id:{type:'string',description:'Current slide ID from office_deck_info, not a page number.'},
    code:{type:'string',description:'Async function body receiving { zip, markDirty }; call markDirty() only when files were modified.'},
    autosize_shape_ids:{type:'array',items:{type:'string'}},
  },['slide_id','code'],jsonSchema,(a,e)=>evaluateNow(clientCallExpression('edit_slide_xml',a),e));
  add('office_run_js','Execute an async JavaScript body in the live Office pane. Office and PowerPoint are available. Use return for a JSON-serializable result. This is not the Claude sandbox: insertImage, blobs and JSZip helpers are not supplied. No automatic retries; changes may be partial on failure.',{code:{type:'string',description:'Async function body, normally using await PowerPoint.run(async ctx => {...}).'}},['code'],jsonSchema,(a,e)=>evaluateNow('(async () => {'+a.code+'})()',e));
  add('office_verify_layout','Check slide bounds, empty placeholders and possible overlaps. Heuristic only; also render and inspect slides.',{slide:slideParam},[],objectSchema,async(a,e)=>{
    const info=await evaluateNow(infoExpression(),e); const data=await evaluateNow(outlineExpression(a.slide),e); return verifyLayout(data,info.page);
  });
  add('office_insert_image','Insert PNG/JPEG/GIF/BMP bytes onto a slide via Office.js, without a Windows file path. Provide exactly one of filePath (on DSH machine) or base64. Coordinates are points; omitted height preserves aspect ratio. Changes the selected slide.',{
    slide:slideParam,filePath:{type:'string'},base64:{type:'string'},left:{type:'number'},top:{type:'number'},width:{type:'number'},height:{type:'number'},
  },['slide'],objectSchema,async(a,e)=>{
    if ((a.filePath===undefined)===(a.base64===undefined)) throw new Error('Provide exactly one of filePath or base64');
    const base64=a.filePath!==undefined?(await readFile(a.filePath,{signal:e.signal})).toString('base64'):a.base64;
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Expected raw base64, without a data URL prefix');
    for(const key of ['width','height']) if(a[key]!==undefined && (!Number.isFinite(a[key])||a[key]<=0)) throw new Error(key+' must be positive');
    const placement={}; for (const [key,target] of [['left','imageLeft'],['top','imageTop'],['width','imageWidth'],['height','imageHeight']]) if(a[key]!==undefined) placement[target]=a[key];
    return evaluateNow(imageExpression(a.slide,base64,placement),e);
  });
  add('office_render_slide','Render the taskpane-bound slide through Office.js and return PNG directly for visual inspection. When explicitly configured renderBackend: com, render through the Windows helper or local PowerShell; that mode uses ActivePresentation and requires the intended deck to stay active.',{slide:slideParam},['slide'],{type:'object',properties:{slide:slideParam,image:imageSchema},required:['slide','image'],additionalProperties:false},async(a,e)=>{
    const guard=await evaluateNow(deckSizeExpression(a.slide),e);
    const data=await renderSlide(config,a.slide,{signal:e.signal,expectSlides:guard?.slideCount});
    const image=await ctx.attachments.saveImage({data,mediaType:'image/png',name:'slide-'+a.slide+'.png'});
    return {slide:a.slide,image:{...image,attachmentId:String(image.attachmentId)}};
  },(_a,v)=>[{type:'text',text:JSON.stringify({slide:v.slide,width:v.image.width,height:v.image.height})},{type:'image',attachment:v.image}]);
  const summary={name:'ppt-officejs',description:'通过 office_* 原生工具操作当前 PowerPoint；自有加载项提供客户端工具执行层，支持 Office.js、OOXML 及页面渲染，不依赖 Claude 登录或模型。',provider:name,source:'bundled',invocation:{modelInvocable:true,userInvocable:true}};
  ctx.effect(()=>ctx.skills.registerProvider(()=>({name,list:async()=>[{...summary,rank:600,locator:'embedded'}],get:async()=>({...summary,content:skillContent})})));
}

const skillContent = `# PowerPoint Office.js 操作手册

当前 PowerPoint 文档是唯一真实状态，DSH agent 负责决策，不使用 Claude 模型或 agent loop。自有 Office Helper 加载项通过共享长运行时连接 Windows helper，不需要 Claude 侧栏、登录或 CDP；旧 cdp backend 仅在借用其他侧栏时需要调试端口。默认首次文档调用自动隐藏侧栏；office_pane_visibility({visible:false}) 隐藏，{visible:true} 恢复显示。隐藏后可以继续控制。自有加载项可显式启用随文档自动启动并保存，首次文档仍需加载；不承诺所有新文档静默加载。借用的旧 CDP 侧栏不要关闭。由 DSH agent 决策，可用 subagent 分工；共享文档的工具调用串行执行。

## 工具与编辑循环

1. 调用 office_deck_info 获取真实页面尺寸、slide ID、母版及版式 ID。
2. 调用 office_slide_outline 获取摘要，office_slide_shapes 获取单页完整文本和形状。
3. 用 office_run_js 执行异步函数体；必须显式 return 返回 JSON 结果。它不是 SES 沙箱，没有 insertImage、blobs、JSZip 等 Claude 私有 helper。
4. 用 office_insert_image 插入图片；filePath 是 DSH 机器上的路径，不是 Windows 路径。也可传裸 base64。无需先上传到 Windows。
5. 修改后调用 office_render_slide，工具直接返回 PNG 图片，亲眼检查后再判断排版。默认使用当前文档的 Office.js getImageAsBase64；显式配置 renderBackend: com 才使用本机或 helper 的 COM 导出，该模式需保持目标文档为活动文稿。
6. 最后调用 office_verify_layout。几何结果仅作提示，不替代视觉检查；容器内文字等完全包含关系被忽略，部分重叠可能是有意设计。无告警不代表视觉正确。

按单页小步修改、渲染、检查、修正。同一问题三轮仍未解决就说明现状。错误或超时可能发生在部分修改之后，先读取现状，不盲目重试。不要删除用户已有内容来消除告警。

## 已验证的 API 细节

- Office.js 长度单位为 pt，尺寸从 pageSetup 读取，不假定是 960×540。
- 使用 await PowerPoint.run(async ctx => {...})；对象 load 后 await ctx.sync() 再读属性，写入也需要 sync。
- shape.fill.setSolidColor("C2532E")；页面背景用 slide.background.fill.setSolidFill({color:"#FAF8F5"})，两者不同。
- slide.shapes.addTextBox(text, {left,top,width,height}) 创建原生可编辑文本框。
- ctx.presentation.slides.add(...) 返回 void；新增后 load collection 的 items/id 并 sync，再从 items 取得新页，不要对 add 的返回值调用 load。
- 新增页可能继承空 Title/Subtitle 占位符；读取并删除不需要的占位符，不留下看不见的空框。
- 形状名、版式名随 Office UI 语言变化；用 ID，不硬编码中文或英文名。
- getTextFrameOrNullObject() 后先 load("isNullObject")、sync，再判断；非空后才能读取 textRange/text。
- 表格高度应通过行高和内容控制，直接写 shape.height 不一定生效。
- 修改 textFrame.textRange.text 可能丢失原来的局部文字格式，保留格式时先检查对象。
- 图片通过 Office.context.document.setSelectedDataAsync(base64,{coercionType:"image",...}) 插入当前选中页；使用 office_insert_image 自动先跳转目标页。只传 width 时保持宽高比。
- 普通对象操作默认使用 Office.js；Office.js 未覆盖的属性使用 office_run_ooxml。先读当前 XML，再修改；只读不调用 markDirty()，避免无意义导入。
- 调用 office_client_catalog 获取摘要，传 name 按需读取某一工具的完整原始 schema；office_client_tool 使用原客户端工具名执行，不臆造工具或参数。
- 需要创建普通图表时优先调用 create_slide_chart；先 read_chart_style 了解原图表。图表形状是原生 Chart，不要用矩形冒充；复杂形式用 edit_slide_chart。图表 spec 的 position 使用 EMU，不是 pt。
- read_slide_text 返回段落 XML，edit_slide_text 接收原始 a:p 段落（不是 JavaScript），保留正文容器属性；ref 使用 list_slide_shapes 返回的 slideId:shapeId，不能凭页码拼。
- find_and_replace 支持 include_notes 和 dry_run；读备注可在 office_run_ooxml 中读取 notesSlide XML，无备注时需要创建 notes part、rels 和 content type，不假定文件已经存在。
- edit_slide_master 按原实现编辑第 1 页所属母版；不是任意 master_id 定位工具。只迁移原母版的版式关联页，其它母版不做全局归一化。
- verify_slide_visual 的原模型 reviewer 与 export_deck_outline 的 Conductor 广播不离线搬运：视觉复核用 office_render_slide 返回图片由当前 DSH agent 完成；本地摘要用 office_slide_outline。
- 原模板图表写入原生 chart XML 和数据缓存；不凭此声称生成了可在 Excel 中编辑的内嵌工作簿。已有嵌入 XLSX 修改由提取的真实 workbook validator 检查。
- 图标通过原 search_icons/insert_icon 流程，先搜索再插入，插入保留 SVG 和 PNG fallback；需要外部图标服务的网络连接。
- OOXML 写回可能更换 slide ID；检查返回的 slide_id_update，随后用新 ID。需要时重新读取页面摘要，不能继续缓存旧对象。
- 母版编辑的影响范围由运行时工具定义；不把所有页面强制统一到一个母版，不以“多个母版”本身作为缺陷。

## 设计规则

- 一页一个信息，标题说结论。先适应当前模板，不默认深蓝背景或覆盖原有配色。
- 使用一个强调色，保持标题位置、卡片、间距一致；文字离容器边缘留 10–15pt。
- 投影可读性优先：标题通常 40–48pt，正文 20–28pt，注释不低于 16pt；按真实画布调整。
- 显式设置字体；中文选机器可用的中文字体，避免缺字和细弱字重。
- 公共背景、页码和分隔线优先复用母版，不在每页重复制造对象。
- OOXML 项目符号用 a:buChar，不把项目符号混在正文里；使用合适的悬挂缩进。
- 交付时说明改了哪几页、检查了哪些页，只有实际看过渲染才声称已完成视觉检查。

## 来源与范围

本手册由此前从 Claude for PowerPoint 当前 bundle 提取并改写的项目内 ppt-officejs skill 迁移而来，工具名称与本插件一致；不是原始 system prompt 的完整副本。保留已验证的 Office.js 技术要点，并修正旧手册中的固定画布、文字读取和几何校验表述。调用时不下载或重新解析 bundle。
`;
