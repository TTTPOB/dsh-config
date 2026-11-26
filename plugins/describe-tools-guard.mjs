import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const name = "describe-tools-guard";
export const inject = ["tools"];

const describe = "describe_tools";

function* jsonOutputs(text) {
  // run_code joins its logs and return value into one text block. A complete
  // JSON print/return can be compact or span lines with an unindented close.
  for (const [output] of text.matchAll(/^(?:\{.*\}|\[.*\]|\{\n[\s\S]*?^\}|\[\n[\s\S]*?^\])[ \t]*$/gm)) {
    try {
      yield JSON.parse(output);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
}

function allVisible(session, wanted) {
  const calls = new Map();
  for (const message of session.deriveMessages()) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool-call") calls.set(block.id, block.name);
      }
      continue;
    }
    if (message.role !== "tool" || message.isError) continue;
    const transport = calls.get(message.toolCallId);
    if (transport !== describe && transport !== "run_code") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      for (const output of jsonOutputs(block.text)) {
        const entries = output?.tools ?? (Array.isArray(output) ? output : [output]);
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const current = wanted.get(entry?.name);
          if (current && isDeepStrictEqual(entry, current)) wanted.delete(current.name);
        }
      }
      if (wanted.size === 0) return true;
    }
  }
  return false;
}

export function apply(ctx) {
  const nativeFeedback = new WeakMap();
  // pre-execute cannot return success. Around dispatch skips the registered
  // body after the ordinary permission/approval gates have accepted the call.
  ctx.on("tools/execute", async (exec, next) => {
    const names = exec.arguments?.names;
    if (exec.name !== describe || !exec.agent || !Array.isArray(names) || names.length === 0) return next();
    const wanted = new Map();
    for (const toolName of names) {
      const tool = ctx.tools.executable(toolName, exec.agent, exec.toolSet);
      if (!tool) return next();
      wanted.set(toolName, structuredClone({ name: tool.name, description: tool.description,
        parameters: tool.parameters, output: tool.output.schema }));
    }
    if (!allVisible(exec.agent.session, wanted)) return next();

    const text = `Already described in context: ${[...new Set(names)].join(", ")}. Use those schemas; call describe_tools again only if they were compacted away.`;
    const content = [{ type: "text", text }];
    // The registry re-renders authored successes. Keep the SDK value within
    // describe_tools' output schema; the parent forwards the nested notice.
    if (exec.parent !== undefined) {
      return { isError: false, value: { tools: [] }, content,
        additionalContexts: [{ id: randomUUID(), role: "user", content, source: { kind: name } }] };
    }
    nativeFeedback.set(exec, content);
    return { isError: false, value: { tools: [] }, content };
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const content = nativeFeedback.get(exec);
    if (!content || result.isError || decision.kind !== "accept" || Object.hasOwn(decision, "value")) return decision;
    return { ...decision, content };
  });
}
