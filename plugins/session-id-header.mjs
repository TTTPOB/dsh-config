export const name = 'session-id-header';

const hasOnly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));

export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input) {
      if (!hasOnly(input, ['providers']) || !Array.isArray(input.providers) || !input.providers.length
        || input.providers.some(id => typeof id !== 'string' || !id.trim())) {
        return { issues: [{ path: ['providers'], message: 'Expected a nonempty list of provider IDs' }] };
      }
      return { value: { providers: input.providers } };
    },
  },
};

export function apply(ctx, config) {
  const providers = new Set(config.providers);
  // Pi AI 1.6.0 renamed session_id; Sub2API forwards only the legacy name to the Claude gateway.
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    const result = next();
    if (request.sessionId && providers.has(request.provider)) result.set('session_id', request.sessionId);
    return result;
  });
}
