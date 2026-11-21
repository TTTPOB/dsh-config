import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';

export const name = 'stream-loop-guard';
export const inject = ['llm', 'agents', 'sessions'];
export const FAILURE_CODE = 'STREAM_LOOP_DETECTED';

const MAX_RETRIES = 5;
const EXCERPT_SIZE = 200;
const chunkSize = 8192;
const codecs = {
  B2: bytes => zlib.brotliCompressSync(bytes, { chunkSize, params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 2,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 12,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 0,
  } }).length,
  RLE: bytes => zlib.deflateSync(bytes, { chunkSize, level: 1, strategy: zlib.constants.Z_RLE }).length,
  Z1: bytes => zlib.zstdCompressSync(bytes, { chunkSize, params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 1,
  } }).length,
  D6: bytes => zlib.deflateSync(bytes, { chunkSize, level: 6 }).length,
};

const defaults = {
  B2: { window: 250, step: 250, consecutive: 2, threshold: 2.80 },
  RLE: { window: 250, step: 250, consecutive: 6, threshold: 2.00 },
  Z1: { window: 250, step: 250, consecutive: 2, threshold: 3.30 },
  D6: { window: 1000, step: 250, consecutive: 3, threshold: 4.75, shortWindow: 500, gain: 2.5 },
};

const hasOnly = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const positiveNumber = value => Number.isFinite(value) && value > 0;
const issue = (path, message) => ({ issues: [{ path, message }] });

export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input) {
      const keys = Object.keys(defaults);
      if (!hasOnly(input, ['disabledProviders', 'excerptLimit', 'rules'])) {
        return issue([], 'Expected an object with optional disabledProviders, excerptLimit and rules');
      }
      const { disabledProviders = [], excerptLimit = 600, rules = {} } = input;
      if (!Array.isArray(disabledProviders) || disabledProviders.some(id => typeof id !== 'string' || !id.trim())) {
        return issue(['disabledProviders'], 'Expected a list of non-empty provider IDs');
      }
      if (!Number.isSafeInteger(excerptLimit) || excerptLimit < 4) {
        return issue(['excerptLimit'], 'Expected an integer of at least 4 (including JSON quotes)');
      }
      if (!hasOnly(rules, keys)) return issue(['rules'], 'Expected optional overrides for B2, RLE, Z1 and D6');
      const resolved = {};
      for (const codec of keys) {
        const override = rules[codec] ?? {};
        if (!hasOnly(override, Object.keys(defaults[codec]))) {
          return issue(['rules', codec], 'Unexpected rule field');
        }
        const rule = { ...defaults[codec], ...override };
        if (![rule.window, rule.step, rule.consecutive].every(positiveInt) || !positiveNumber(rule.threshold)) {
          return issue(['rules', codec], 'Expected positive window, step, consecutive and threshold values');
        }
        if (codec === 'D6' && (!positiveInt(rule.shortWindow) || rule.shortWindow >= rule.window
          || !positiveNumber(rule.gain))) {
          return issue(['rules', codec], 'Expected a positive shortWindow smaller than window and a positive gain');
        }
        resolved[codec] = rule;
      }
      return { value: { disabledProviders, excerptLimit, rules: resolved } };
    },
  },
};

function ratio(codec, text) {
  const bytes = Buffer.from(text);
  return bytes.length / codecs[codec](bytes);
}

class Detector {
  #at = 0;
  #tail = '';
  #rules;
  #capacity;
  #next;

  constructor(rules) {
    this.#rules = Object.entries(rules).map(([codec, rule]) => ({
      codec, ...rule, run: 0, next: Math.ceil(rule.window / rule.step) * rule.step,
    }));
    this.#capacity = Math.max(...this.#rules.map(rule => rule.window)) + EXCERPT_SIZE;
    this.#next = Math.min(...this.#rules.map(rule => rule.next));
  }

  // UTF-16 positions match JavaScript slicing; ratios use compressed UTF-8 bytes.
  feed(delta) {
    for (let offset = 0; offset < delta.length;) {
      const take = Math.min(this.#next - this.#at, delta.length - offset);
      const end = offset + take;
      this.#tail = (this.#tail + delta.slice(Math.max(offset, end - this.#capacity), end)).slice(-this.#capacity);
      this.#at += take;
      offset = end;
      if (this.#at !== this.#next) continue;
      this.#next = Infinity;
      for (const rule of this.#rules) {
        if (rule.next === this.#at) {
          const { codec, window, shortWindow, gain, threshold, consecutive } = rule;
          const longRatio = ratio(codec, this.#tail.slice(-window));
          const shortRatio = shortWindow === undefined ? undefined : ratio(codec, this.#tail.slice(-shortWindow));
          const score = shortRatio === undefined ? longRatio : Math.min(longRatio, gain * longRatio / shortRatio);
          if (score >= threshold) {
            if (rule.run === 0) {
              rule.before = this.#tail.slice(-window - EXCERPT_SIZE, -window);
            }
            if (++rule.run === consecutive) {
              return { codec, window, ratio: longRatio, score, threshold, shortWindow, shortRatio, at: this.#at,
                before: rule.before, tail: this.#tail.slice(-Math.min(window, EXCERPT_SIZE)) };
            }
          } else {
            rule.run = 0;
          }
          rule.next += rule.step;
        }
        this.#next = Math.min(this.#next, rule.next);
      }
    }
  }
}

function quoteExcerpt(text, budget) {
  const chars = Array.from(text);
  while (chars.length) {
    const quoted = JSON.stringify(chars.join(''));
    if (quoted.length <= budget) return quoted;
    chars.shift();
  }
  return '""';
}

function renderHint({ what, at, before, tail }, turn, step, limit) {
  const beforeSize = JSON.stringify(before).length - 2;
  const tailSize = JSON.stringify(tail).length - 2;
  const budget = limit - 4;
  const beforeBudget = beforeSize + tailSize <= budget ? beforeSize : Math.floor(budget * beforeSize / (beforeSize + tailSize));
  return [
    `In turn ${turn}, step ${step}, your response was stopped because repetition was detected in its ${what} at character ${at}. The whole response was discarded: none of it was kept, and no tool call in it ran.`,
    'If the repetition was intended, such as many similar lines of code or data, produce it in smaller parts or generate it with a program. If it was an unintended loop, continue the task normally without repeating.',
    `Text before the repetition (JSON string): ${quoteExcerpt(before, beforeBudget + 2)}`,
    `End of the repeated text (JSON string): ${quoteExcerpt(tail, budget - beforeBudget + 2)}`,
  ].join('\n');
}

export function apply(ctx, config) {
  const retriesBySession = new Map();
  // AgentLoop snapshots chunks, so the failure object itself does not retain its identity.
  const hitsBySession = new Map();
  const disabled = new Set(config.disabledProviders);
  ctx.effect(() => () => {
    retriesBySession.clear();
    hitsBySession.clear();
  });
  ctx.on('session/disposed', ({ id }) => {
    retriesBySession.delete(id);
    hitsBySession.delete(id);
  });

  ctx.on('llm/stream', (options, next) => {
    const upstream = next();
    return !options.sessionId || disabled.has(options.provider) ? upstream : guard(upstream, options);
  });

  async function* guard(upstream, { sessionId, signal }) {
    const blocks = new Map();
    let failure;
    for await (const chunk of upstream) {
      if (chunk.type === 'block-start' || chunk.type === 'block-end') blocks.delete(chunk.index);
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
        let entries = blocks.get(chunk.index);
        if (!entries) blocks.set(chunk.index, entries = new Map());
        const tool = chunk.type === 'tool-call-delta';
        const key = tool ? `tool:${chunk.id}` : chunk.type;
        let entry = entries.get(key);
        if (!entry) entries.set(key, entry = { detector: new Detector(config.rules) });
        if (tool && chunk.name !== undefined) entry.toolName = chunk.name;
        const hit = entry.detector.feed(tool ? chunk.argumentsDelta : chunk.text);
        if (hit) {
          const what = tool
            ? entry.toolName ? `arguments for the ${entry.toolName} tool call` : 'tool call arguments'
            : chunk.type === 'text-delta' ? 'text' : 'reasoning';
          const shortDetails = hit.shortRatio === undefined ? ''
            : ` (ratio ${hit.shortRatio.toFixed(3)} over the last ${hit.shortWindow} characters)`;
          failure = { code: FAILURE_CODE,
            message: `Repetition detected in ${what} at character ${hit.at}: ${hit.codec} compression ratio ${hit.ratio.toFixed(3)} over the last ${hit.window} characters, score ${hit.score.toFixed(3)} ≥ threshold ${hit.threshold}${shortDetails}.` };
          hitsBySession.set(sessionId, { hit, what, signal, message: failure.message });
          break;
        }
      }
      yield chunk;
    }
    // IteratorClose has reached the adapter before the agent receives the terminal error.
    if (failure) yield { type: 'finish', reason: { kind: 'error', failure } };
  }

  ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    if (failure.code !== FAILURE_CODE || signal.aborted) return next();
    const id = agent.session.id;
    const previous = retriesBySession.get(id);
    const retries = previous?.turn === turn && previous.step === step ? previous.retries : 0;
    const record = hitsBySession.get(id);
    const hit = record && record.signal === signal && record.message === failure.message ? record : undefined;
    if (hit) hitsBySession.delete(id);
    if (retries >= MAX_RETRIES) return next();
    if (hit) {
      agent.session.append('user/message', {
        id: randomUUID(), role: 'user', source: { kind: name },
        content: [{ type: 'text', text: renderHint({ ...hit.hit, what: hit.what }, turn, step, config.excerptLimit) }],
      }, { surfaceOp: 'append' });
    }
    retriesBySession.set(id, { turn, step, retries: retries + 1 });
    return { kind: 'retry' };
  });
}
