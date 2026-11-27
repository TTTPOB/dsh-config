import type { Properties, Schema } from './types.ts';

export const string = { type: 'string' } as const;
export const integer = { type: 'integer' } as const;
export const number = { type: 'number' } as const;
export const boolean = { type: 'boolean' } as const;
export const trueValue = { type: 'boolean', const: true } as const;

/** Closed records assembled by the add-in, with required and conditional fields separated. */
export function record(required: Properties, optional: Properties = {}): Schema {
  return { type: 'object', properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false };
}

export function openRecord(required: Properties, optional?: Properties): Schema {
  return { ...record(required, optional), additionalProperties: true };
}

export function array(items: Schema): Schema {
  return { type: 'array', items };
}

export function nullable(schema: Schema): Schema {
  return { oneOf: [schema, { type: 'null' }] };
}

export function success(result: Schema, optional?: Properties): Schema {
  return record({ success: trueValue, result }, optional);
}
