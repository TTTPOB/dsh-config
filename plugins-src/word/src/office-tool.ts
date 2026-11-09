import type { Schema } from '../../shared/types.ts';

/** DSH-owned execution tool, including local binary file inputs. */
export const officeTool = {
  description: 'Run a trusted asynchronous function against the chosen Word document. Its body executes within Word.run and receives context; call context.sync() to flush edits. Available globals: Word, Office, JSZip, console, DOMParser, XMLSerializer. The result envelope is {success:true,result}. For binary inputs, set files to a map of JavaScript identifiers and absolute DSH-side filenames; files.<identifier> then contains base64 bytes, not a data URL. Never paste encoded binary content into code. This execution environment has no Claude application services, uploaded-file storage, model orchestration, attachImage, Conductor, or SES isolation.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      files: {
        type: 'object',
        description: 'Local binary inputs keyed by JavaScript identifier. Give an absolute DSH-side filename for each entry; your code reads its encoded contents as files.<identifier>.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['code'],
  },
} as const satisfies { description: string; parameters: Schema };
