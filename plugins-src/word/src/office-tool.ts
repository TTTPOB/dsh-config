import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run trusted asynchronous JavaScript against the selected Word document. The body runs inside Word.run with context in scope; call await context.sync() after edits and before reading loaded values. The tool returns your code\'s JSON-compatible return value as is, or null when the code returns nothing. Globals: Word, Office, JSZip, DOMParser, XMLSerializer, console. For binary inputs, pass files as a map from JavaScript identifiers to absolute file paths on the DSH machine; files.<identifier> then holds the file\'s raw base64 bytes, not a data URL. The files global exists only when you pass files. Never paste encoded binary content into code or other arguments. This environment has no Claude application services, uploaded-file storage, model orchestration, attachImage, Conductor, or SES isolation.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Body of an async JavaScript function that runs inside Word.run with `context` in scope. Call await context.sync() after edits and return a JSON-compatible value.' },
      files: {
        type: 'object',
        additionalProperties: true,
        description: "Optional. Keys are JavaScript identifiers; each value is an absolute file path on the DSH machine. Your code reads that file's raw base64 bytes as files.<identifier>.",
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
} as const satisfies { description: string; parameters: Schema };
