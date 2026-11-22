export const name = 'error-code-rules';
export const inject = ['llm'];

const codes = new Set([
  'AUTH', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'INVALID_REQUEST', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR',
]);
const hasOnly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const issue = (path, message) => ({ issues: [{ path, message }] });

export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input) {
      if (!hasOnly(input, ['rules']) || !Array.isArray(input.rules)) {
        return issue([], 'Expected an object with a rules array');
      }
      const rules = [];
      for (const [index, rule] of input.rules.entries()) {
        const path = ['rules', index];
        if (!hasOnly(rule, ['providers', 'match', 'code'])) {
          return issue(path, 'Expected a rule with providers, match and code');
        }
        const { providers, match, code } = rule;
        if (!Array.isArray(providers) || !providers.length || providers.some(id => typeof id !== 'string' || !id.trim())) {
          return issue([...path, 'providers'], 'Expected a nonempty list of provider IDs');
        }
        if (!codes.has(code)) return issue([...path, 'code'], 'Expected a supported failure code');
        if (typeof match !== 'string') return issue([...path, 'match'], 'Expected a regex source string');
        let regex;
        try {
          regex = new RegExp(match);
        } catch (error) {
          return issue([...path, 'match'], error.message);
        }
        rules.push({ providers, regex, code });
      }
      return { value: { rules } };
    },
  },
};

export function apply(ctx, config) {
  const byProvider = new Map();
  for (const { providers, regex, code } of config.rules) {
    for (const provider of providers) {
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push({ regex, code });
    }
  }

  ctx.on('llm/stream', ({ provider }, next) => {
    const upstream = next();
    const rules = byProvider.get(provider);
    return rules ? rewrite(upstream, rules) : upstream;
  });
}

async function* rewrite(upstream, rules) {
  for await (const chunk of upstream) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      const { failure } = chunk.reason;
      if (codes.has(failure.code)) {
        const rule = rules.find(({ regex }) => regex.test(failure.message));
        if (rule) {
          yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code: rule.code } } };
          continue;
        }
      }
    }
    yield chunk;
  }
}
