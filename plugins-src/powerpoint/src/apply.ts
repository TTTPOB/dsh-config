import { readFile } from 'node:fs/promises';
import { officeArgs } from './files.ts';
import { name, type Config } from './config.ts';
import { evaluate, helperRequest, paneError } from './transport.ts';
import { infoExpression, outlineExpression, deckSizeExpression, imageExpression, clientCallExpression } from './expressions.ts';
import { renderSlide } from './render.ts';
import { startCatalog } from '../../shared/catalog.ts';
import { catalogDefinitions } from './catalog-overrides.ts';
import { officeTool } from './office-tool.ts';
import { objectSchema, jsonSchema, textRender, slideParam, imageSchema } from './schemas.ts';
import type { Tool, AddTool, Args, Context, Execution, Schema, Render, ObjectSchema } from '../../shared/types.ts';
import skillContent from '../SKILL.md?raw';
export const inject = ['tools', 'skills', 'attachments'];

/** Register tools and the embedded provider; serialize operations across agents sharing the deck. */
export function apply(ctx: Context, config: Config) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <V>(fn: () => Promise<V>) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const selections = new Map<string | null, string>();
  const hidden = new Set<string | null | undefined>();
  const sessionKey = (exec: Execution) => exec.agent?.session?.id ?? null;
  const selected = (exec: Execution) => selections.get(sessionKey(exec));
  const panes = (exec: Execution) => {
    return helperRequest<{ panes: { sessionId: string }[] }>(config, '/panes', undefined, exec.signal);
  };
  const paneKey = async (exec: Execution) => {
    if (selected(exec) !== undefined) return selected(exec);
    const data = await panes(exec);
    return data.panes.length === 1 ? data.panes[0].sessionId : undefined;
  };
  const evaluateNow = async (code: string, exec: Execution) => {
    if (config.autoHide) {
      const key = await paneKey(exec);
      if (!hidden.has(key)) {
        await evaluate(config, '(async()=>{await Office.addin.hide();return true;})()', exec.signal, selected(exec));
        hidden.add(key);
      }
    }
    return evaluate(config, code, exec.signal, selected(exec));
  };
  const makeTool = <const S extends Schema, V>(
    toolName: string,
    description: string,
    parameters: S,
    schema: Schema,
    execute: (args: Args<S>, exec: Execution) => Promise<V>,
    render: Render<V> = textRender,
  ): Tool<S, V> => {
    return {
      name: toolName,
      deferLoading: true,
      description,
      timeoutMs: config.timeoutMs,
      parameters,
      output: { schema, render },
      execute: (args, exec) => serial(() => {
        exec.signal?.throwIfAborted();
        const slide = (args as { slide?: number }).slide;
        if (slide !== undefined && (!Number.isSafeInteger(slide) || slide < 1))
          throw new Error('slide must be a positive integer');
        return execute(args, exec);
      }),
    };
  };
  const register = <const S extends Schema, V>(
    ...args: Parameters<typeof makeTool<S, V>>
  ) => { ctx.effect(() => ctx.tools.register(makeTool(...args))); };
  const add: AddTool = (toolName, description, properties, required, schema, execute, render) => {
    const parameters: ObjectSchema<typeof properties, typeof required> = {
      type: 'object', properties, required, additionalProperties: false,
    };
    register(toolName, description, parameters, schema, execute, render);
  };
  add('powerpoint_list_presentations', 'List connected PowerPoint presentations with pane sessionId, label, documentUrl and connectedAt, plus selectedTarget for this DSH session (null when unset). Requires the helper backend.', {}, [], objectSchema,
    async (_args, exec) => ({ ...await panes(exec), selectedTarget: selected(exec) ?? null }));
  add('powerpoint_select_presentation', 'Select a connected PowerPoint presentation for subsequent tools in this DSH session. Use a sessionId from powerpoint_list_presentations; a disconnected target is never replaced automatically. Requires the helper backend.',
    { target: { type: 'string', description: 'Pane sessionId from powerpoint_list_presentations.' } }, ['target'], objectSchema, async (args, exec) => {
      const data = await panes(exec);
      if (!data.panes.some(pane => pane.sessionId === args.target)) throw paneError({ code: 'target-not-found', message: 'The requested PowerPoint taskpane is not connected.', panes: data.panes });
      selections.set(sessionKey(exec), args.target);
      return { ...data, selectedTarget: args.target };
    });
  register('powerpoint_execute_office_js', officeTool.description, officeTool.parameters, jsonSchema,
    async (args, exec) => evaluateNow(clientCallExpression('execute_office_js', await officeArgs(args, exec.signal)), exec));
  const staticNames = new Set([
    'execute_office_js', 'list_presentations', 'select_presentation', 'pane_visibility',
    'deck_info', 'slide_outline', 'insert_image', 'render_slide',
  ]);
  startCatalog(ctx, 'PowerPoint', config,
    signal => helperRequest(config, '/catalog', undefined, signal),
    tools => catalogDefinitions(tools.filter(tool => tool.clientName !== 'execute_office_js')).map(tool => {
      if (staticNames.has(tool.clientName)) throw new Error('PowerPoint catalog conflicts with a DSH-owned tool: ' + tool.clientName);
      return makeTool<Schema, unknown>('powerpoint_' + tool.clientName, tool.description, tool.inputSchema, jsonSchema,
        (args, exec) => evaluateNow(clientCallExpression(tool.clientName, args), exec));
    }));
  add('powerpoint_pane_visibility', 'Hide or show the Office taskpane. Hiding keeps the document runtime available.', { visible: { type: 'boolean' } }, ['visible'], objectSchema, async (a, e) => {
    const key = await paneKey(e);
    const result = await evaluate(config, '(async()=>{await Office.addin.' + (a.visible ? 'showAsTaskpane' : 'hide') + '();return {visible:' + a.visible + '};})()', e.signal, selected(e));
    hidden.add(key);
    return result;
  });
  add('powerpoint_deck_info', 'Read the live PowerPoint deck slide IDs, dimensions, masters and layouts. Use before editing; the document runtime must be loaded.', {}, [], objectSchema, (_a, e) => evaluateNow(infoExpression(), e));
  add('powerpoint_slide_outline', 'Read compact shape geometry and text (first 200 characters per shape). Omit slide for whole deck.', { slide: slideParam }, [], { type: 'array', items: objectSchema }, (a, e) => evaluateNow(outlineExpression(a.slide, true), e));
  add('powerpoint_insert_image', 'Insert a PNG/JPEG/GIF/BMP file from the DSH machine onto a slide via Office.js. filePath is required; no Windows path or inline binary data. Coordinates are points; omitted height preserves aspect ratio. Changes the selected slide.', {
    slide: slideParam, filePath: { type: 'string' }, left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
  }, ['slide', 'filePath'], objectSchema, async (a, e) => {
    const base64 = (await readFile(a.filePath, { signal: e.signal })).toString('base64');
    for (const key of ['width', 'height'] as const) if (a[key] !== undefined && (!Number.isFinite(a[key]) || a[key] <= 0)) throw new Error(key + ' must be positive');
    const placement: Record<string, number> = {}; for (const [key, target] of [['left', 'imageLeft'], ['top', 'imageTop'], ['width', 'imageWidth'], ['height', 'imageHeight']] as const) if (a[key] !== undefined) placement[target] = a[key];
    return evaluateNow(imageExpression(a.slide, base64, placement), e);
  });
  add('powerpoint_render_slide', 'Render the taskpane-bound slide through Office.js and return PNG directly for visual inspection. When explicitly configured renderBackend: com, render through the Windows helper; that mode uses ActivePresentation and requires the intended deck to stay active.', { slide: slideParam }, ['slide'], { type: 'object', properties: { slide: slideParam, image: imageSchema }, required: ['slide', 'image'], additionalProperties: false }, async (a, e) => {
    const guard = await evaluateNow(deckSizeExpression(a.slide), e) as { slideCount?: number } | null;
    const data = await renderSlide(config, a.slide, { signal: e.signal, expectSlides: guard?.slideCount, target: selected(e) });
    const image = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'slide-' + a.slide + '.png' });
    return { slide: a.slide, image: { ...image, attachmentId: String(image.attachmentId) } };
  }, (_a, v) => [{ type: 'text', text: JSON.stringify({ slide: v.slide, width: v.image.width, height: v.image.height }) }, { type: 'image', attachment: v.image }]);
  const summary = { name: 'powerpoint', description: 'Create, edit, and inspect the current PowerPoint presentation using native powerpoint_* tools. Covers Office.js, OOXML, text formatting, charts, masters, notes, images, and rendered slide review.', provider: name, source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } };
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name, list: async () => [{ ...summary, rank: 600, locator: 'embedded' }], get: async () => ({ ...summary, content: skillContent }) })));
}
