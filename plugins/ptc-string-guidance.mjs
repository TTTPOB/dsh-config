export const name = "ptc-string-guidance";
export const inject = ["systemPrompt"];
export const SECTION = "dsh-config:ptc-string-guidance";

export const DEFAULT_TEXT = [
  "## PTC string construction",
  "1. Write every multi-line text or text containing quotes, backslashes or backticks as a raw text literal: @``text`` (verbatim, no escaping or interpolation; one opening line break is dropped).",
  "2. Pass shell scripts on stdin with a quoted heredoc (<<'EOF') or write them to a file first; never nest scripts inside ssh '...' or python -c \"...\".",
  "",
  "Wrong:",
  "await tools.write({ file_path: \"note.md\", content: \"Say \\\"hello\\\"\\n```text\\nsample\\n```\" });",
  "Right:",
  "await tools.write({ file_path: \"note.md\", content: @````",
  "Say \"hello\"",
  "```text",
  "sample",
  "```",
  "```` });",
  "",
  "Wrong:",
  "await tools.edit({ file_path: \"note.md\", old_string: \"Say \\\"hello\\\"\", new_string: \"Say \\\"hi\\\"\" });",
  "Right:",
  "await tools.edit({ file_path: \"note.md\", old_string: @``Say \"hello\"``, new_string: @``Say \"hi\"`` });",
  "",
  "Wrong:",
  "await tools.bash({ description: \"Run Python\", command: \"ssh example.invalid 'python -c \\\"print(\\\\\\\"hello\\\\\\\")\\\"'\" });",
  "Right:",
  "await tools.bash({ description: \"Run Python\", command: @``",
  "ssh example.invalid python - <<'EOF'",
  "print(\"hello\")",
  "EOF",
  "`` });",
].join("\n");

/** Validate the optional deployment-owned wording without external dependencies. */
export const Config = {
  "~standard": {
    version: 1,
    vendor: name,
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => key !== "text")
        || (input.text !== undefined && (typeof input.text !== "string" || !input.text.trim()))) {
        return { issues: [{ message: "Expected an object with optional nonempty text" }] };
      }
      return { value: { text: input.text ?? DEFAULT_TEXT } };
    },
  },
};

/** Register literal guidance; remove only our section from non-TypeScript PTC assemblies. */
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") + 1,
    interpolate: false,
    text: config.text,
  }));
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const hasSdk = assembled.sections.some(section => section.name === "tools:sdk" && section.text.trim());
    if (hasSdk && ctx.get("ptcRuntime")?.language === "typescript") return assembled;
    return { ...assembled, sections: assembled.sections.filter(section => section.name !== SECTION) };
  });
}
