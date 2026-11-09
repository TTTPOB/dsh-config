import type { Context, Disposer, Schema, Tool } from './types.ts';

export interface CatalogTool {
  clientName: string;
  description: string;
  inputSchema: Schema & { type: 'object' };
}
export interface Catalog {
  host: 'PowerPoint' | 'Word';
  revision: string;
  source: { bundleSha256: string };
  tools: CatalogTool[];
  skill?: { name: string; description: string; content: string };
}
export interface CatalogPolicy {
  catalogRefreshMs: number;
  catalogRetryInitialMs: number;
  catalogRetryMaxMs: number;
}

/** Validate the helper response before preparing any registry changes. */
export function parseCatalog(value: unknown, host: Catalog['host']): Catalog {
  const catalog = value as Catalog | null;
  if (!catalog || catalog.host !== host || !/^[a-f0-9]{64}$/.test(catalog.revision)
    || !/^[a-f0-9]{64}$/.test(catalog.source?.bundleSha256) || !Array.isArray(catalog.tools))
    throw new Error(host + ' helper returned an invalid catalog');
  if (catalog.skill !== undefined && (!catalog.skill || catalog.skill.name !== 'word' || host !== 'Word'
    || typeof catalog.skill.description !== 'string' || typeof catalog.skill.content !== 'string'))
    throw new Error(host + ' helper returned an invalid catalog skill');
  const names = new Set<string>();
  for (const tool of catalog.tools) {
    if (!tool || typeof tool.clientName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tool.clientName)
      || names.has(tool.clientName) || typeof tool.description !== 'string'
      || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)
      || tool.inputSchema.type !== 'object') throw new Error(host + ' helper returned an invalid or duplicate catalog tool');
    names.add(tool.clientName);
  }
  return catalog;
}

/** Fetch first, then swap a complete prepared generation; offline helpers retain their tools. */
export function startCatalog(
  ctx: Context,
  host: Catalog['host'],
  policy: CatalogPolicy,
  fetchCatalog: (signal: AbortSignal) => Promise<unknown>,
  prepare: (tools: CatalogTool[]) => Tool<Schema, unknown>[],
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposers: Disposer[] = [];
  let revision: string | undefined;
  let current: Catalog | undefined;
  let retryMs = policy.catalogRetryInitialMs;
  let pending: Promise<void> | undefined;

  const schedule = (delay: number) => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, delay);
    timer.unref();
  };
  const refresh = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = (async () => {
      try {
        const catalog = parseCatalog(await fetchCatalog(controller.signal), host);
        if (controller.signal.aborted) return;
        if (catalog.revision !== revision) {
          const next = prepare(catalog.tools);
          const names = new Set(next.map(tool => tool.name));
          if (names.size !== next.length) throw new Error(host + ' catalog maps multiple tools to the same public name');
          for (const dispose of disposers) dispose();
          disposers = [];
          revision = undefined;
          try {
            for (const definition of next) disposers.push(ctx.tools.register(definition));
          } catch (error) {
            for (const dispose of disposers) dispose();
            disposers = [];
            throw error;
          }
          revision = catalog.revision;
          current = catalog;
        }
        retryMs = policy.catalogRetryInitialMs;
        schedule(policy.catalogRefreshMs);
      } catch (error) {
        if (controller.signal.aborted) return;
        ctx.logger?.warn(host + ' helper catalog refresh failed; retrying: ' + String(error));
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, policy.catalogRetryMaxMs);
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  ctx.effect(() => () => {
    controller.abort();
    if (timer) clearTimeout(timer);
    for (const dispose of disposers) dispose();
    disposers = [];
  });
  const ready = refresh();
  return { ready, refresh, current: () => current };
}
