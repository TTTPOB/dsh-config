import type { Schema } from './types.ts';

const keywords = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
]);

/** Retain DSH-supported keywords and convert disjoint scalar unions without weakening them. */
export function normalizeSchema(input: Schema, describe: (text: string) => string): Schema {
  const output: Schema = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'anyOf') {
      const branches = value as Schema[];
      const types = branches.map(branch => branch.type);
      if (types.some(type => !['string', 'number', 'boolean', 'null'].includes(type ?? ''))
        || new Set(types).size !== types.length)
        throw new Error('Office catalog anyOf cannot be converted to disjoint oneOf');
      output.oneOf = branches.map(branch => normalizeSchema(branch, describe));
    } else if (!keywords.has(key)) {
      continue;
    } else if (key === 'properties') {
      output.properties = Object.fromEntries(Object.entries(value as Record<string, Schema>)
        .map(([name, schema]) => [name, normalizeSchema(schema, describe)]));
    } else if (key === 'oneOf') {
      output.oneOf = (value as Schema[]).map(schema => normalizeSchema(schema, describe));
    } else if (key === 'items') {
      output.items = normalizeSchema(value as Schema, describe);
    } else if (key === 'additionalProperties' && typeof value !== 'boolean') {
      throw new Error('Office catalog schema-valued additionalProperties is not supported by DSH');
    } else {
      output[key] = key === 'description' ? describe(value as string) : value;
    }
  }
  return output;
}

/** Resolve only whole raw tool-name references, leaving already-qualified names untouched. */
export function qualifyDescriptions(prefix: string, clientNames: string[]) {
  const names = new Set(clientNames);
  return (text: string) => text.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g,
    name => names.has(name) ? prefix + name : name);
}
