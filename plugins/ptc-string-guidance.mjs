export const name = "ptc-string-guidance";
export const inject = ["systemPrompt"];
export const SECTION = "dsh-config:ptc-string-guidance";

export const DEFAULT_TEXT = [
  "## PTC string construction",
  "Treat the code value as TypeScript source after tool-argument JSON decoding. Do not manually add JSON-layer escaping to that source.",
  "Write every text payload that spans lines or contains quotes, backslashes, backticks, or ${ as a raw text literal. This covers file contents, Markdown, edit strings, shell commands, embedded scripts, regular expression sources, and agent messages.",
  "- Open with @ and two or more backticks; close with the same number of backticks. Content between them is verbatim: no escapes and no interpolation, so quotes, backslashes, \\n, and ${...} stay literal characters.",
  "- One line break directly after the opening delimiter is dropped. Everything else is kept, including indentation and the line break before the closing delimiter.",
  "- When the content contains that many consecutive backticks, such as a Markdown ``` fence, use a longer delimiter: @```` ... ````.",
  "- The sequence @ followed by two or more backticks always starts a raw literal, even inside strings, comments, and regular expressions. To write that sequence as ordinary text, use \\x40`` in a string or put it inside a raw literal with a longer delimiter.",
  "- Use ordinary double-quoted strings only for short one-line values without quotes or backslashes. Do not use template literals, String.raw, JSON.parse, or Base64 for hand-authored payloads.",
  "Example:",
  "const readme = @``",
  "# Title",
  "Run `npm test`; keep \"quotes\", C:\\path, and \\n as written.",
  "``;",
  "await tools.write({ file_path: \"README.md\", content: readme });",
  "For embedded shell scripts, pass the script on stdin with a quoted heredoc (<<'EOF') or write it to a file first. Do not nest scripts inside ssh '...' or python -c \"...\".",
  "On a parser error, read the reported location. If it points into a string, rewrite that string as a raw literal instead of adding backslashes.",
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
