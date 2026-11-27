import type { Schema } from './types.ts';

/** Reject unknown keys before a closed Office tool can act on unintended defaults. */
export function rejectUnknownArguments(args: unknown, schema: Schema) {
  if (schema.type !== 'object' || schema.additionalProperties !== false || !args || typeof args !== 'object') return;
  const properties = schema.properties ?? {};
  const unknown = Object.keys(args).find(key => !Object.hasOwn(properties, key));
  if (unknown !== undefined) {
    const accepted = Object.keys(properties);
    throw new Error('Unknown argument ' + JSON.stringify(unknown) + '. Accepted keys: ' + (accepted.join(', ') || '(none)') + '.');
  }
}
