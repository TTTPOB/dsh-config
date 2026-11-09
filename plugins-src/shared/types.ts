/** JSON Schema subset used by the standalone Office tool definitions. */
export interface Schema {
  [keyword: string]: unknown;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Properties;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly unknown[];
  oneOf?: readonly Schema[];
}

type RequiredKeys<S> = S extends { required: readonly (infer K)[] } ? K : never;
type ObjectArgs<S, P extends Properties> = {
  [K in keyof P as K extends RequiredKeys<S> ? K : never]-?: Args<P[K]>;
} & {
  [K in keyof P as K extends RequiredKeys<S> ? never : K]?: Args<P[K]>;
} & (S extends { additionalProperties: false } ? object : Record<string, unknown>);

/** Infer handler inputs from the existing schemas without adding runtime validation. */
export type Args<S> = S extends { enum: readonly (infer E)[] }
  ? E
  : S extends { type: 'string' }
    ? string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
        : S extends { type: 'null' }
          ? null
          : S extends { type: 'array'; items: infer I }
            ? Args<I>[]
            : S extends { type: 'object'; properties: infer P extends Properties }
              ? ObjectArgs<S, P>
              : S extends { type: 'object'; additionalProperties: infer A extends Schema }
                ? Record<string, Args<A>>
                : unknown;

/** Minimal Host services consumed by the standalone Office modules. */
export interface Execution {
  signal?: AbortSignal;
  agent?: { session?: { id: string } };
}
export type Disposer = () => void;
export type Properties = Record<string, Schema>;
export type ObjectSchema<P extends Properties, R extends readonly string[]> = {
  type: 'object';
  properties: P;
  required: R;
  additionalProperties: false;
};
export type Render<V> = (args: unknown, value: V) => unknown[];
export interface Tool<S extends Schema, V> {
  name: string;
  deferLoading: boolean;
  description: string;
  timeoutMs: number;
  parameters: S;
  output: { schema: Schema; render: Render<V> };
  execute: (args: Args<S>, exec: Execution) => Promise<V>;
}
export interface AddTool {
  <const P extends Properties, const R extends readonly string[], V>(
    name: string,
    description: string,
    properties: P,
    required: R,
    schema: Schema,
    execute: (args: Args<ObjectSchema<P, R>>, exec: Execution) => Promise<V>,
    render?: Render<V>,
  ): void;
}
export interface Image {
  attachmentId: string | number;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}
export interface SkillSummary {
  name: string;
  description: string;
  provider: string;
  source: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
}
export interface Context {
  logger?: { warn: (message: string) => void };
  effect: (create: () => Disposer) => void;
  tools: { register: <S extends Schema, V>(tool: Tool<S, V>) => Disposer };
  skills: {
    registerProvider: (
      create: () => {
        name: string;
        list: () => Promise<(SkillSummary & { rank: number; locator: string })[]>;
        get: () => Promise<SkillSummary & { content: string }>;
      },
    ) => Disposer;
  };
  attachments: { saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<Image> };
}
