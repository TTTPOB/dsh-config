export const name = 'provider-prompt';
export const inject = ['systemPrompt'];
export const SECTION = 'dsh-config:provider-prompt';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);

/** Validate explicit provider/model rules without adding runtime dependencies. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input) {
      if (!object(input) || Object.keys(input).some(key => key !== 'rules') || !Array.isArray(input.rules)) {
        return { issues: [{ message: 'Expected an object with a rules array' }] };
      }
      const issues = [];
      input.rules.forEach((rule, index) => {
        if (!object(rule) || Object.keys(rule).some(key => !['providers', 'models', 'text'].includes(key))) {
          issues.push({ message: 'Expected a rule with providers, optional models, and text', path: ['rules', index] });
          return;
        }
        if (!list(rule.providers)) {
          issues.push({ message: 'providers must be a nonempty string array', path: ['rules', index, 'providers'] });
        }
        if (rule.models !== undefined && !list(rule.models)) {
          issues.push({ message: 'models must be a nonempty string array when provided', path: ['rules', index, 'models'] });
        }
        if (!nonempty(rule.text)) {
          issues.push({ message: 'text must be nonempty', path: ['rules', index, 'text'] });
        }
      });
      return issues.length ? { issues } : { value: input };
    },
  },
};

/** Contribute literal matching text in the mounting scope, reevaluated at every assembly. */
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1,
    interpolate: false,
    text(context) {
      const options = context.agent?.options;
      if (!options?.provider) return '';
      return config.rules
        .filter(rule => rule.providers.includes(options.provider)
          && (rule.models === undefined || rule.models.includes(options.model)))
        .map(rule => rule.text)
        .join('\n\n');
    },
  }));
}
