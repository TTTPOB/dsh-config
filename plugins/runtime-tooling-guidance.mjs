export const name = "runtime-tooling-guidance";
export const inject = ["systemPrompt", "tools"];
export const SECTION = "dsh-config:runtime-tooling-guidance";

export const DEFAULT_TEXT = {
  native: "Native tool calling is active. Issue independent tool calls together in one turn. Keep dependent calls in order. If the next step is already determined, don't spend a model round trip on it.",
  typescript: "Only the tools actually exposed to you can be called directly. The SDK bindings (`tools.*`) work only inside `run_code`. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `Promise.all`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips.",
  python: "Only the tools actually exposed to you can be called directly. The SDK bindings work only inside the Python program. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `asyncio.gather`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips. Use only syntax and libraries you know are available.",
  output: "Output only what the next decision needs. Keep errors, statuses, paths, and location evidence. Keep intermediate data inside the program rather than returning it in full. Don't repeat complete tool objects.",
  background: "Background jobs, agents you delegated to, and messages addressed to you all notify you; each notice starts your next turn. After starting such work, keep doing independent work. When only waiting remains, end your turn instead of polling, sleeping, or re-listing status. Check status yourself only for work nothing will report, such as a process you detached or an external CI run. Before the task ends, collect needed results and stop unrelated work.",
  child: "Send your report to your parent as a message with the `send_message` tool, even though your parent is notified when your turn ends: a message arriving while you write could keep that final output from being delivered. Then end with a very short acknowledgement to prevent duplication. Don't declare completion while background work is still running.",
  teammate: "Send your report to the Lead as a message with the `send_message` tool (target `lead`), even though the Lead is notified when your turn ends: a message arriving while you write could keep that final output from being delivered. Then end with a very short acknowledgement to prevent duplication. Don't declare completion while background work is still running.",
  sdkMessage: "`send_message` is an SDK binding here: call it inside the program like any other tool, not as a direct tool call.",
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
    const background = ["bash", "workflow"].some(name =>
      tool(name)?.parameters?.properties?.run_in_background?.type === "boolean");
    const messaging = tool("send_message")?.parameters?.properties;
    if ((background && tool("job_output")?.parameters?.properties?.job_id
      && tool("job_kill")?.parameters?.properties?.job_id)
      || tool("subagent") || tool("spawn_teammate") || messaging?.message) selected.push(config.text.background);
    if (messaging?.message && canReport(ctx, context.agent)) {
      const report = messaging.agent_id ? "child" : messaging.target ? "teammate" : undefined;
      if (report) {
        selected.push(config.text[report]);
        if (sdk) selected.push(config.text.sdkMessage);
      }
    }
    const text = ["## Runtime tooling", ...selected].join("\n\n");
    return { ...assembled, sections: assembled.sections.flatMap(section => section.name !== SECTION
      ? [section] : selected.length ? [{ ...section, text }] : []) };
  });
}
