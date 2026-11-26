import { randomUUID } from 'node:crypto';

export const name = 'agent-instructions-reminder';

const isInstructions = ({ source }) => source.kind === 'agent-instructions';

export function apply(ctx) {
  // The producer adds its message when next() returns, so this hook must wrap it.
  ctx.on('agent/pre-step', async (_event, next) => {
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

    const note = {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: ['<system-reminder>', 'These instruction files are already loaded above:',
          ...[...paths].map(path => `- ${JSON.stringify(path)}`),
          'Do not read them with tools by relative or absolute path. Re-read only if the user asks or you need to verify an edit you made.',
          '</system-reminder>'].join('\n'),
      }],
      source: { kind: name },
    };
    return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, note) };
  }, { prepend: true });
}
