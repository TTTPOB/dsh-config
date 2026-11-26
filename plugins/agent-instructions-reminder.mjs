import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'agent-instructions-reminder';
export const inject = ['workingDirectory', 'fs'];

const isInstructions = ({ source }) => source.kind === 'agent-instructions';
const isBaseline = message => isInstructions(message) && message.source.baseline === true;

function globalInstructionPaths() {
  const paths = new Map();
  for (const [directory, variable] of [['.dsh', 'DSH_HOME'], ['.agents', 'DSH_AGENTS_HOME']]) {
    const fallback = join(homedir(), directory);
    const home = process.env[variable]?.trim() ? process.env[variable] : fallback;
    const expanded = /^~(?:[/\\]|$)/.test(home) ? join(homedir(), home.slice(home === '~' ? 1 : 2)) : home;
    paths.set(`~/${directory}/AGENTS.md`, join(fallback, 'AGENTS.md'));
    paths.set(`$${variable}/AGENTS.md`, resolve(expanded, 'AGENTS.md'));
  }
  return paths;
}

async function projectRoot(ctx, session, messages, signal) {
  const cwd = ctx.workingDirectory.get(session);
  const baseline = messages.findLast(isBaseline) ?? session.deriveMessages().findLast(isBaseline);
  if (baseline?.source.baselineIdentity !== undefined) {
    return resolve(cwd, JSON.parse(baseline.source.baselineIdentity).projectRoot);
  }

  // A nested file can be the first injection in an otherwise empty baseline.
  // The managed presets use the upstream default root marker in this case.
  for (let directory = cwd; ; directory = dirname(directory)) {
    try {
      const target = await ctx.fs.resolve(join(directory, '.git'), { signal });
      if (await ctx.fs.stat(target, signal) !== undefined) return directory;
    } catch (error) {
      signal.throwIfAborted();
      if (error.code !== 'FS_NOT_FOUND') throw error;
    }
    if (dirname(directory) === directory) return cwd;
  }
}

export function apply(ctx) {
  const globalPaths = globalInstructionPaths();
  // The producer adds its message when next() returns, so this hook must wrap it.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || decision.messages.some(({ source }) => source.kind === name)) return decision;
    const paths = new Set();
    let last = -1;
    for (const [index, message] of decision.messages.entries()) {
      if (!isInstructions(message)) continue;
      last = index;
      for (const { action, path } of message.source.changes) {
        if (action === 'remove') paths.delete(path);
        else paths.add(path);
      }
    }
    if (paths.size === 0) return decision;

    const root = [...paths].some(path => !globalPaths.has(path))
      ? await projectRoot(ctx, agent.session, decision.messages, signal)
      : undefined;
    const files = [...paths].map(path => {
      const absolute = globalPaths.get(path) ?? resolve(root, path);
      return path === absolute ? `- ${JSON.stringify(path)}` : `- ${JSON.stringify(path)} (${JSON.stringify(absolute)})`;
    });
    const note = {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: ['<system-reminder>', 'These instruction files are already loaded above:', ...files,
          'Do not read them with tools by relative or absolute path. Re-read only if the user asks or you need to verify an edit you made.',
          '</system-reminder>'].join('\n'),
      }],
      source: { kind: name },
    };
    return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, note) };
  }, { prepend: true });
}
