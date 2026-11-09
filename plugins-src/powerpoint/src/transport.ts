import type { Config } from './config.ts';

interface HelperError {
  code: string;
  message?: string;
  panes?: unknown;
}
export function helperSignal(config: Config, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  return combined;
}

/** One request to the Windows helper; failures keep the helper's code and hint. */
export function helperRequest(config: Config, route: string, body: unknown, signal: AbortSignal | undefined, binary: true): Promise<Buffer>;
export function helperRequest<T = unknown>(config: Config, route: string, body: unknown, signal?: AbortSignal, binary?: false): Promise<T>;
export async function helperRequest(config: Config, route: string, body: unknown, signal?: AbortSignal, binary = false) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.helperToken) headers.authorization = 'Bearer ' + config.helperToken;
  const response = await fetch(new URL(route, config.helperUrl), {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: helperSignal(config, signal),
  }).catch(error => { throw new Error('PowerPoint helper not connected: ' + String(error), { cause: error }); });
  if (!response.ok) {
    let detail: HelperError | null = null;
    try { detail = (await response.json()).error; } catch { detail = null; }
    throw paneError(detail ?? { code: 'HTTP ' + response.status, message: 'request failed' });
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

/** Keep presentation-selection errors actionable without discarding the helper's pane list. */
export function paneError(detail: HelperError) {
  const selection = ['target-not-found', 'multiple-panes', 'taskpane-not-open'].includes(detail.code);
  return new Error('dsh-powerpoint helper ' + detail.code + ': ' + detail.message
    + (detail.panes ? ' Panes: ' + JSON.stringify(detail.panes) : '')
    + (selection ? ' Call powerpoint_list_presentations, then powerpoint_select_presentation with a pane sessionId.' : ''));
}

/** Evaluate once; never retry writes whose completion is unknown. */
export async function evaluate(config: Config, expression: string, signal?: AbortSignal, target?: string): Promise<unknown> {
  return (await helperRequest<{ value?: unknown }>(config, '/eval', { code: expression, ...(target === undefined ? {} : { target }) }, signal)).value ?? null;
}
