import { startCatalog } from '../../shared/catalog.ts';
import { catalogDefinitions } from './catalog-overrides.ts';
import { officeTool } from './office-tool.ts';
import { clientCallExpression, evaluate, requestHelper, paneError } from './transport.ts';
import { officeCode } from './files.ts';
import { objectSchema, jsonSchema, textRender } from './schemas.ts';
import { registerZoteroTools } from './zotero.ts';
import { registerImageTools } from './images.ts';
import { registerFigureTools } from './figures.ts';
import { name, type Config } from './config.ts';
import type { Tool, AddTool, Args, Context, Execution, ObjectSchema, Render, Schema } from '../../shared/types.ts';
import type { PaneList } from './transport.ts';
import type { OfficeArgs } from './files.ts';

export const inject = ['tools', 'skills', 'attachments'];

/** Register static tools and a catalog-backed skill provider; serialize document operations. */
export function apply(ctx: Context, config: Config) {
  let tail: Promise<unknown> = Promise.resolve();
  const selections = new Map<string | null, string>();
  const hidden = new Set<string | undefined>();
  const sessionKey = (exec: Execution) => exec.agent?.session?.id ?? null;
  const selected = (exec: Execution) => selections.get(sessionKey(exec));
  const targetBody = (exec: Execution) => (selected(exec) === undefined ? {} : { target: selected(exec) });
  const panes = (exec: Execution) => requestHelper<PaneList>(config, '/panes', undefined, exec.signal);
  const paneKey = async (exec: Execution) => {
    if (selected(exec) !== undefined) return selected(exec);
    const data = await panes(exec);
    return data.panes.length === 1 ? data.panes[0].sessionId : undefined;
  };
  const serial = <V>(fn: () => Promise<V>) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const hideOnce = async (exec: Execution) => {
    if (config.autoHide) {
      const key = await paneKey(exec);
      if (!hidden.has(key)) {
        await evaluate(
          config,
          '(async()=>{await Office.addin.hide();return true;})()',
          exec.signal,
          selected(exec),
        );
        hidden.add(key);
      }
    }
  };
  const evaluateNow = async (code: string, exec: Execution) => {
    await hideOnce(exec);
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
      execute: (args, exec) =>
        serial(() => {
          exec.signal?.throwIfAborted();
          return execute(args, exec);
        }),
    };
  };
  const register = <const S extends Schema, V>(
    ...args: Parameters<typeof makeTool<S, V>>
  ) => { ctx.effect(() => ctx.tools.register(makeTool(...args))); };
  const add: AddTool = (toolName, description, properties, required, schema, execute, render) => {
    const parameters: ObjectSchema<typeof properties, typeof required> = {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
    register(toolName, description, parameters, schema, execute, render);
  };
  add(
    'word_list_documents',
    'List connected Word documents with pane sessionId, label, documentUrl and connectedAt, plus selectedTarget for this DSH session (null when unset).',
    {},
    [],
    objectSchema,
    async (_args, exec) => ({ ...(await panes(exec)), selectedTarget: selected(exec) ?? null }),
  );
  add(
    'word_select_document',
    'Select a connected Word document for subsequent tools in this DSH session. Use a sessionId from word_list_documents; a disconnected target is never replaced automatically.',
    { target: { type: 'string', description: 'Pane sessionId from word_list_documents.' } },
    ['target'],
    objectSchema,
    async (args, exec) => {
      const data = await panes(exec);
      if (!data.panes.some((pane) => pane.sessionId === args.target))
        throw paneError({
          code: 'target-not-found',
          message: 'The requested Word taskpane is not connected.',
          panes: data.panes,
        });
      selections.set(sessionKey(exec), args.target);
      return { ...data, selectedTarget: args.target };
    },
  );
  register('word_execute_office_js', officeTool.description, officeTool.parameters, jsonSchema,
    async (args, exec) => evaluateNow(clientCallExpression('execute_office_js',
      args.files === undefined ? args : { code: await officeCode(args as OfficeArgs, exec.signal) }), exec));
  const staticNames = new Set([
    'execute_office_js', 'list_documents', 'select_document', 'pane_visibility', 'insert_image', 'render_page', 'insert_figure', 'insert_cross_reference', 'list_figures',
    'zotero_insert_citation', 'zotero_insert_bibliography', 'zotero_refresh', 'zotero_inspect', 'zotero_set_style',
  ]);
  const catalog = startCatalog(ctx, 'Word', config,
    signal => requestHelper(config, '/catalog', undefined, signal),
    tools => catalogDefinitions(tools.filter(tool => tool.clientName !== 'execute_office_js')).map(tool => {
      if (staticNames.has(tool.clientName)) throw new Error('Word catalog conflicts with a DSH-owned tool: ' + tool.clientName);
      return makeTool<Schema, unknown>('word_' + tool.clientName, tool.description, tool.inputSchema, jsonSchema,
        async (input, exec) => {
          const args = input as Record<string, unknown>;
          const options = tool.clientName === 'edit_doc_list' && args.action === 'create_list'
            ? { listStyles: await requestHelper(config, '/word/list-styles'
              + (selected(exec) === undefined ? '' : '?target=' + encodeURIComponent(selected(exec)!)), undefined, exec.signal) }
            : {};
          return evaluateNow(clientCallExpression(tool.clientName, args, options), exec);
        });
    }));
  registerZoteroTools(add, config, evaluateNow, targetBody);
  add(
    'word_pane_visibility',
    'Hide or show the Word taskpane without closing its document runtime.',
    { visible: { type: 'boolean' } },
    ['visible'],
    objectSchema,
    async (args, exec) => {
      const key = await paneKey(exec);
      const result = await evaluate(
        config,
        '(async()=>{await Office.addin.' +
          (args.visible ? 'showAsTaskpane' : 'hide') +
          '();return {visible:' +
          args.visible +
          '};})()',
        exec.signal,
        selected(exec),
      );
      hidden.add(key);
      return result;
    },
  );
  registerImageTools(add, ctx, config, hideOnce, targetBody, evaluateNow);
  registerFigureTools(add, evaluateNow);
  const summary = {
    provider: name,
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
  };
  ctx.effect(() =>
    ctx.skills.registerProvider(() => ({
      name,
      list: async () => {
        const skill = catalog.current()?.skill;
        return skill ? [{ ...summary, name: skill.name, description: skill.description, rank: 600, locator: 'catalog' }] : [];
      },
      get: async () => {
        const skill = catalog.current()?.skill;
        if (!skill) throw new Error('Word skill unavailable: helper catalog has no skill');
        return { ...summary, ...skill };
      },
    })),
  );
}
