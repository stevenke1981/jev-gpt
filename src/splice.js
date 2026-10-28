// Resumes a Responses turn inside one client response. The terminal `response.completed`
// event is held back; when the caller decides the turn ended too early, a continuation
// request is sent and its events stream on in place of that event, so the client (Codex)
// sees one turn that keeps working.
// CONTRACT STUB (lead): signatures are fixed; owner B implements the bodies.

/**
 * Splits an SSE stream into whole events (blocks ending in a blank line).
 * @returns {{push(chunk:Buffer|string):Array<{raw:string, type:string|null, data:object|null}>,
 *            flush():Array<{raw:string, type:string|null, data:object|null}>}}
 *   raw: the event text including its trailing blank line, written to the client as is;
 *   type: the `event:` field or data.type; data: the parsed `data:` JSON or null
 */
export function createSseFramer() {
  throw new Error('not implemented');
}

/**
 * Output items of a finished generation as input items for the next request:
 * ids and statuses dropped (Codex sends none; with store=false ids are not resolvable).
 * @param {object[]} output `response.output`
 * @returns {object[]}
 */
export function replayItems(output) {
  throw new Error('not implemented');
}

/**
 * The request that resumes the turn: the sent body plus the replayed output, a developer
 * message with `text`, and the given effort. Never mutates `sentBody`.
 */
export function continuationBody(sentBody, output, text, effort) {
  throw new Error('not implemented');
}

/**
 * Streams `upstream` (a fetch Response with an SSE body) to `res`, holding each
 * `response.completed`. `onCompleted(data, round)` returns null to release it, or a
 * Promise of a fetch Response whose events continue the stream (its `response.created`
 * and `response.in_progress` are dropped). A failed continuation releases the held event.
 * @param {import('node:http').ServerResponse} res
 * @param {Response} upstream
 * @param {{onEvent?:(data:object)=>void, onCompleted:(data:object, round:number)=>Promise<Response|null>|Response|null}} hooks
 */
export async function pipeWithContinuation(res, upstream, hooks) {
  throw new Error('not implemented');
}
