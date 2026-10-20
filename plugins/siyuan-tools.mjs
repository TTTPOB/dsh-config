import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

export const name = 'siyuan-tools';
export const inject = ['tools'];
const browserUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Dependency-free Standard Schema; credentials are read only during tool execution. */
export const Config = {
  '~standard': {
    version: 1, vendor: name,
    validate(input) {
      const value = { timeoutMs: 60000, userAgent: browserUserAgent, ...input };
      const issues = [];
      const issue = (message, ...path) => issues.push({ message, path });
      for (const endpoint of ['self', 'peer']) {
        const target = value[endpoint];
        try {
          const url = new URL(target?.baseURL);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { issue('baseURL must be an HTTP(S) URL without credentials, query or fragment', endpoint, 'baseURL'); }
        if (typeof target?.headersFile !== 'string' || !isAbsolute(target.headersFile)) issue('headersFile must be an absolute path', endpoint, 'headersFile');
      }
      if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) issue('timeoutMs must be a positive integer', 'timeoutMs');
      if (typeof value.userAgent !== 'string' || !value.userAgent.trim() || /[\r\n]/.test(value.userAgent)) issue('userAgent must be a non-empty single line', 'userAgent');
      return issues.length ? { issues } : { value };
    },
  },
};

async function post(config, endpoint, api, body, signal) {
  const target = config[endpoint];
  let raw;
  try { raw = JSON.parse(await readFile(target.headersFile, 'utf8')); }
  catch { throw new Error('SiYuan ' + endpoint + ': cannot read headersFile JSON'); }
  if (!object(raw) || !Object.values(raw).every(value => typeof value === 'string')) throw new Error('SiYuan ' + endpoint + ': headersFile must contain a flat string-valued headers object');
  let headers;
  try {
    headers = new Headers(raw);
    // Headers normalizes casing; the configured/default browser UA always wins.
    headers.set('User-Agent', config.userAgent);
    headers.delete('Content-Type');
    if (!(body instanceof FormData)) headers.set('Content-Type', 'application/json');
  } catch { throw new Error('SiYuan ' + endpoint + ': invalid request headers'); }
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const response = await fetch(target.baseURL.replace(/\/+$/, '') + api, {
    method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('SiYuan ' + endpoint + ' ' + api + ': HTTP ' + response.status);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('SiYuan ' + endpoint + ' ' + api + ': invalid JSON response'); }
  if (!object(result) || result.code !== 0) throw new Error('SiYuan ' + endpoint + ' ' + api + ': API code ' + (result?.code ?? 'missing') + (typeof result?.msg === 'string' ? ' (' + result.msg + ')' : ''));
  return result;
}

const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
const syncSchema = { type: 'object', properties: {
  endpoint: { type: 'string', enum: ['self', 'peer'] }, accepted: { type: 'boolean' },
  message: { type: 'string' },
}, required: ['endpoint', 'accepted', 'message'], additionalProperties: false };

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: 'siyuan_upload_asset', deferLoading: true, timeoutMs: config.timeoutMs,
    description: 'Upload local files from the DSH execution machine to the default SiYuan instance. Sends actual bytes, not local paths. Does not trigger sync; do not automatically retry failed writes.',
    parameters: { type: 'object', properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths on the DSH execution machine; filenames must be distinct.' },
    }, required: ['files'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {
      assets: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, assetPath: { type: 'string' } }, required: ['file', 'assetPath'], additionalProperties: false } },
    }, required: ['assets'], additionalProperties: false }, render },
    async execute({ files }, exec) {
      if (!Array.isArray(files) || !files.length || !files.every(file => typeof file === 'string' && isAbsolute(file))) throw new Error('files must be a non-empty list of absolute local file paths');
      const names = files.map(file => basename(file));
      if (new Set(names).size !== names.length) throw new Error('Upload filenames must be distinct');
      const form = new FormData();
      form.set('assetsDirPath', '/assets/');
      for (const file of files) {
        exec.signal?.throwIfAborted();
        const bytes = await readFile(file, { signal: exec.signal });
        form.append('file[]', new Blob([bytes]), basename(file));
      }
      const { data } = await post(config, 'self', '/api/asset/upload', form, exec.signal);
      if (data?.errFiles?.length) throw new Error('SiYuan upload reported failed files; some assets may already exist. Inspect before any manual retry.');
      if (!object(data?.succMap) || !names.every(file => typeof data.succMap[file] === 'string' && data.succMap[file].startsWith('assets/'))) throw new Error('SiYuan upload returned an incomplete asset mapping; assets may already exist.');
      return { assets: files.map((file, index) => ({ file, assetPath: data.succMap[names[index]] })) };
    },
  }));
  for (const endpoint of ['self', 'peer']) ctx.effect(() => ctx.tools.register({
    name: 'siyuan_sync_' + endpoint, deferLoading: true, timeoutMs: config.timeoutMs,
    description: 'Request sync on the ' + (endpoint === 'self' ? 'default' : 'peer') + ' SiYuan instance. API acceptance is not proof of completed sync. Does not sync the other instance or retry writes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: syncSchema, render },
    async execute(_args, exec) {
      await post(config, endpoint, '/api/sync/performSync', {}, exec.signal);
      return { endpoint, accepted: true, message: 'Sync request accepted by the API; completion has not been verified.' };
    },
  }));
}
