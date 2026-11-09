import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function catalog(host, names = host === 'PowerPoint'
  ? ['list_slide_shapes', 'verify_slides']
  : ['verify_doc', 'edit_doc_list', 'edit_doc_text'], skill) {
  const tools = names.map(clientName => ({
    clientName, description: 'Synthetic helper operation',
    inputSchema: { type: 'object', properties: { probe: { type: 'string' } } },
  }));
  return {
    host, tools, ...(skill ? {skill} : {}),
    revision: createHash('sha256').update(JSON.stringify(canonical({tools,...(skill ? {skill} : {})}))).digest('hex'),
    source: { bundleSha256: '0'.repeat(64) },
  };
}
export function definitions(host) {
  const prefix = host.toLowerCase() + '_';
  return [...catalog(host).tools, { clientName: 'execute_office_js' }]
    .map(tool => ({ ...tool, name: prefix + tool.clientName }));
}
export const settled = () => new Promise(resolve => setImmediate(resolve));
