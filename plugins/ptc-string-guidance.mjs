export const name = "ptc-string-guidance";
export const inject = ["systemPrompt"];
export const SECTION = "dsh-config:ptc-string-guidance";

export const DEFAULT_TEXT = [
  "## PTC string construction",
  "Treat the code value as TypeScript source after tool-argument JSON decoding. Do not manually add JSON-layer escaping to that source.",
  "For prose, Markdown, edit replacements, and agent messages:",
  "- Use double-quoted strings. For multiline text, use an array of one string per line and join(\"\\n\").",
  "- Represent blank lines with an empty string; preserve a trailing newline with a final empty array element.",
  "- Inside each source string, escape double quotes as \\\" and literal backslashes as \\\\. Never put literal line breaks inside ordinary quoted strings.",
  "- Do not use template literals or String.raw for arbitrary text payloads. Backticks and ${...} in payloads must remain literal data.",
  "- Do not wrap hand-authored payloads in JSON.parse or manually encode them as Base64 to avoid quoting.",
  "Construct long text in named variables before passing it to tools. Keep tool-call objects and delimiters simple and visibly balanced.",
  "On a parser error, inspect the decoded TypeScript source, especially the preceding string boundary. Do not blindly add commas or backslashes; rewrite unclear quoting using the line-array pattern.",
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
