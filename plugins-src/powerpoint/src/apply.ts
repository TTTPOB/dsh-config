import { officeCode } from '../../shared/office-files.ts';
import { rejectUnknownArguments } from '../../shared/office-arguments.ts';
import { readImageBase64 } from '../../shared/office-images.ts';
import { name, type Config } from './config.ts';
import { evaluate, helperRequest, paneError } from './transport.ts';
import { infoExpression, slideIdsExpression, outlineExpression, deckSizeExpression, imageExpression, clientCallExpression, checkSlideLocator, verifySlidesExpression, type VerifySelection } from './expressions.ts';
import { renderSlide } from './render.ts';
import { startCatalog } from '../../shared/catalog.ts';
import { catalogDefinitions } from './catalog-overrides.ts';
import { catalogOutputSchemas } from './catalog-output-schemas.ts';
import { officeTool } from './office-tool.ts';
import { objectSchema, jsonSchema, textRender, slideParam, slideLocatorProperties, imageSchema } from './schemas.ts';
import type { Tool, AddTool, Args, Context, Execution, Schema, Render, ObjectSchema } from '../../shared/types.ts';
import skillContent from '../SKILL.md?raw';
export const inject = ['tools', 'skills', 'attachments'];

// Leave time for the successful write to reach Harness before its outer timeout.
const READBACK_BUDGET_MS = 750;
const READBACK_MARGIN_MS = 50;

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
    execute: (args: Args<S>, exec: Execution, deadline: number) => Promise<V>,
    render: Render<V> = textRender,
  ): Tool<S, V> => {
    return {
      name: toolName,
      deferLoading: true,
      description,
      timeoutMs: config.timeoutMs,
      parameters,
      output: { schema, render },
      execute: (args, exec) => {
        const deadline = performance.now() + config.timeoutMs;
        return serial(() => {
          exec.signal?.throwIfAborted();
          rejectUnknownArguments(args, parameters);
          return execute(args, exec, deadline);
        });
      },
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
    async (args, exec) => evaluateNow(clientCallExpression('execute_office_js', { code: await officeCode(args, exec.signal) }), exec));
  const staticNames = new Set([
    'execute_office_js', 'list_presentations', 'select_presentation', 'pane_visibility',
    'deck_info', 'slide_outline', 'insert_image', 'render_slide',
  ]);
  startCatalog(ctx, 'PowerPoint', config,
    signal => helperRequest(config, '/catalog', undefined, signal),
    tools => catalogDefinitions(tools.filter(tool => tool.clientName !== 'execute_office_js')).map(tool => {
      if (staticNames.has(tool.clientName)) throw new Error('PowerPoint catalog conflicts with a DSH-owned tool: ' + tool.clientName);
      const outputSchema = Object.hasOwn(catalogOutputSchemas, tool.clientName) ? catalogOutputSchemas[tool.clientName]! : jsonSchema;
      return makeTool<Schema, unknown>('powerpoint_' + tool.clientName, tool.description, tool.inputSchema, outputSchema,
        async (args, exec, deadline) => {
          if (tool.clientName === 'verify_slides') return evaluateNow(verifySlidesExpression(args as VerifySelection), exec);
          const call = clientCallExpression(tool.clientName, args);
          if (tool.clientName !== 'duplicate_slide') return evaluateNow(call, exec);
          const readIds = (execution: Execution) => evaluateNow(slideIdsExpression(), execution) as Promise<string[]>;
          const before = new Set(await readIds(exec));
          const result = await evaluateNow(call, exec) as { success: true };
          const budget = Math.min(READBACK_BUDGET_MS, Math.floor(deadline - performance.now() - READBACK_MARGIN_MS));
          if (budget < 1) return result;
          const timeout = AbortSignal.timeout(budget);
          const signal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout;
          // A failed readback does not undo the duplicate; keep the successful result.
          const after = await readIds({ ...exec, signal }).catch(() => undefined);
          const added = after?.filter(id => !before.has(id));
          return added?.length === 1 ? { ...result, new_slide_id: added[0] } : result;
        });
    }));
  add('powerpoint_pane_visibility', 'Hide or show the Office taskpane. Hiding keeps the document runtime available.', { visible: { type: 'boolean' } }, ['visible'], objectSchema, async (a, e) => {
    const key = await paneKey(e);
    const result = await evaluate(config, '(async()=>{await Office.addin.' + (a.visible ? 'showAsTaskpane' : 'hide') + '();return {visible:' + a.visible + '};})()', e.signal, selected(e));
    hidden.add(key);
    return result;
  });
  add('powerpoint_deck_info', 'Read the live PowerPoint deck slide IDs, dimensions, masters and layouts. Use before editing; the document runtime must be loaded.', {}, [], objectSchema, (_a, e) => evaluateNow(infoExpression(), e));
  add('powerpoint_slide_outline', 'Read shape geometry and up to 200 text characters per shape. Pass at most one of slide_id or slide_index; omit both for the whole deck.', slideLocatorProperties, [], { type: 'array', items: objectSchema }, async (a, e) => {
    checkSlideLocator(a, true);
    return evaluateNow(outlineExpression(a, true), e);
  });
  add('powerpoint_insert_image', 'Insert a PNG/JPEG/GIF/BMP file from the DSH machine. Pass exactly one of slide_id or slide_index. Coordinates are in points; omitting height preserves aspect ratio. Changes the selected slide.', {
    ...slideLocatorProperties, filePath: { type: 'string' }, left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
  }, ['filePath'], objectSchema, async (a, e) => {
    checkSlideLocator(a);
    const base64 = await readImageBase64(a, e.signal);
    const placement: Record<string, number> = {}; for (const [key, target] of [['left', 'imageLeft'], ['top', 'imageTop'], ['width', 'imageWidth'], ['height', 'imageHeight']] as const) if (a[key] !== undefined) placement[target] = a[key];
    return evaluateNow(imageExpression(a, base64, placement), e);
  });
  add('powerpoint_render_slide', 'Render a slide as a PNG. Pass exactly one of slide_id or slide_index. If configured to use COM, keep the intended presentation active.', slideLocatorProperties, [], { type: 'object', properties: { slide: slideParam, image: imageSchema }, required: ['slide', 'image'], additionalProperties: false }, async (a, e) => {
    checkSlideLocator(a);
    const { slideCount, slideIndex } = await evaluateNow(deckSizeExpression(a), e) as { slideCount: number; slideIndex: number };
    const data = await renderSlide(config, slideIndex, { signal: e.signal, expectSlides: slideCount, target: selected(e) });
    const image = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'slide-' + slideIndex + '.png' });
    return { slide: slideIndex, image: { ...image, attachmentId: String(image.attachmentId) } };
  }, (_a, v) => [{ type: 'text', text: JSON.stringify({ slide: v.slide, width: v.image.width, height: v.image.height }) }, { type: 'image', attachment: v.image }]);
  const summary = { name: 'powerpoint', description: 'Create, edit, and inspect the current PowerPoint presentation using native powerpoint_* tools. Covers Office.js, OOXML, text formatting, charts, masters, notes, images, and rendered slide review.', provider: name, source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } };
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name, list: async () => [{ ...summary, rank: 600, locator: 'embedded' }], get: async () => ({ ...summary, content: skillContent }) })));
}
