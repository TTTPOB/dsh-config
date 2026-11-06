import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { root } from '../scripts/lib.mjs';
import * as Plugin from '../plugins/siyuan-tools.mjs';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-siyuan-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function validate(input) {
  const result = Plugin.Config['~standard'].validate(input);
  assert.equal(result.issues, undefined);
  return result.value;
}
function register(t, config, services = {}) {
  const tools = new Map(), disposers = [];
  Plugin.apply({ get: name => services[name], effect: fn => disposers.push(fn()), tools: { register(tool) {
    tools.set(tool.name, tool);
    return () => tools.delete(tool.name);
  } } }, config);
  const dispose = () => disposers.splice(0).reverse().forEach(fn => fn());
  t.after(dispose);
  return { tools, dispose, call: (name, args = {}, signal = new AbortController().signal, exec = {}) => tools.get(name).execute(args, { signal, ...exec }) };
}
async function fixture(t, extra = {}, services = {}) {
  const dir = directory(t), requests = [];
  let respond = () => ({ code: 0, data: null });
  const server = createServer(async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    requests.push({ path: req.url, method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(bytes) });
    const reply = respond(requests.at(-1));
    if (reply.delay) return;
    res.writeHead(reply.status ?? 200, { 'Content-Type': reply.contentType ?? 'application/json' });
    res.end(reply.bytes ?? reply.raw ?? JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseURL = 'http://127.0.0.1:' + server.address().port;
  const headersFile = join(dir, 'headers.json'), peerHeaders = join(dir, 'peer.json');
  writeFileSync(headersFile, JSON.stringify({ Authorization: 'Token test-self', 'User-Agent': 'old-agent', 'Content-Type': 'application/json' }));
  writeFileSync(peerHeaders, JSON.stringify({ Authorization: 'Token test-peer' }));
  const config = validate({ self: { baseURL: baseURL + '/self', headersFile }, peer: { baseURL: baseURL + '/peer', headersFile: peerHeaders }, ...extra });
  return { dir, requests, config, headersFile, setReply: fn => { respond = fn; }, ...register(t, config, services) };
}

test('multipart upload sends actual local bytes and returns local-to-asset mappings without sync', async t => {
  const f = await fixture(t);
  const files = [join(f.dir, 'a.bin'), join(f.dir, 'b.txt')];
  const binary = Buffer.from([0, 255, 128, 10, 42]);
  writeFileSync(files[0], binary);
  writeFileSync(files[1], 'neutral text');
  f.setReply(() => ({ code: 0, data: { errFiles: [], succMap: { 'a.bin': 'assets/a-id.bin', 'b.txt': 'assets/b-id.txt' } } }));
  assert.deepEqual(await f.call('siyuan_upload_asset', { files }), { assets: [
    { file: files[0], assetPath: 'assets/a-id.bin' }, { file: files[1], assetPath: 'assets/b-id.txt' },
  ] });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.path, '/self/api/asset/upload');
  assert.equal(request.method, 'POST');
  const form = await new Response(request.body, { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
  assert.equal(form.get('assetsDirPath'), '/assets/');
  const uploaded = form.getAll('file[]');
  assert.deepEqual(uploaded.map(file => file.name), ['a.bin', 'b.txt']);
  assert.deepEqual(Buffer.from(await uploaded[0].arrayBuffer()), binary);
  assert.equal(await uploaded[1].text(), 'neutral text');
  assert.equal(request.headers.authorization, 'Token test-self');
  assert.match(request.headers['user-agent'], /^Mozilla[/]5[.]0/);
  assert.ok(!request.body.includes(Buffer.from(f.dir)));
});

test('sync routes independently, rereads flat credentials and overrides UA case-insensitively', async t => {
  const f = await fixture(t, { userAgent: 'Browser-Test/1.0' });
  writeFileSync(f.headersFile, JSON.stringify({ authorization: 'Token refreshed', 'user-agent': 'stale', 'User-Agent': 'also stale' }));
  for (const endpoint of ['self', 'peer']) {
    const result = await f.call('siyuan_sync_' + endpoint);
    assert.equal(result.endpoint, endpoint);
    assert.equal(result.accepted, true);
    assert.match(result.message, /completion has not been verified/);
  }
  assert.deepEqual(f.requests.map(req => req.path), ['/self/api/sync/performSync', '/peer/api/sync/performSync']);
  assert.deepEqual(f.requests.map(req => req.headers.authorization), ['Token refreshed', 'Token test-peer']);
  for (const req of f.requests) {
    assert.equal(req.method, 'POST');
    assert.equal(req.body.toString(), '{}');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['user-agent'], 'Browser-Test/1.0');
    assert.equal(req.rawHeaders.filter(value => value.toLowerCase() === 'user-agent').length, 1);
  }
  assert.equal(f.tools.size, 4);
  assert.ok([...f.tools.values()].every(tool => tool.deferLoading === true && tool.timeoutMs === f.config.timeoutMs));
  f.dispose();
  assert.equal(f.tools.size, 0);
});

test('HTTP, API and malformed response failures are explicit and never retried', async t => {
  const f = await fixture(t);
  for (const [reply, expected] of [[{ status: 503 }, /HTTP 503/], [{ code: -1, msg: 'sync disabled' }, /API code -1.*sync disabled/], [{ raw: 'not JSON' }, /invalid JSON/], [{ data: null }, /API code missing/]]) {
    f.setReply(() => reply);
    const count = f.requests.length;
    await assert.rejects(f.call('siyuan_sync_self'), expected);
    assert.equal(f.requests.length, count + 1);
  }
});

test('credential errors, invalid local paths and partial upload failures fail without implicit writes', async t => {
  const f = await fixture(t);
  for (const text of ['invalid JSON', JSON.stringify({ headers: { Authorization: 'not flat' } })]) {
    writeFileSync(f.headersFile, text);
    await assert.rejects(f.call('siyuan_sync_self'), /headersFile/);
  }
  rmSync(f.headersFile);
  await assert.rejects(f.call('siyuan_sync_self'), /headersFile/);
  for (const files of [[], ['relative.txt'], [join(f.dir, 'missing.txt')], [join(f.dir, 'a.txt'), join(f.dir, 'nested/a.txt')]]) {
    await assert.rejects(f.call('siyuan_upload_asset', { files }));
  }
  assert.equal(f.requests.length, 0);
  writeFileSync(f.headersFile, '{}');
  const file = join(f.dir, 'a.txt');
  writeFileSync(file, 'test');
  for (const data of [{ errFiles: ['a.txt'], succMap: {} }, { succMap: {} }]) {
    f.setReply(() => ({ code: 0, data }));
    await assert.rejects(f.call('siyuan_upload_asset', { files: [file] }), /may already exist/);
  }
  assert.equal(f.requests.length, 2);
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const imageAgent = { agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } } };
function imageServices({ modalities = ['text', 'image'], maxBytes = 1000 } = {}) {
  const saved = [];
  return { saved, services: {
    llm: { resolveModelInfo: async () => ({ inputModalities: modalities }) },
    attachments: { imageLimits: { maxImageBytes: maxBytes, maxMessageImageBytes: maxBytes }, async saveImage(input) {
      saved.push(input);
      return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 4, height: 3, name: input.name };
    } },
  } };
}

test('fetch returns an image inline from self through the attachment store', async t => {
  const store = imageServices();
  const f = await fixture(t, {}, store.services);
  f.setReply(() => ({ contentType: 'image/png', bytes: png }));
  const value = await f.call('siyuan_fetch_asset', { asset: '/assets/a-1.png' }, undefined, imageAgent);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/self/api/file/getFile');
  assert.equal(f.requests[0].headers.authorization, 'Token test-self');
  assert.deepEqual(JSON.parse(f.requests[0].body), { path: '/data/assets/a-1.png' });
  assert.deepEqual(Buffer.from(store.saved[0].data), png);
  assert.equal(store.saved[0].mediaType, 'image/png');
  assert.deepEqual(value, { asset: 'assets/a-1.png', image: { attachmentId: 'att-1', mediaType: 'image/png', bytes: png.length, width: 4, height: 3, name: 'a-1.png' } });
  const blocks = f.tools.get('siyuan_fetch_asset').output.render({}, value);
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image']);
  assert.equal(blocks[1].attachment.attachmentId, 'att-1');
});

test('fetch with saveTo writes original bytes to temp or an exact new path', async t => {
  const f = await fixture(t);
  const pdf = Buffer.from('%PDF-1.7 bytes');
  f.setReply(() => ({ contentType: 'application/pdf', bytes: pdf }));
  const temp = await f.call('siyuan_fetch_asset', { asset: 'assets/doc-1.pdf', saveTo: 'temp' });
  t.after(() => rmSync(join(temp.path, '..'), { recursive: true, force: true }));
  assert.equal(basename(temp.path), 'doc-1.pdf');
  assert.deepEqual(readFileSync(temp.path), pdf);
  assert.deepEqual({ ...temp, path: undefined }, { asset: 'assets/doc-1.pdf', path: undefined, bytes: pdf.length, mediaType: 'application/pdf' });
  const target = join(f.dir, 'copy.pdf');
  assert.equal((await f.call('siyuan_fetch_asset', { asset: 'assets/doc-1.pdf', saveTo: target })).path, target);
  assert.deepEqual(readFileSync(target), pdf);
  await assert.rejects(f.call('siyuan_fetch_asset', { asset: 'assets/doc-1.pdf', saveTo: target }), { code: 'EEXIST' });
  await assert.rejects(f.call('siyuan_fetch_asset', { asset: 'assets/doc-1.pdf', saveTo: 'relative.pdf' }), /saveTo/);
  assert.ok(f.requests.every(req => req.path === '/self/api/file/getFile'));
});

test('fetch refusals happen before network where possible and report API envelopes', async t => {
  const store = imageServices({ maxBytes: 4 });
  const f = await fixture(t, {}, store.services);
  for (const asset of ['../conf/conf.json', 'assets/../conf.json', 'data/assets/a.png', 'assets\\a.png', 'assets//a.png']) {
    await assert.rejects(f.call('siyuan_fetch_asset', { asset }, undefined, imageAgent), /asset must be/);
  }
  await assert.rejects(f.call('siyuan_fetch_asset', { asset: 'assets/doc.pdf' }, undefined, imageAgent), /pass saveTo/);
  const blind = await fixture(t, {}, imageServices({ modalities: ['text'] }).services);
  await assert.rejects(blind.call('siyuan_fetch_asset', { asset: 'assets/a.png' }, undefined, imageAgent), /does not accept image input/);
  assert.equal(f.requests.length + blind.requests.length, 0);
  f.setReply(() => ({ contentType: 'image/png', bytes: png }));
  await assert.rejects(f.call('siyuan_fetch_asset', { asset: 'assets/a.png' }, undefined, imageAgent), /inline limit/);
  f.setReply(() => ({ code: 404, msg: 'not found' }));
  await assert.rejects(f.call('siyuan_fetch_asset', { asset: 'assets/a.png', saveTo: 'temp' }), /API code 404.*not found/);
  assert.equal(store.saved.length, 0);
});

test('configured deadline and caller cancellation abort requests without retry', async t => {
  const f = await fixture(t, { timeoutMs: 40 });
  f.setReply(() => ({ delay: true }));
  await assert.rejects(f.call('siyuan_sync_self'), { name: 'TimeoutError' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.call('siyuan_sync_peer', {}, controller.signal), { name: 'AbortError' });
  assert.equal(f.requests.length, 1);
});

test('Config validates both endpoints, headers paths, timeout and UA without reading credentials', () => {
  const endpoint = { baseURL: 'https://notes.example.invalid', headersFile: '/path/to/headers.json' };
  const config = { self: endpoint, peer: endpoint };
  validate(config);
  for (const changed of [{ self: { ...endpoint, baseURL: 'file:///invalid' } }, { peer: { ...endpoint, headersFile: 'relative.json' } }, { timeoutMs: 0 }, { userAgent: '\n' }, { peer: undefined }]) {
    assert.ok(Plugin.Config['~standard'].validate({ ...config, ...changed }).issues);
  }
});

test('installed Loader loads a copied module in isolated home, scopes tools and revokes registrations', {
  skip: !process.env.DSH_CLI_PACKAGE,
}, async t => {
  const dir = directory(t);
  const runtime = createRequire(realpathSync(process.env.DSH_CLI_PACKAGE));
  const load = async name => import(pathToFileURL(runtime.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
  const { default: Include } = await load('@deepseek-ai/cordis-plugin-include');
  const { default: Tools } = await load('@deepseek-ai/dsh-tools');
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const { createScope } = await load('@deepseek-ai/dsh-scope');
  const pluginFile = join(dir, 'siyuan-tools.mjs');
  copyFileSync(join(root, 'plugins/siyuan-tools.mjs'), pluginFile);
  const yamlFile = join(dir, 'cordis.yml');
  const target = { baseURL: 'https://notes.example.invalid', headersFile: join(dir, 'unread-missing-headers.json') };
  writeFileSync(yamlFile, JSON.stringify([{ id: 'siyuan-tools', name: pluginFile, config: { self: target, peer: target } }]));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  const key = { agent: 'with-siyuan' };
  const scope = createScope(ctx, key);
  const include = await scope.ctx.plugin(Include, { path: pathToFileURL(yamlFile).href });
  const names = ['siyuan_fetch_asset', 'siyuan_upload_asset', 'siyuan_sync_self', 'siyuan_sync_peer'];
  assert.deepEqual(ctx.tools.schemas(key).map(tool => tool.name).sort(), names.sort());
  assert.ok(ctx.tools.schemas(key).every(tool => tool.deferLoading));
  assert.deepEqual(ctx.tools.schemas(), []);
  assert.deepEqual(ctx.tools.schemas({ agent: 'other' }), []);
  await assert.rejects(ctx.tools.get('siyuan_sync_self', key).execute({}, { signal: new AbortController().signal }), /headersFile/);
  await include.dispose();
  assert.deepEqual(ctx.tools.schemas(key), []);
});
