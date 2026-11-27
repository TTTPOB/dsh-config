import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run trusted asynchronous code against the selected PowerPoint presentation. Start document work with PowerPoint.run and return a JSON-compatible value. Available globals: PowerPoint, Office, DOMParser, JSZip, XMLSerializer, insertImage. Supply binary inputs through the optional files map using absolute DSH-side paths; the code can read their base64 bytes from files.<identifier>. Do not paste encoded images or presentations into code or tool arguments.',
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
