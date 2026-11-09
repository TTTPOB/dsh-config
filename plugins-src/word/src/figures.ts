import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { objectSchema } from './schemas.ts';
import type { AddTool, Execution } from '../../shared/types.ts';

/** Office.js helpers shared by the figure tools; arguments arrive as one JSON literal. */
export const figureLibrary = String.raw`async function findAnchor(ctx, doc, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('anchor_text is required');
  const head = text.length > 255 ? text.slice(0, 255) : text;
  const hits = doc.body.search(head, { matchCase: true });
  hits.load('items');
  await ctx.sync();
  if (hits.items.length !== 1) throw new Error('anchor_text must match exactly once; found ' + hits.items.length + ' matches. Add surrounding words to make it unique.');
  const hit = hits.getFirst();
  const paragraph = hit.paragraphs.getFirst();
  paragraph.load('text');
  await ctx.sync();
  if (text.length > 255 && !paragraph.text.includes(text)) throw new Error('anchor_text must match exactly once; found 0 matches.');
  return { hit, paragraph };
}
async function updateFields(ctx, doc, label) {
  const fields = doc.body.fields;
  fields.load('items/code');
  await ctx.sync();
  const seq = new RegExp('^\\s*SEQ\\s+' + label.replace(/[.*+?^\${}()|[\]\\]/g, '\\LIB') + '(\\s|$)', 'i');
  const touched = fields.items.filter(f => seq.test(f.code) || /^\s*REF\s/i.test(f.code));
  for (const f of touched) if (seq.test(f.code)) f.updateResult();
  await ctx.sync();
  for (const f of touched) if (!seq.test(f.code)) f.updateResult();
  await ctx.sync();
}
async function insertFigure(ctx, doc, a) {
  const { paragraph: anchor } = await findAnchor(ctx, doc, a.anchor_text);
  const before = a.position === 'before';
  const captionFirst = a.caption_position === 'above';
  const first = anchor.insertParagraph('', before ? 'Before' : 'After');
  const second = first.insertParagraph('', 'After');
  const pic = captionFirst ? second : first;
  const cap = captionFirst ? first : second;
  for (const p of [pic, cap]) p.load('isListItem');
  await ctx.sync();
  for (const p of [pic, cap]) if (p.isListItem) p.detachFromList();
  if (a.figure_style) pic.style = a.figure_style; else { pic.styleBuiltIn = Word.Style.normal; pic.alignment = 'Centered'; }
  if (a.caption_style) cap.style = a.caption_style; else { cap.styleBuiltIn = Word.Style.caption; cap.alignment = 'Centered'; }
  const image = pic.insertInlinePictureFromBase64(a.image, 'Start');
  image.altTextDescription = a.caption;
  if (a.width !== undefined || a.height !== undefined) {
    image.lockAspectRatio = !(a.width !== undefined && a.height !== undefined);
    if (a.width !== undefined) image.width = a.width;
    if (a.height !== undefined) image.height = a.height;
  }
  const content = cap.getRange('Content');
  content.insertText(a.label + ' ', 'Start');
  const field = cap.getRange('Content').insertField('End', Word.FieldType.seq, a.label + ' \\* ARABIC', true);
  const tail = cap.getRange('Content').insertText(a.separator + a.caption, 'End');
  const name = a.bookmark || ('_Ref' + String(Math.floor(1e8 + Math.random() * 9e8)));
  cap.getRange('Start').expandTo(tail.getRange('Start')).insertBookmark(name);
  await ctx.sync();
  await updateFields(ctx, doc, a.label);
  field.result.load('text');
  cap.load('text');
  image.load('width,height');
  await ctx.sync();
  return { bookmark: name, number: field.result.text, caption: cap.text, width: image.width, height: image.height };
}
async function insertCrossReference(ctx, doc, a) {
  const marks = doc.body.getRange('Whole').getBookmarks(true, true);
  await ctx.sync();
  if (!marks.value.some(m => m.toLowerCase() === a.bookmark.toLowerCase())) throw new Error('bookmark not found: ' + a.bookmark + '. Use word_list_figures to read existing bookmarks.');
  const { hit } = await findAnchor(ctx, doc, a.anchor_text);
  const field = hit.insertField(a.position === 'before' ? 'Before' : a.position === 'replace' ? 'Replace' : 'After', Word.FieldType.ref, a.bookmark + ' \\h', true);
  await ctx.sync();
  field.updateResult();
  field.result.load('text');
  await ctx.sync();
  return { bookmark: a.bookmark, text: field.result.text };
}
async function listFigures(ctx, doc) {
  const fields = doc.body.fields;
  fields.load('items/code');
  await ctx.sync();
  const out = [];
  for (const f of fields.items) {
    const m = /^\s*SEQ\s+(\S+)/i.exec(f.code);
    if (!m) continue;
    const p = f.result.paragraphs.getFirst();
    p.load('text');
    const marks = p.getRange('Whole').getBookmarks(true, true);
    f.result.load('text');
    out.push({ label: m[1], f, p, marks });
  }
  await ctx.sync();
  return out.map(x => ({ label: x.label, number: x.f.result.text, caption: x.p.text, bookmarks: x.marks.value }));
}`;

const call = (fn: string, args: unknown) =>
  '(async()=>{return await Word.run(async ctx=>{const doc=ctx.document;' + figureLibrary +
  '\nreturn await ' + fn + '(ctx,doc,' + JSON.stringify(args) + ');});})()';

const fieldIdentifier = /^[\p{L}][\p{L}\p{N}_]*$/u;
const bookmarkName = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const anchor = {
  type: 'string',
  description: 'Text that occurs exactly once in the document body (searched case-sensitively; first 255 characters used for search).',
} as const;

export function registerFigureTools(add: AddTool, evaluateNow: (code: string, exec: Execution) => Promise<unknown>) {
  add(
    'word_insert_figure',
    'Insert an image paragraph and a numbered caption next to the paragraph containing anchor_text. The caption is "<label> <SEQ field><separator><caption>"; label and number are bookmarked so word_insert_cross_reference can cite them, and existing SEQ/REF fields are refreshed so later numbers stay in order. Returns bookmark, number and the caption text read back. Pass the document\'s own figure and caption style names when it has them (see word_verify_doc); otherwise built-in Normal/Caption, centered, are used.',
    {
      filePath: { type: 'string', description: 'Absolute image path on the DSH machine.' },
      anchor_text: anchor,
      position: { type: 'string', enum: ['after', 'before'], description: 'Relative to the anchor paragraph; defaults to after.' },
      caption: { type: 'string', description: 'Caption text after the number, without the label or number.' },
      label: { type: 'string', description: 'Caption label and SEQ identifier, e.g. Figure, Table or 图. Defaults to Figure.' },
      separator: { type: 'string', description: 'Text between the number and caption; defaults to a single space.' },
      caption_position: { type: 'string', enum: ['below', 'above'], description: 'Defaults to below the image.' },
      bookmark: { type: 'string', description: 'Bookmark name for cross-references (letters, digits, underscore; max 40). Defaults to a generated hidden _Ref name.' },
      figure_style: { type: 'string', description: 'Paragraph style name for the image paragraph.' },
      caption_style: { type: 'string', description: 'Paragraph style name for the caption paragraph.' },
      width: { type: 'number', description: 'Image width in points; height follows the aspect ratio unless also given.' },
      height: { type: 'number', description: 'Image height in points.' },
    },
    ['filePath', 'anchor_text', 'caption'],
    objectSchema,
    async (args, exec) => {
      if (typeof args.filePath !== 'string' || !isAbsolute(args.filePath))
        throw new Error('filePath must be an absolute path on the DSH machine');
      const label = args.label ?? 'Figure';
      if (!fieldIdentifier.test(label)) throw new Error('label must be one word of letters, digits or underscore, starting with a letter');
      if (args.bookmark !== undefined && !bookmarkName.test(args.bookmark))
        throw new Error('bookmark must start with a letter or underscore and use at most 40 letters, digits or underscores');
      for (const key of ['width', 'height'] as const)
        if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] <= 0)) throw new Error(key + ' must be positive');
      const image = (await readFile(args.filePath, { signal: exec.signal })).toString('base64');
      const { filePath: _path, ...rest } = args;
      return evaluateNow(call('insertFigure', { ...rest, label, separator: args.separator ?? ' ', image }), exec);
    },
  );
  add(
    'word_insert_cross_reference',
    'Insert a REF field that displays a bookmarked caption label and number (for example "Figure 2") at anchor_text. Use position replace with a unique placeholder such as [[fig-overview]] to drop references into prose. The field updates when numbering changes; returns the displayed text.',
    {
      bookmark: { type: 'string', description: 'Bookmark returned by word_insert_figure or listed by word_list_figures.' },
      anchor_text: anchor,
      position: { type: 'string', enum: ['after', 'before', 'replace'], description: 'Relative to the matched text; defaults to after.' },
    },
    ['bookmark', 'anchor_text'],
    objectSchema,
    async (args, exec) => {
      if (!bookmarkName.test(args.bookmark)) throw new Error('bookmark is not a valid Word bookmark name');
      return evaluateNow(call('insertCrossReference', args), exec);
    },
  );
  add(
    'word_list_figures',
    'List numbered captions (SEQ fields) in document order with label, displayed number, caption paragraph text and the bookmarks on that paragraph, so existing figures and tables can be cross-referenced.',
    {},
    [],
    objectSchema,
    async (_args, exec) => ({ figures: await evaluateNow(call('listFigures', {}), exec) }),
  );
}
