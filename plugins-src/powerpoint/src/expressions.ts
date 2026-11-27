export interface SlideLocator { slide_id?: string; slide_index?: number }
export interface VerifySelection { from_slide?: number; to_slide?: number; slide_ids?: string[] }

/** Enforce selector exclusivity before using Office or the filesystem. */
export function checkSlideLocator({ slide_id, slide_index }: SlideLocator, optional = false) {
  const count = Number(slide_id !== undefined) + Number(slide_index !== undefined);
  if (count > 1 || (!optional && count === 0))
    throw new Error('Pass ' + (optional ? 'at most' : 'exactly') + ' one of slide_id or slide_index.');
}

// Office collections need an explicit sync before their loaded properties are read.
export const helpers = `
async function slides(ctx) {
  const collection = ctx.presentation.slides;
  collection.load('items/id'); await ctx.sync(); return collection.items;
}
function checkIndex(items, index) {
  if (!Number.isInteger(index) || index < 1 || index > items.length)
    throw new Error('Slide index ' + index + ' is outside the current slide count (' + items.length + ').');
  return index;
}
function at(items, index) { return items[checkIndex(items, index) - 1]; }
function byId(items, id) {
  const index = items.findIndex(slide => slide.id === id);
  if (index === -1)
    throw new Error('Slide ID not found: ' + id + '. IDs change after OOXML writebacks; use slide_id_update or read powerpoint_deck_info.');
  return index + 1;
}
function slideIndex(items, locator) {
  return locator.slide_id !== undefined ? byId(items, locator.slide_id) : checkIndex(items, locator.slide_index);
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

/** Read only the current slide IDs, in presentation order. */
export function slideIdsExpression() {
  return 'PowerPoint.run(async ctx=>{const slides=ctx.presentation.slides;slides.load("items/id");await ctx.sync();return slides.items.map(slide=>slide.id);})';
}

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
export function outlineExpression({ slide_id, slide_index }: SlideLocator = {}, compact = false) {
  const selected = slide_id === undefined && slide_index === undefined
    ? 'const selected = items.map((s,i)=>({s,i:i+1}));'
    : `const index = slideIndex(items,${JSON.stringify({ slide_id, slide_index })}); const selected = [{s:items[index-1],i:index}];`;
  return office(`const items = await slides(ctx); ${selected}
    const result=[]; for (const {s,i} of selected) { const shapes=await rows(ctx,s);
      result.push({slide:i,id:s.id,shapes:${compact ? "shapes.map(s=>({...s,text:s.text.slice(0,200)}))" : 'shapes'}}); } return result;`);
}

/** Read the deck size and resolve the render target in the same slide list. */
export function deckSizeExpression({ slide_id, slide_index }: SlideLocator) {
  return office(`const items = await slides(ctx); return {slideCount: items.length, slideIndex: slideIndex(items,${JSON.stringify({ slide_id, slide_index })})};`);
}

/** Encode the public Office image insertion API; send bytes through the selected backend. */
export function imageExpression({ slide_id, slide_index }: SlideLocator, base64: string, placement: Record<string, number>) {
  return '(async () => {' + helpers + `
    const slide = await PowerPoint.run(async ctx=>slideIndex(await slides(ctx),${JSON.stringify({ slide_id, slide_index })}));
    await new Promise((resolve,reject)=>Office.context.document.goToByIdAsync(slide,Office.GoToType.Index,r=>r.error?reject(new Error(r.error.message)):resolve()));
    await new Promise((resolve,reject)=>Office.context.document.setSelectedDataAsync(${JSON.stringify(base64)},${JSON.stringify({ coercionType: 'image', ...placement })},r=>r.error?reject(new Error(r.error.message)):resolve()));
    return {slide,inserted:true}; })()`;
}

const runtimeRequired = 'if(!globalThis.OfficeClientRuntime) throw new Error("Client execution runtime is not loaded. Open the independent Office Helper add-in.");';

/** Build a dispatch request without interpreting model-supplied argument strings as code. */
export function clientCallExpression(name: string, args: unknown = {}) {
  return '(async()=>{' + runtimeRequired + 'return await globalThis.OfficeClientRuntime.execute(' + JSON.stringify(name) + ',' + JSON.stringify(args) + ');})()';
}

/** Verify one covering range, then retain only requested slides for ID selections. */
export function verifySlidesExpression({ from_slide, to_slide, slide_ids }: VerifySelection) {
  if (slide_ids !== undefined && (from_slide !== undefined || to_slide !== undefined))
    throw new Error('Pass slide_ids or from_slide/to_slide, not both.');
  if (slide_ids?.length === 0) throw new Error('slide_ids must contain at least one slide ID.');
  return '(async()=>{' + runtimeRequired + helpers + `
    const {from_slide, to_slide, slide_ids} = ${JSON.stringify({ from_slide, to_slide, slide_ids })};
    const range = (from_slide === undefined && to_slide === undefined && slide_ids === undefined) ? {} : await PowerPoint.run(async ctx => {
      const items = await slides(ctx);
      if (slide_ids !== undefined) {
        const indices = slide_ids.map(id => byId(items,id));
        return {from_slide: Math.min(...indices) - 1, to_slide: Math.max(...indices) - 1};
      }
      if (from_slide !== undefined) checkIndex(items,from_slide);
      if (to_slide !== undefined) checkIndex(items,to_slide);
      if (from_slide > to_slide) throw new Error('from_slide must not be after to_slide.');
      return {...(from_slide === undefined ? {} : {from_slide: from_slide - 1}), ...(to_slide === undefined ? {} : {to_slide: to_slide - 1})};
    });
    const response = await globalThis.OfficeClientRuntime.execute('verify_slides',range);
    const result = response.result;
    return {...response,result:{...result,from_slide:result.from_slide + 1,to_slide:result.to_slide + 1,
      slides:slide_ids === undefined ? result.slides : result.slides.filter(slide=>slide_ids.includes(slide.slideId))}};
  })()`;
}
