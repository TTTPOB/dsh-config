import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run a trusted asynchronous function against the chosen Word document. Its body executes within Word.run and receives context; call context.sync() to flush edits. Available globals: Word, Office, JSZip, console, DOMParser, XMLSerializer. The tool returns your code\'s return value directly. For binary inputs, set files to a map of JavaScript identifiers and absolute DSH-side filenames; files.<identifier> then contains base64 bytes, not a data URL. Never paste encoded binary content into code. This execution environment has no Claude application services, uploaded-file storage, model orchestration, attachImage, Conductor, or SES isolation.',
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
