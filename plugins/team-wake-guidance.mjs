export const name = "team-wake-guidance";
export const inject = ["systemPrompt"];

export const TEAM_TEXT = "Wake-ups in a Team: the Lead is notified when a teammate's turn ends, and that notice carries the teammate's final output. Teammates are not notified when another teammate finishes. Shared-task changes and task readiness notify no one. A member that needs another member's result asks it to send_message when done. The Lead gives the final answer after required teammates have reported.\n\nwait_agent is for deterministic orchestration inside a run_code program only: loop wait_agent, then check list_agents or team_task_list, until a specific condition holds, and set the run_code timeoutMs to cover the wait. It returns on the next Team change of any kind, not on a specific member's completion; it never wakes anyone and returns noProgress immediately when no other member is running or provisioning. Do not call it just to wait.";
export const WAIT_DESCRIPTION = "Wait for the next Team change of any kind (teammate status, message, or shared-task change) after this call starts. Use it only inside a run_code program as one step of a wait-then-check loop; to simply wait, end your turn. It never wakes inactive members and returns noProgress immediately when no other member is running or provisioning.";

const START = "Before wait_agent, use list_agents";
const END = "The Lead must wait for required teammates before giving the final answer.";
const OLD_WAIT_DESCRIPTION = "Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.";

export const Config = {
  "~standard": {
    version: 1,
    vendor: name,
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
        return { issues: [{ message: "Expected an empty object" }] };
      }
      return { value: {} };
    },
  },
};

/** Rewrite only upstream Team guidance after downstream assembly has completed. */
export function apply(ctx) {
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    if (!assembled.sections.some(section => section.name === "team:policy")) return assembled;
    return { ...assembled, sections: assembled.sections.map(section => {
      if (section.name === "team:policy") {
        const start = section.text.indexOf(START);
        const end = section.text.indexOf(END, start);
        if (start < 0 || end < 0) {
          throw new Error("Upstream team:policy wording changed; update team-wake-guidance (missing replacement anchors)");
        }
        const before = section.text.slice(0, start).trimEnd();
        const after = section.text.slice(end + END.length).trimStart();
        return { ...section, text: [before, TEAM_TEXT, after].filter(Boolean).join("\n\n") };
      }
      if (section.name === "tools:sdk" && section.text.trim() && /\bwait_agent\s*:/.test(section.text)) {
        if (!section.text.includes(OLD_WAIT_DESCRIPTION)) {
          throw new Error("Upstream tools:sdk wait_agent description changed; update team-wake-guidance");
        }
        return { ...section, text: section.text.replace(OLD_WAIT_DESCRIPTION, WAIT_DESCRIPTION) };
      }
      return section;
    }) };
  });
}
