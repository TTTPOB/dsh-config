export const name = "runtime-tooling-guidance";
export const inject = ["systemPrompt", "tools"];
export const SECTION = "dsh-config:runtime-tooling-guidance";

export const DEFAULT_TEXT = {
  native: "Native tool calling is active. Issue independent tool calls together in one turn. Keep dependent calls in order. If the next step is already determined, don't spend a model round trip on it.",
  typescript: "Only the tools actually exposed to you can be called directly. The SDK bindings (`tools.*`) work only inside `run_code`. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `Promise.all`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips.",
  python: "Only the tools actually exposed to you can be called directly. The SDK bindings work only inside the Python program. Put already-determined sequential operations in one program with `await`. Run independent read-only calls with `asyncio.gather`. Run modifications in order. Serialized execution doesn't mean you need separate model round trips. Use only syntax and libraries you know are available.",
  output: "Output only what the next decision needs. Keep errors, statuses, paths, and location evidence. Keep intermediate data inside the program rather than returning it in full. Don't repeat complete tool objects.",
  background: "Use background execution only when independent work can proceed meanwhile, or when asynchrony is intended. After starting a task, keep doing independent work. If a completion notice will arrive and no independent work remains, yield and wait for it. If none will arrive, check status with the tools you actually have, without busy-polling or sleeping. Before the task ends, collect needed results and stop unrelated work.",
  child: "When your report is complete, send it to the parent with `send_message`. This is the last substantive output of the turn; then end briefly. Don't declare completion while background work is still running.",
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
        return { issues: [{ message: "Expected optional text overrides for native, typescript, python, output, background, child" }] };
      }
      return { value: { text: { ...DEFAULT_TEXT, ...input.text } } };
    },
  },
};

/** Require the public continuable identity, not a session label or fork-inherited descriptor. */
function canReport(ctx, agent, tool) {
  if (!agent || !tool?.parameters?.properties?.agent_id || !tool.parameters.properties.message) return false;
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
    const direct = new Map(assembled.tools.map(tool => [tool.name, tool]));
    const sdk = direct.has("run_code")
      && assembled.sections.some(section => section.name === "tools:sdk" && section.text.trim());
    const tool = name => direct.get(name) ?? (sdk ? ctx.tools.get(name, context.scope) : undefined);
    const selected = [];
    if (sdk) {
      const language = ctx.get("ptcRuntime")?.language;
      if (language === "typescript" || language === "python") {
        selected.push(config.text[language], config.text.output);
      }
    } else if (direct.size && !direct.has("run_code")) {
      selected.push(config.text.native);
    }
    const background = ["bash", "workflow"].some(name =>
      tool(name)?.parameters?.properties?.run_in_background?.type === "boolean");
    if (background && tool("job_output")?.parameters?.properties?.job_id
      && tool("job_kill")?.parameters?.properties?.job_id) selected.push(config.text.background);
    if (canReport(ctx, context.agent, tool("send_message"))) selected.push(config.text.child);
    const text = ["## Runtime tooling", ...selected].join("\n\n");
    return { ...assembled, sections: assembled.sections.flatMap(section => section.name !== SECTION
      ? [section] : selected.length ? [{ ...section, text }] : []) };
  });
}
