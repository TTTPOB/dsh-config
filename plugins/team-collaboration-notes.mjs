export const name = 'team-collaboration-notes';
export const inject = ['systemPrompt'];

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

export function apply(ctx) {
  ctx.inject(['agentTeams'], scope => scope.effect(() => scope.systemPrompt.section({
    name: 'team:collaboration-notes',
    interpolate: false,
    order: scope.systemPrompt.getSectionOrder('TEAM_POLICY') + 1,
    text({ agent }) {
      if (!agent) return '';
      try {
        // agentTeams is optional; isEnabled resolves the caller's root session.
        if (!scope.agentTeams.isEnabled(agent)) return '';
      } catch (error) {
        // An independently resumed child may have no live root.
        if (error?.name === 'SubagentError' && error.code === 'UNAUTHORIZED') return '';
        throw error;
      }
      return 'You are notified only when your own direct subagents finish, not when siblings or other agents do. '
        + 'When you need another agent\'s result, ask it to send the result to you with `send_message` when it is done.';
    },
  })));
}
