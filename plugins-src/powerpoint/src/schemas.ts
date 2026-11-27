import type { Schema } from '../../shared/types.ts';
export const objectSchema = { type: 'object', additionalProperties: true } as const satisfies Schema;

export const jsonSchema = { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } as const satisfies Schema;

export const textRender = (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }];

export const slideParam = { type: 'integer', description: 'One-based slide index in the current deck.' } as const satisfies Schema;
export const slideIdDescription = 'Current slide ID. OOXML writebacks can change it; use slide_id_update or read powerpoint_deck_info.';
export const slideLocatorProperties = {
  slide_id: { type: 'string', description: slideIdDescription },
  slide_index: { type: 'integer', description: 'One-based position; can shift when slides are added, deleted, or moved.' },
} as const;

export const imageSchema = { type: 'object', properties: { attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' }, originalDimensions: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false } }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: false } as const satisfies Schema;
