export const name = "runtime-tooling-guidance";
export const inject = ["systemPrompt", "tools"];
export const SECTION = "dsh-config:runtime-tooling-guidance";

export const DEFAULT_TEXT = {
  native: "Native tool calling is active. Issue independent tool calls together in one turn. Keep dependent calls in order. If the next step is already determined, don't spend a model round trip on it.",
  typescript: "Only the tools actually exposed to you can be called directly. The SDK bindings (`tools.*`) work only inside `run_code`. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `Promise.all`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips.",
  python: "Only the tools actually exposed to you can be called directly. The SDK bindings work only inside the Python program. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `asyncio.gather`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips. Use only syntax and libraries you know are available.",
  grep: "`grep` patterns are ripgrep (Rust) regular expressions. Put a backslash before any of `()[]{}.?*+|^$\\` to match it literally; for example, `openSource\\(` finds `openSource(`. Lookaround and backreferences are not supported.",
  output: "Output only what the next decision needs. Keep errors, statuses, paths, and location evidence. Keep intermediate data inside the program rather than returning it in full. Don't repeat complete tool objects.",
  background: "Background jobs, agents you delegated to, and messages addressed to you all notify you; each notice starts your next turn. After starting such work, keep doing independent work. When only waiting remains, end your turn instead of polling, sleeping, or re-listing status. Check status yourself only for work nothing will report, such as a process you detached or an external CI run. Before the task ends, collect needed results and stop unrelated work.",
  child: "Send your report with `send_message` to your parent agent, the agent named in your delegation identity. If a message arrives while you are writing, it starts another turn, and a report left only in your final reply may never reach the parent. After sending, end with a one-line acknowledgement. Don't declare completion while your background work is still running.",
  sdkMessage: "`send_message` is an SDK binding here: call it inside the program like any other tool, not as a direct tool call.",
  delegation: `## Delegation ownership

Don't repeat work you've already delegated. Continue independent work while it runs. When a report arrives, review and integrate it yourself.

You design the study, freeze its rules, and write the final report yourself; subagent findings are inputs, not conclusions. When a delegated task stalls on performance or keeps running in the background far longer than expected, take over the diagnosis yourself instead of waiting or re-delegating. Route independent review of results to the high tier.`,
  models: "## DSH task model routing\n\nGPT models are available only through `klaude-openai`. Use `gpt-6.2-sol`, the best available GPT model, for these tiers:\n\n- Cheap (`low`): exploration, research, and simple implementation.\n- Mid (`medium`): complicated implementation and reasoning.\n- Expensive (`high`): broad, high-risk, or difficult cross-module work.\n\nSet `provider`, `model`, and `reasoning_effort` on `subagent`. Follow any model or reasoning effort the user explicitly requests.",
};

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep deployment-owned wording separate from the fixed capability conditions. */
export const Config = {
  "~standard": {
    version: 1,
    vendor: name,
    validate(input) {
      if (!object(input) || Object.keys(input).some(key => key !== "text")
        || (input.text !== undefined && (!object(input.text)
          || Object.entries(input.text).some(([key, value]) => !Object.hasOwn(DEFAULT_TEXT, key)
            || typeof value !== "string" || !value.trim())))) {
        return { issues: [{ message: "Expected optional text overrides for " + Object.keys(DEFAULT_TEXT).join(", ") }] };
      }
      return { value: { text: { ...DEFAULT_TEXT, ...input.text } } };
    },
  },
};

/** Require the public continuable identity, not a session label or fork-inherited descriptor. */
function canReport(ctx, agent) {
  if (!agent) return false;
  const identity = ctx.get("sessionProjections")?.snapshot(agent.session, ["subagent"]).values.subagent;
  return identity?.mode === "continuable" && agent.session.isOwnSeq(identity.seq)
    && ctx.get("agents")?.get(agent.session.header.parentSession) !== undefined;
}

/** Inspect each fresh assembly and leave all other sections and schemas untouched. */
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") + 2,
    interpolate: false,
    text: "## Runtime tooling",
  }));
  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    // @deepseek-ai/dsh-tool-executor-ptc owns the tools:ptc-only and tools:sdk section ids.
    const ptc = assembled.sections.some(section => section.name === "tools:ptc-only" && section.text.trim());
    const sdk = ptc && assembled.sections.some(section => section.name === "tools:sdk" && section.text.trim());
    const visible = new Map(ctx.tools.schemas(context.scope, context.toolSet).map(tool => [tool.name, tool]));
    const tool = name => !ptc || sdk ? visible.get(name) : undefined;
    const selected = [];
    if (sdk) {
      const language = ctx.get("ptcRuntime")?.language;
      if (language === "typescript" || language === "python") {
        selected.push(config.text[language], config.text.output);
      }
    } else if (!ptc && visible.size) {
      selected.push(config.text.native);
    }
    if (tool("grep")?.parameters?.properties?.pattern) selected.push(config.text.grep);
    const background = ["bash", "workflow"].some(name =>
      tool(name)?.parameters?.properties?.run_in_background?.type === "boolean");
    const messaging = tool("send_message")?.parameters?.properties;
    if ((background && tool("job_output")?.parameters?.properties?.job_id
      && tool("job_kill")?.parameters?.properties?.job_id)
      || tool("subagent") || messaging?.message) selected.push(config.text.background);
    if (messaging?.agent && messaging.message && canReport(ctx, context.agent)) {
      selected.push(config.text.child);
      if (sdk) selected.push(config.text.sdkMessage);
    }
    if (tool("subagent")) selected.push(config.text.delegation, config.text.models);
    const text = ["## Runtime tooling", ...selected].join("\n\n");
    return { ...assembled, sections: assembled.sections.flatMap(section => section.name !== SECTION
      ? [section] : selected.length ? [{ ...section, text }] : []) };
  });
}
