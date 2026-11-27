import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run trusted asynchronous JavaScript against the selected PowerPoint presentation. There is no implicit context: open one with PowerPoint.run, and call await context.sync() after edits and before reading loaded values. The tool returns your code\'s JSON-compatible return value, or null when the code returns nothing. Globals: PowerPoint, Office, JSZip, DOMParser, XMLSerializer, insertImage. For binary inputs, pass files as a map from JavaScript identifiers to absolute file paths on the DSH machine; files.<identifier> then holds the file\'s raw base64 bytes, not a data URL. Without the files argument, files is an empty object. Never paste encoded images or presentations into code or other arguments.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Body of an async JavaScript function. Open document work with PowerPoint.run and return a JSON-compatible value.' },
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
