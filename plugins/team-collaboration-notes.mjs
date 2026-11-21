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
  ctx.systemPrompt.section({
    name: 'team:collaboration-notes',
    interpolate: false,
    order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY') + 1,
    text({ agent }) {
      if (!agent) return '';
      try {
        // agentTeams is optional; isEnabled resolves the caller's root session.
        if (!ctx.get('agentTeams')?.isEnabled(agent)) return '';
      } catch (error) {
        // An independently resumed child may have no live root.
        if (error?.name === 'SubagentError' && error.code === 'UNAUTHORIZED') return '';
        throw error;
      }
      return 'You are not notified when a sibling or any agent other than a direct subagent finishes. '
        + 'If you need another agent\'s result, ask it to send you the result with send_message when it finishes.';
    },
  });
}
