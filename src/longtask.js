// Long-task help. GPT-6.1 Terra tends to end a turn before a long task is done: it
// summarizes, promises "next I will…", or asks whether to continue. These pure functions
// read the agent's plan, tell whether a finished generation ended the turn, judge whether
// that stop was premature, and write the reminder and resume messages.
// CONTRACT STUB (lead): signatures are fixed; owner A implements the bodies.

/**
 * The agent's latest plan in the current turn (after the latest real user message):
 * Codex `update_plan` ({plan:[{step,status}]}) or opencode-style `todowrite`/`TodoWrite`
 * ({todos:[{content,status}]}), from a Responses `input` or a Chat `messages` array.
 * @param {object} body request body
 * @returns {{total:number, done:number, open:string[]}|null} null when the turn has no plan
 */
export function turnPlan(body) {
  throw new Error('not implemented');
}

/**
 * Whether a finished Responses generation ended the turn, and its visible text.
 * @param {object} response the `response` of a `response.completed` event (has `output`)
 * @returns {{ended:boolean, text:string}} ended: no client-executed tool call in `output`
 */
export function finalOutput(response) {
  throw new Error('not implemented');
}

/**
 * Heuristic: how likely the agent stopped before the task was done although it could go on alone.
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null}>}} turn
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @returns {{unfinished:number, reasons:string[]}} unfinished: 0..1
 */
export function assessStop(turn, plan, finalText) {
  throw new Error('not implemented');
}

/** Reminder appended before a generation while the plan has open steps. */
export function nudgeText(plan) {
  throw new Error('not implemented');
}

/** Instruction that resumes a turn the agent ended too early. */
export function continueText(plan, reasons) {
  throw new Error('not implemented');
}
