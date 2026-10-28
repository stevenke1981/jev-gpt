# Brief: jev-gpt long-task help (resume early stops, plan reminders)

Repo: `D:\jev-gpt` (Node >= 22.15, ESM, zero dependencies, tests `node --test`).
Read `src/*.js` and `test/*.js` first and match their style: small functions, short
comments that say *why*, no new dependencies, immutable updates (return new objects,
never mutate a request body or an array you were given).

## Goal

jev-gpt serves one model (GPT-6.1 Terra, `config.model`). Jev picks its reasoning effort
per generation (`src/router.js`, already done). Terra often ends a long task too early:
it summarizes, writes "next I will…", or asks "would you like me to continue?" while the
work is not done. The proxy must help it finish:

1. **Plan reminder (nudge)**: before a generation, if the agent's plan in the current
   turn still has open steps and `config.nudge`, append one reminder message at the END
   of the request (Responses: `{type:'message', role:'developer', content:[{type:'input_text', text}]}`;
   Chat: `{role:'system', content:text}`). Appending at the end keeps the prompt-cache prefix.
2. **Resume (continue)**: for a streamed Responses request (`stream: true`, SSE answer, HTTP 200)
   that was routed (a decision exists) and `config.continueTurns`, hold the terminal
   `response.completed`. If that generation ended the turn (`finalOutput(...).ended`), the
   turn has had at least one tool step or a plan, `router.continuesOf(session) < config.maxContinues`,
   and the stop check says `unfinished >= config.continueThreshold`, then call
   `router.noteContinue(session)` (gives the new effort), build `continuationBody(...)` and
   stream its events in place of the held event. Otherwise release the held event.
   Rounds chain: a resumed generation that again ends early may be resumed again until the cap.

## Shared contract (committed by the lead; signatures are fixed)

- `src/config.js`: `model`, `ladder`, `defaultEffort`, `continueTurns`, `maxContinues`,
  `continueThreshold`, `nudge`, `mode` (`jev|heuristic|llm|off`), decision settings.
- `src/router.js`: `route(...)`, `continuesOf(session)`, `noteContinue(session) -> {continues, effort}`.
- `src/longtask.js` (owner A): `turnPlan(body)`, `finalOutput(response)`, `assessStop(turn, plan, finalText)`,
  `nudgeText(plan)`, `continueText(plan, reasons)`. See the JSDoc in the stub.
- `src/splice.js` (owner B): `createSseFramer()`, `replayItems(output)`,
  `continuationBody(sentBody, output, text, effort)`, `pipeWithContinuation(res, upstream, hooks)`.
- `src/decisions.js` (owner A) adds:
  ```js
  /** @returns {Promise<{unfinished:number, reasons:string[], cost:number|null}>} */
  export async function jevStopCheck(turn, plan, finalText, opts)
  // opts = {url, apiKey, model, timeoutMs, sessionId?}
  ```
  Posts to the Decisions API like `jevDecide`, `state` = `buildState(turn, null)` plus
  `final_message` (first 2000 chars) and `plan` (`{total, done, open}` or null), one question:
  `unfinished` (type `noul`): "The coding agent just ended its turn. Did it stop before
  finishing the user's task, although it could keep going without the user's input?"
  criteria true: "Work it said it would do is not done, plan steps are open, changes are
  unverified, or it asks permission to continue routine work." false: "The task is done and
  verified, or it needs information, a decision or credentials only the user can give."
  Throws on HTTP error or a non-number answer. Reason text like `jev unfinished 0.82`.

## Owner A — `src/longtask.js`, `src/decisions.js` (jevStopCheck only), tests `test/longtask.test.js` (+ add cases to `test/decisions.test.js`)

- `turnPlan(body)`: items = `body.input` or `body.messages`. Current turn = after the
  latest real user message (reuse `textOf`, `isSyntheticUserText` from `src/trajectory.js`;
  Chat user content may be a string or parts). Find the LAST plan call in it:
  Responses `{type:'function_call', name:'update_plan', arguments:'{"plan":[{"step":"..","status":"pending|in_progress|completed"}]}'}`;
  Chat assistant `tool_calls[].function` with name `update_plan` (same args) or
  `todowrite`/`TodoWrite` (`{todos:[{content, status}]}`, status `completed` counts as done,
  `cancelled` counts as done too). Bad JSON / no plan -> null. `open` = texts of not-done steps, each cut to 120 chars.
- `finalOutput(response)`: `ended` is false when `output` contains any of
  `function_call`, `custom_tool_call`, `local_shell_call`, `computer_call`, `mcp_call`,
  `mcp_approval_request`; otherwise true (also true for an empty output). `text` = all
  `output_text` texts of `message` items joined with `\n`.
- `assessStop(turn, plan, finalText)`, first match wins:
  1. no steps and no plan -> 0 (`no work started`; a plain answer is never resumed)
  2. needs the user (`NEEDS_USER`: api key, password, credential, token, log in/sign in,
     which (one|option) do you, please (provide|confirm|clarify), 請提供、請確認、密碼、金鑰、登入、哪一個、哪個選項) -> 0.1
  3. plan has open steps -> 0.9 (`plan d/t done`)
  4. asks permission or promises more (`ASK_PERMISSION`: would you like me to, shall I,
     should I continue, do you want me to, want me to, let me know if, 要我…嗎, 需要我…嗎, 是否要, 是否繼續;
     `PROMISE`: next,? I('ll| will), I will now, remaining (steps|work|tasks), still need to,
     not yet (done|implemented|finished), TODO, 接下來, 下一步, 還需要, 尚未完成, 待完成, 剩下的) -> 0.75
  5. the last step failed -> 0.5 (`ended on a failing step`; below the default threshold on purpose)
  6. else 0.1 (`looks done`)
- `nudgeText(plan)`: English, starts with `[jev]`, says `d of t plan steps done`, lists up to 5
  open steps, tells the agent to keep working through every remaining step and verify the
  result before ending its turn, and not to stop to summarize or ask whether to continue
  unless it truly needs something only the user can provide. Under 900 chars.
- `continueText(plan, reasons)`: `[jev]` line: "You ended your turn but the task is not
  finished (<reasons>)." + open steps when there is a plan + "Continue now: do the remaining
  work with your tools, then verify. Only stop to ask if you need information only the user has."
- Tests cover every rule above, both languages, Responses and Chat plans, and jevStopCheck
  with a local `http.createServer` (see `test/decisions.test.js`).

## Owner B — `src/splice.js`, `src/proxy.js`, `src/log.js`, tests `test/splice.test.js`, `test/continue.test.js`

- `createSseFramer()`: buffers text, splits on `\n\n` (also tolerate `\r\n\r\n`), keeps `raw`
  exactly as received. `type` from `event:` line, else `data.type`. Multiple `data:` lines join with `\n`.
  `flush()` returns a trailing partial block (if non-empty) as an event.
- `replayItems(output)`: `message` -> `{type, role, content}`; `reasoning` -> `{type, summary,
  encrypted_content}` (+ `content` when present; skip the item when it has neither
  `encrypted_content` nor non-empty `summary`); other types copied without `id`/`status`.
- `continuationBody(sentBody, output, text, effort)`: `{...sentBody, input:[...sentBody.input,
  ...replayItems(output), developerMessage(text)], reasoning:{...sentBody.reasoning, effort}}`.
- `pipeWithContinuation(res, upstream, {onEvent, onCompleted})`: write the upstream status and
  headers like `pipeUpstream` in proxy.js (reuse/move its header logic; respect backpressure
  as it does). For each event: call `onEvent(data)` when `data` is an object; write `raw`
  except for `response.completed`. On `response.completed`: `next = await onCompleted(data, round)`.
  null -> write the held raw, end. A Response with `ok` and an SSE body -> continue with it
  (round+1), dropping its `response.created`/`response.in_progress`. Not ok / throws -> write
  the held raw, end (cancel the failed body). Stop cleanly when the client disconnects (`res.destroyed`).
  Upstream events after a held completed (should not happen) are forwarded in order.
- `src/proxy.js` integration (Responses + Chat), using `turnPlan`, `finalOutput`, `assessStop`,
  `nudgeText`, `continueText` from longtask.js and `jevStopCheck` from decisions.js:
  - nudge as described in Goal 1, only when a decision exists (the request is routed).
  - stop check: `config.mode === 'jev'` -> `jevStopCheck` (opts from config: `decisionUrl`,
    `openrouterKey`, `decisionModel`, `judgeTimeoutMs`, session), falling back to `assessStop`
    on any error (record the source like the router does: `jev` / `heuristic (jev failed: …)`);
    other modes -> `assessStop`. Allow injecting `deps.stopCheckFn` (same signature as
    jevStopCheck) for tests. Never resume when `config.mode === 'off'`.
  - continuation fetch: same url and forwarded headers as the original, same abort signal,
    `content-type: application/json`, body `continuationBody(lastSentBody, data.response.output,
    continueText(plan, reasons), clampEffort(effort))`; chained rounds build on the last body sent.
  - print one line per resume via a new `formatContinue(c)` in log.js:
    `Jev  RESUME #n → HIGH  ✓ APPLIED` / dim line `Step s · unfinished 0.82 · <source> · <reasons>`.
  - the decision log record gains `continues: [{n, effort, unfinished, source, reasons}]` (only
    when non-empty) and `nudged: true` when a reminder was appended; usage stays the last
    response's. `/jev/health` stats gains `continued` (count of resumes) and `nudged`.
  - non-stream requests, Chat Completions and error statuses keep the plain `pipeUpstream` path.
- Tests (local upstream servers only): framer edge cases (split chunks, CRLF, multi data lines,
  partial tail); replay/continuation body immutability; end-to-end through `createProxy`:
  a turn with a tool step whose upstream answers "Next I will add tests." is resumed once and the
  client stream contains the first message, NOT the first `response.completed`, then the second
  response's events (no second `response.created`) and its `response.completed`; the continuation
  request carries the replayed message without `id`, the developer `[jev]` message and a higher
  effort; cap `JEV_MAX_CONTINUES` honoured across chained rounds; no resume when the generation
  ends with a function_call, when stream is false, when `JEV_CONTINUE=off`, when there are no steps
  and no plan, or when the stop check is below threshold; failed continuation (HTTP 500) releases
  the held event; jev stop-check failure falls back to the heuristic; nudge appended (Responses
  developer item at the end, Chat system message at the end) only while the plan has open steps
  and absent with `JEV_NUDGE=off`.

## Hard rules

- Touch only the files you own (plus the new test files named for you). `README.md`,
  `package.json`, `bin/jev.js`, `src/router.js`, `src/config.js`, this brief: lead only.
  If you need a change there, say so in your report.
- No `git add/commit/stash/checkout/reset`. No new dependencies. No network calls in tests.
- Servers in tests listen on port 0 and are closed. Do not read credentials or `~/.codex`.
- If the other owner's file is still a stub, inject or stub what you need in your tests;
  the lead runs the full suite after both are done.

## Report (final message)

Files changed, public functions, number of tests you added and the `node --test` result,
anything unverified, open questions or contract changes you needed.
