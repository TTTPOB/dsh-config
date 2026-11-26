// Goal policy for the daily presets: create goals only on explicit request, and
// keep automatic goal rounds from idling while background jobs run.
//
// Why the job reminder exists: since deepseek-harness d99d8afa43 the goal round
// driver waits for the subagent tree before it starts the next automatic round,
// but it does not wait for background jobs. If the model ends its turn only to
// wait for a job, the driver starts the next round at once; the model sees the
// job still running and ends the turn again, burning rounds until round-limit.
//
// Why inject at each round through agent/pre-step instead of on goal tool
// results: /goal creates goals through ctx.goals directly, so no tool result
// exists to carry a reminder. A one-shot reminder at creation is also far from
// the moment of risk and may be compacted away. Checking running jobs when each
// automatic round enters covers both entry points and adds nothing otherwise.
//
// Why rewrite the creation guidance instead of appending an override: upstream
// tells the model to infer goals from long-running requests, in both the
// create_goal description and the tool:goal section. An extra section saying
// the opposite would leave two contradicting instructions; replacing the
// sentences leaves one. system-prompt/assemble sees resolved section text, and
// in PTC mode the create_goal description is part of the tools:sdk section.
//
// Accepted limitation: Native tool declarations are provider-owned and never
// pass through this waterfall, so Native mode keeps the upstream create_goal
// description and only tool:goal is rewritten. The daily preset standard-ptc
// uses PTC, so it is fully covered.
//
// Upgrade drift: the installed-runtime test fails when upstream wording no
// longer matches, and a one-time runtime warning reports a missed rewrite.
import { randomUUID } from 'node:crypto';

export const name = 'goal-policy';
export const inject = ['jobs', 'systemPrompt'];

export const Config = {
  '~standard': {
    version: 1,
    vendor: name,
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
        return { issues: [{ message: 'Expected an empty object' }] };
      }
      return { value: {} };
    },
  },
};

// TypeScript PTC renders the full description as a single JSDoc line.
export const SDK_CREATE_SENTENCE = 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.';
export const GOAL_GUIDANCE_SENTENCE = 'create_goal may infer goal intent from a direct human request in any language.';
const explicitGoal = 'only when the direct human explicitly asks to create, start, or set a goal, in any language. Never infer goal intent from task size or duration.';
const rewrites = new Map([
  ['tools:sdk', [SDK_CREATE_SENTENCE, `Use it ${explicitGoal}`]],
  ['tool:goal', [GOAL_GUIDANCE_SENTENCE, `Call create_goal ${explicitGoal}`]],
]);
let warnedAboutDrift = false;

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    const hasGoalGuidance = assembly.sections.some(section => section.name === 'tool:goal');
    let changed = false;
    const sections = assembly.sections.map(section => {
      const rewrite = rewrites.get(section.name);
      if (!rewrite) return section;
      const text = section.text.replace(...rewrite);
      if (text !== section.text) {
        changed = true;
        return { ...section, text };
      }
      if (hasGoalGuidance && !warnedAboutDrift) {
        warnedAboutDrift = true;
        ctx.logger.warn(`${name}: expected create_goal wording not found in ${section.name}; check for upstream wording changes.`);
      }
      return section;
    });
    return changed ? { ...assembly, sections } : assembly;
  });

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter'
      || !messages.some(({ source }) => source.kind === 'goal' && source.round > 0)) return decision;
    const running = ctx.jobs.list(agent.session.id).filter(job => job.status === 'running');
    if (running.length === 0) return decision;
    const jobs = running.map(({ id, label }) => `- ${id}: ${label}`).join('\n');
    const reminder = {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: 'These background jobs are still running:\n' + jobs
          + '\nIf only waiting remains, call job_output with wait: true to block on them within this turn. '
          + 'Do not end the turn just to wait: ending it immediately starts another goal round.',
      }],
      source: { kind: name },
    };
    return { ...decision, messages: [...decision.messages, reminder] };
  });
}
