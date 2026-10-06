import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const name = 'personal-prompt-sections';
export const inject = ['systemPrompt'];

/** A dependency-free Standard Schema accepted by Cordis. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'personal-prompt-sections',
    validate(input) {
      const value = { order: 100, shadowHarnessIdentity: true, ...input };
      const issues = [];
      const fields = value.shadowHarnessIdentity ? ['promptFile', 'identityFile'] : ['promptFile'];
      for (const field of fields) {
        if (typeof value[field] !== 'string' || !isAbsolute(value[field])) {
          issues.push({ message: `${field} must be an absolute path`, path: [field] });
        }
      }
      if (!Number.isFinite(value.order)) issues.push({ message: 'order must be finite', path: ['order'] });
      if (typeof value.shadowHarnessIdentity !== 'boolean') {
        issues.push({ message: 'shadowHarnessIdentity must be boolean', path: ['shadowHarnessIdentity'] });
      }
      return issues.length ? { issues } : { value };
    },
  },
};

function readText(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error('Configured prompt file is empty');
  return text;
}

/** Read private text once per activation; register only in the mounting scope. */
export function apply(ctx, config) {
  const kernel = readText(config.promptFile);
  const identity = config.shadowHarnessIdentity ? readText(config.identityFile) : undefined;
  ctx.effect(() => ctx.systemPrompt.section({
    // Retain the existing section label and ordering.
    name: 'dsh-prompt-overlay:kernel',
    order: config.order,
    text: kernel,
    interpolate: false,
  }));
  if (identity !== undefined) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'harness:identity',
      order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
      text: identity,
      interpolate: false,
    }));
  }
}
