// Office collections need an explicit sync before their loaded properties are read.
export const helpers = `
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

export const office = (body: string) => '(async () => {' + helpers + '; return await PowerPoint.run(async ctx => {' + body + '});})()';

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
export function outlineExpression(slide?: number, compact = false) {
  return office(`const items = await slides(ctx); const index = ${JSON.stringify(slide ?? null)};
    const selected = index === null ? items.map((s,i)=>({s,i:i+1})) : [{s:at(items,index),i:index}];
    const result=[]; for (const {s,i} of selected) { const shapes=await rows(ctx,s);
      result.push({slide:i,id:s.id,shapes:${compact ? "shapes.map(s=>({...s,text:s.text.slice(0,200)}))" : 'shapes'}}); } return result;`);
}

/** Deck size, used to refuse rendering a different PowerPoint window. */
export function deckSizeExpression(slide: number) {
  return office(`const items = await slides(ctx); at(items, ${JSON.stringify(slide)}); return {slideCount: items.length};`);
}

/** Encode the public Office image insertion API; send bytes through the selected backend. */
export function imageExpression(slide: number, base64: string, placement: Record<string, number>) {
  return '(async () => {' + helpers + `
    await PowerPoint.run(async ctx=>at(await slides(ctx),${slide}));
    await new Promise((resolve,reject)=>Office.context.document.goToByIdAsync(${slide},Office.GoToType.Index,r=>r.error?reject(new Error(r.error.message)):resolve()));
    await new Promise((resolve,reject)=>Office.context.document.setSelectedDataAsync(${JSON.stringify(base64)},${JSON.stringify({ coercionType: 'image', ...placement })},r=>r.error?reject(new Error(r.error.message)):resolve()));
    return {slide:${slide},inserted:true}; })()`;
}

/** Build a dispatch request without interpreting model-supplied argument strings as code. */
export function clientCallExpression(name: string, args: unknown = {}) {
  const available = 'if(!globalThis.OfficeClientRuntime) throw new Error("Client execution runtime is not loaded. Open the independent Office Helper add-in.");';
  return '(async()=>{' + available + 'return await globalThis.OfficeClientRuntime.execute(' + JSON.stringify(name) + ',' + JSON.stringify(args) + ');})()';
}
