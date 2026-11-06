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
    const value = { endpoint: 'http://127.0.0.1:9224', targetUrl: 'https://pivot.claude.ai/', timeoutMs: 90000,
      powershell: 'powershell.exe', renderWidth: 1280, renderHeight: 720, autoHide: true, ...input };
    const issues = [];
    for (const key of ['endpoint', 'targetUrl']) {
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

/** Evaluate once; never retry writes whose completion is unknown. */
export async function evaluate(config, expression, signal) {
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

/** Export PNG through local Windows COM and return bytes on stdout, not a Windows path. */
export async function renderSlide(config, slide, signal) {
  if (!Number.isSafeInteger(slide) || slide < 1) throw new Error('slide must be a positive integer');
  const script = `$ErrorActionPreference = 'Stop'
$p = [IO.Path]::Combine([IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString() + '.png')
try {
  $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
  $app.ActivePresentation.Slides.Item(${slide}).Export($p, 'PNG', ${config.renderWidth}, ${config.renderHeight})
  [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
} finally { if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) } }`;
  const { stdout } = await runFile(config.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')],
    { signal, timeout: config.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const bytes = Buffer.from(stdout.trim(), 'base64');
  if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PowerPoint did not return a PNG');
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
  add('office_pane_visibility','Hide or show the Office taskpane without closing its document runtime. Hiding preserves CDP control; closing the pane with × does not.',{visible:{type:'boolean'}},['visible'],objectSchema,async(a,e)=>{
    const result=await evaluate(config,'(async()=>{await Office.addin.'+(a.visible?'showAsTaskpane':'hide')+'();return {visible:'+a.visible+'};})()',e.signal);
    hidden = true;
    return result;
  });
  add('office_deck_info','Read the live PowerPoint deck slide IDs, dimensions, masters and layouts. Use before editing; Office pane must stay open.',{},[],objectSchema,(_a,e)=>evaluateNow(infoExpression(),e));
  add('office_slide_outline','Read compact shape geometry and text (first 200 characters per shape). Omit slide for whole deck.',{slide:slideParam},[],{type:'array',items:objectSchema},(a,e)=>evaluateNow(outlineExpression(a.slide,true),e));
  add('office_slide_shapes','Read complete text and geometry for all shapes on one slide.',{slide:slideParam},['slide'],{type:'array',items:objectSchema},(a,e)=>evaluateNow(outlineExpression(a.slide),e));
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
  add('office_render_slide','Render a slide with local Windows PowerPoint COM and return its PNG directly for visual inspection. Requires PowerShell on the DSH machine; forwarding CDP alone does not forward COM. Renders the active presentation; keep the intended deck active.',{slide:slideParam},['slide'],{type:'object',properties:{slide:slideParam,image:imageSchema},required:['slide','image'],additionalProperties:false},async(a,e)=>{
    await evaluateNow(outlineExpression(a.slide,true),e);
    const data=await renderSlide(config,a.slide,e.signal);
    const image=await ctx.attachments.saveImage({data,mediaType:'image/png',name:'slide-'+a.slide+'.png'});
    return {slide:a.slide,image:{...image,attachmentId:String(image.attachmentId)}};
  },(_a,v)=>[{type:'text',text:JSON.stringify({slide:v.slide,width:v.image.width,height:v.image.height})},{type:'image',attachment:v.image}]);
  const summary={name:'ppt-officejs',description:'通过 office_* 原生工具和 CDP 读写正在打开的 PowerPoint，生成、修改演示文稿、插入图片并查看页面渲染。',provider:name,source:'bundled',invocation:{modelInvocable:true,userInvocable:true}};
  ctx.effect(()=>ctx.skills.registerProvider(()=>({name,list:async()=>[{...summary,rank:600,locator:'embedded'}],get:async()=>({...summary,content:skillContent})})));
}

const skillContent = `# PowerPoint Office.js 操作手册

本插件复用当前 Office 侧栏的 Office.js 运行时，不使用 Claude 模型或 agent loop。侧栏运行时和 CDP 必须保持开启，不需要登录。默认首次文档调用自动隐藏侧栏；office_pane_visibility({visible:false}) 隐藏，{visible:true} 恢复显示。隐藏后可以继续控制，不要点 × 关闭侧栏。由 DSH agent 决策，可用 subagent 分工；共享文档的工具调用串行执行。

## 工具与编辑循环

1. 调用 office_deck_info 获取真实页面尺寸、slide ID、母版及版式 ID。
2. 调用 office_slide_outline 获取摘要，office_slide_shapes 获取单页完整文本和形状。
3. 用 office_run_js 执行异步函数体；必须显式 return 返回 JSON 结果。它不是 SES 沙箱，没有 insertImage、blobs、JSZip 等 Claude 私有 helper。
4. 用 office_insert_image 插入图片；filePath 是 DSH 机器上的路径，不是 Windows 路径。也可传裸 base64。无需先上传到 Windows。
5. 修改后调用 office_render_slide，工具直接返回 PNG 图片，亲眼检查后再判断排版。渲染目前使用本机 PowerShell/COM；仅转发 CDP 的远端无法使用此渲染工具。确保目标文档为 PowerPoint 活动演示文稿。
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
- 复杂图表和母版 OOXML 操作没有封装好的专用工具；不要假称支持。若自行做 zip 往返，要保留 sourceSlideIds 和相关关系，并检查母版增长；页面没有预装 JSZip 的保证。

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
