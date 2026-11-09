import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run trusted asynchronous code against the selected PowerPoint presentation. Start document work with PowerPoint.run and return a JSON-compatible value. Available globals: PowerPoint, Office, DOMParser, JSZip, XMLSerializer, insertImage. Supply binary inputs through the optional files map using absolute DSH-side paths; the code can read their base64 bytes from files.<identifier>. Do not paste encoded images or presentations into code or tool arguments.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      files: {
        type: 'object',
        description: 'Local binary inputs keyed by a JavaScript identifier. Each value is an absolute DSH-side filename; files.<identifier> exposes its encoded bytes to your code.',
        propertyNames: { pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' },
        additionalProperties: { type: 'string' },
      },
    },
    required: ['code'],
  },
} as const satisfies { description: string; parameters: Schema };
