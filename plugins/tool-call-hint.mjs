import { randomUUID } from 'node:crypto';

export const name = 'tool-call-hint';
export const inject = ['agents', 'sessions'];

const MAX_RETRIES = 3;
const UNAVAILABLE_TOOL = /^tool_protocol_error: Model called an unavailable tool: ([A-Za-z0-9_-]+)/;
const NATIVE_TOOL_BLOCKED = /^native_tool_blocked\b/;

export function apply(ctx) {
  const retriesBySession = new Map();
  ctx.effect(() => () => retriesBySession.clear());
  ctx.on('session/disposed', ({ id }) => {
    retriesBySession.delete(id);
  });

  ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    if (signal.aborted) return next();
    const tool = UNAVAILABLE_TOOL.exec(failure.message)?.[1];
    if (!tool && !NATIVE_TOOL_BLOCKED.test(failure.message)) return next();

    const { session } = agent;
    const previous = retriesBySession.get(session.id);
    const retries = previous?.turn === turn && previous.step === step ? previous.retries : 0;
    if (retries >= MAX_RETRIES) return next();

    const explanation = tool
      ? `you called "${tool}" as a top-level tool. It is not in your tool schema; if it is a run_code binding, call it inside run_code as tools.${tool}(...).`
      : 'a tool call used a name outside your tool schema. Top-level tool names must be the exact prefixed names in your schema, such as mcp__parking__run_code; every other tool is called inside run_code as tools.<name>(...).';
    const text = `In turn ${turn}, step ${step}, your response was rejected because ${explanation} The whole response was discarded and no tool call in it ran.`;
    session.append('user/message', {
      id: randomUUID(), role: 'user', source: { kind: name },
      content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' });
    retriesBySession.set(session.id, { turn, step, retries: retries + 1 });
    return { kind: 'retry' };
  });
}
