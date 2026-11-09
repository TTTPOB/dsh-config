import type { Config } from './config.ts';

interface HelperError {
  code: string | number;
  message?: string;
  pageCount?: number;
  panes?: unknown;
}
export interface PaneList {
  panes: { sessionId: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** Send one helper request without retrying possibly applied document writes. */
export async function requestHelper<T = unknown>(
  config: Config,
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.helperToken) headers.authorization = 'Bearer ' + config.helperToken;
  const response = await fetch(new URL(path, config.helperUrl), {
    method: payload === undefined ? 'GET' : 'POST',
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: combined,
  }).catch(error => { throw new Error('Word helper not connected: ' + String(error), { cause: error }); });
  const body = (await response.json()) as T & { error?: HelperError };
  if (!response.ok) throw paneError(body.error ?? { code: response.status, message: 'request failed' });
  return body;
}

/** Keep document-selection failures actionable without discarding the helper's pane list. */
export function paneError(detail: HelperError) {
  const selection = (
    ['target-not-found', 'multiple-panes', 'taskpane-not-open'] as (string | number)[]
  ).includes(detail.code);
  return new Error(
    'Word helper ' +
      detail.code +
      ': ' +
      (detail.message ?? 'request failed') +
      (detail.pageCount === undefined ? '' : ' Page count: ' + detail.pageCount + '.') +
      (detail.panes ? ' Panes: ' + JSON.stringify(detail.panes) : '') +
      (selection ? ' Call word_list_documents, then word_select_document with a pane sessionId.' : ''),
  );
}

/** Evaluate one expression in the document-bound Word taskpane. */
export async function evaluate(config: Config, code: string, signal?: AbortSignal, target?: string) {
  return (
    (
      await requestHelper<{ value?: unknown }>(
        config,
        '/eval',
        { code, ...(target === undefined ? {} : { target }) },
        signal,
      )
    ).value ?? null
  );
}

/** Quote model arguments as data rather than evaluating their contents as source code. */
export function clientCallExpression(clientName: string, args: unknown = {}, options: unknown = {}) {
  return (
    '(async()=>{if(!globalThis.WordClientRuntime) throw new Error("Word client runtime is not loaded. Open the Word Helper add-in.");' +
    'return await globalThis.WordClientRuntime.call(' +
    JSON.stringify(clientName) +
    ',' +
    JSON.stringify(args) +
    ',' +
    JSON.stringify(options) +
    ');})()'
  );
}
