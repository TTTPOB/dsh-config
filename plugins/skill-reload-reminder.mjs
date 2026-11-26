import { randomUUID } from "node:crypto";

export const name = "skill-reload-reminder";
export const inject = ["tools"];

function isAlreadyVisible(session, result) {
  const skill = result.value;
  // Native renders a skill envelope; PTC can return the full value or emit its body.
  const output = new Set([
    ...result.content.filter(block => block.type === "text").map(block => block.text),
    skill.content,
    JSON.stringify(skill),
    JSON.stringify(skill, null, 2),
  ]);
  return session.deriveMessages().some(message =>
    (message.role === "tool" && !message.isError ||
      message.role === "user" && message.source.kind === "skill-invocation") &&
    message.content.some(block => block.type === "text" && output.has(block.text)));
}

export function apply(ctx) {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== "skill" || !exec.agent || result.isError || decision.kind !== "accept") return decision;
    const skill = result.value;
    if (skill?.name !== exec.arguments?.name || typeof skill?.content !== "string" || !skill.content ||
      !isAlreadyVisible(exec.agent.session, result)) return decision;

    const message = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text: `The full instructions for ${skill.name} were already in context. Reuse them; reload only if they are missing, changed, or the user asks.` }],
      source: { kind: name },
    };
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] };
  });
}
