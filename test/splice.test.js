import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSseFramer, replayItems, continuationBody, pipeWithContinuation } from '../src/splice.js';

const enc = new TextEncoder();
const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const created = (id) => ev('response.created', { response: { id } });
const delta = (text) => ev('response.output_text.delta', { delta: text });
const completed = (id, output = []) => ev('response.completed', { response: { id, output } });

function feed(chunks) {
  const framer = createSseFramer();
  const events = chunks.flatMap((c) => framer.push(c));
  return [...events, ...framer.flush()];
}

test('framer emits whole events and keeps the raw text exactly', () => {
  const text = `${created('r1')}${delta('hi')}`;
  const events = feed([text]);
  assert.equal(events.map((e) => e.raw).join(''), text);
  assert.deepEqual(events.map((e) => e.type), ['response.created', 'response.output_text.delta']);
  assert.equal(events[1].data.delta, 'hi');
});

test('framer emits nothing until the blank line arrives, even byte by byte', () => {
  const text = 'data: {"type":"a","t":"中文"}\n\ndata: {"type":"b"}\n\n';
  const bytes = enc.encode(text);
  const firstBlockEnd = enc.encode('data: {"type":"a","t":"中文"}\n\n').length;
  const framer = createSseFramer();
  const emittedAt = [];
  const events = [];
  for (let i = 0; i < bytes.length; i++) {
    const got = framer.push(bytes.slice(i, i + 1));
    if (got.length) emittedAt.push(i + 1);
    events.push(...got);
  }
  events.push(...framer.flush());
  assert.deepEqual(emittedAt, [firstBlockEnd, bytes.length], 'an event is emitted only once its blank line is complete');
  assert.equal(events[0].data.t, '中文', 'a multi-byte character split across chunks decodes intact');
  assert.equal(events.map((e) => e.raw).join(''), text);
});

test('framer accepts CRLF blank lines and CRLF split across chunks', () => {
  const text = 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\ndata: {"type":"x"}\n\r\n';
  const events = feed([text]);
  assert.equal(events.length, 2);
  assert.equal(events.map((e) => e.raw).join(''), text);
  assert.deepEqual(events.map((e) => e.type), ['response.completed', 'x']);
  assert.equal(feed(['data: {"type":"a"}\r', '\n\r', '\n']).length, 1);
});

test('framer joins multi-line data, prefers the event line, and tolerates comments and bad JSON', () => {
  const events = feed([
    ': keep-alive\n\n',
    'data: {"type":"response.output_text.delta",\ndata: "delta":"a"}\n\n',
    'event: oops\ndata: {not json\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.deepEqual(events.map((e) => [e.type, e.data]), [
    [null, null],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'a' }],
    ['oops', null],
    [null, null],
  ]);
});

test('framer flush returns a trailing partial block once, and nothing when empty', () => {
  const framer = createSseFramer();
  assert.deepEqual(framer.push('data: {"type":"response.completed"}'), []);
  const tail = framer.flush();
  assert.deepEqual(tail, [{
    raw: 'data: {"type":"response.completed"}', type: 'response.completed', data: { type: 'response.completed' },
  }]);
  assert.deepEqual(framer.flush(), []);
});

test('replayItems drops ids and statuses and keeps what the next request needs', () => {
  const output = [
    { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'enc', status: 'completed' },
    { id: 'rs_2', type: 'reasoning', summary: [] },
    { id: 'rs_3', type: 'reasoning', summary: [], encrypted_content: 'enc3', content: [{ type: 'reasoning_text', text: 't' }] },
    { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final', content: [{ type: 'output_text', text: 'Next I will test.', annotations: [] }] },
    { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}', status: 'completed' },
    { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search' } },
    null,
  ];
  assert.deepEqual(replayItems(output), [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'enc' },
    { type: 'reasoning', summary: [], encrypted_content: 'enc3', content: [{ type: 'reasoning_text', text: 't' }] },
    { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Next I will test.', annotations: [] }] },
    { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
    { type: 'web_search_call', action: { type: 'search' } },
  ]);
  assert.deepEqual(replayItems(undefined), []);
  assert.deepEqual(replayItems('text'), []);
});

test('replayItems and continuationBody never mutate their inputs', () => {
  const output = [
    { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [] },
    { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }] },
  ];
  const sent = {
    model: 'gpt-6.1-terra', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix' }] }],
    reasoning: { effort: 'medium', summary: 'auto' }, stream: true,
  };
  const outputCopy = structuredClone(output);
  const sentCopy = structuredClone(sent);
  replayItems(output);
  continuationBody(sent, output, 'go on', 'high');
  assert.deepEqual(output, outputCopy);
  assert.deepEqual(sent, sentCopy);
});

test('continuationBody appends the replayed output and a developer message, and raises the effort', () => {
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] };
  const call = { type: 'function_call', id: 'fc_9', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}', status: 'completed' };
  const result = { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 0' };
  const sent = {
    model: 'gpt-6.1-terra', instructions: 'SYSTEM', input: [user, call, result],
    reasoning: { effort: 'medium', summary: 'auto' }, stream: true, prompt_cache_key: 'sess-1',
  };
  const output = [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Next I will test.', annotations: [] }] }];

  const body = continuationBody(sent, output, 'Continue now.', 'high');

  assert.deepEqual(body.input.slice(0, 3), sent.input, 'the prior input is kept in order');
  assert.deepEqual(body.input.slice(3), [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Next I will test.', annotations: [] }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Continue now.' }] },
  ]);
  assert.equal('id' in body.input[3], false);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual({ ...body, input: null, reasoning: null }, { ...sent, input: null, reasoning: null });
});

test('continuationBody copes with a string input and leaves out reasoning when the sent body had none', () => {
  const body = continuationBody({ model: 'm', input: 'hello' }, [], 'go on', 'high');
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'go on' }] },
  ]);
  assert.equal('reasoning' in body, false, 'no reasoning object is invented');
});

test('continuationBody keeps the sent reasoning object and raises only its effort', () => {
  const sent = { model: 'm', input: [], reasoning: { effort: 'low', summary: 'auto' } };
  assert.deepEqual(continuationBody(sent, [], 'go on', 'xhigh').reasoning, { effort: 'xhigh', summary: 'auto' });
  assert.deepEqual(sent.reasoning, { effort: 'low', summary: 'auto' }, 'the sent body is not mutated');
});

test('replayMessage keeps phase only when the message has one', () => {
  const plain = { id: 'msg_1', type: 'message', role: 'assistant', content: [] };
  assert.deepEqual(replayItems([plain]), [{ type: 'message', role: 'assistant', content: [] }]);
});

function sseResponse(chunks, { status = 200, contentType = 'text/event-stream', onCancel } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

// Runs the pipe behind a real loopback server and returns what the client received.
async function runPipe(upstream, hooks) {
  const errors = [];
  const server = http.createServer((req, res) => {
    pipeWithContinuation(res, upstream, hooks).catch((err) => {
      errors.push(err);
      res.destroy();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: res.status, text: await res.text(), errors };
  } finally {
    server.close();
  }
}

test('without a continuation the stream passes through byte for byte', async () => {
  const first = [created('r1'), delta('Done.'), completed('r1')];
  const asked = [];
  const out = await runPipe(sseResponse(first), {
    onCompleted(data, round) {
      asked.push([round, data.response.id]);
      return null;
    },
  });
  assert.equal(out.status, 200);
  assert.equal(out.text, first.join(''));
  assert.deepEqual(asked, [[0, 'r1']]);
});

test('a stream that ends without response.completed never asks for a continuation', async () => {
  let asked = false;
  const out = await runPipe(sseResponse([created('r1'), delta('partial')]), {
    onCompleted() {
      asked = true;
      return null;
    },
  });
  assert.equal(out.text, created('r1') + delta('partial'));
  assert.equal(asked, false);
});

test('the held completed event is replaced by the continuation stream, without its created event', async () => {
  const first = [created('r1'), delta('Next I will add tests.'), completed('r1')];
  const second = [created('r2'), ev('response.in_progress', { response: { id: 'r2' } }), delta('Added.'), completed('r2')];
  const asked = [];
  const out = await runPipe(sseResponse(first), {
    onCompleted(data, round) {
      asked.push([round, data.response.id]);
      return round === 0 ? sseResponse(second) : null;
    },
  });
  // The continuation's completed event goes out with the first id (its output is empty here).
  assert.equal(out.text, [first[0], first[1], second[2], completed('r1')].join(''));
  assert.deepEqual(asked, [[0, 'r1'], [1, 'r2']], 'the continuation completion is asked too, and released');
});

test('continuations chain: each round is asked in turn and the rounds are counted', async () => {
  const rounds = [];
  const out = await runPipe(sseResponse([created('r1'), delta('a'), completed('r1')]), {
    onCompleted(data, round) {
      rounds.push([round, data.response.id]);
      if (round === 0) return sseResponse([created('r2'), delta('b'), completed('r2')]);
      if (round === 1) return sseResponse([created('r3'), delta('c'), completed('r3')]);
      return null;
    },
  });
  assert.deepEqual(rounds, [[0, 'r1'], [1, 'r2'], [2, 'r3']]);
  assert.equal(out.text, created('r1') + delta('a') + delta('b') + delta('c') + completed('r1'));
});

test('onEvent sees every parsed event of every round, including the dropped ones', async () => {
  const seen = [];
  await runPipe(sseResponse([created('r1'), completed('r1')]), {
    onEvent: (data) => seen.push(data.type),
    onCompleted: (data, round) => (round === 0 ? sseResponse([created('r2'), delta('x'), completed('r2')]) : null),
  });
  assert.deepEqual(seen, ['response.created', 'response.completed', 'response.created', 'response.output_text.delta', 'response.completed']);
});

test('a failed continuation (HTTP 500) releases the held event and cancels its body', async () => {
  let cancelled = false;
  const first = [created('r1'), delta('Next I will add tests.'), completed('r1')];
  const out = await runPipe(sseResponse(first), {
    onCompleted: () => sseResponse(['boom'], { status: 500, contentType: 'text/plain', onCancel: () => { cancelled = true; } }),
  });
  assert.equal(out.text, first.join(''));
  assert.equal(cancelled, true);
});

test('a continuation that is not an event stream releases the held event', async () => {
  const first = [created('r1'), completed('r1')];
  const out = await runPipe(sseResponse(first), {
    onCompleted: () => sseResponse(['{}'], { contentType: 'application/json' }),
  });
  assert.equal(out.text, first.join(''));
});

test('a throwing onCompleted releases the held event and reports the error', async () => {
  const first = [created('r1'), completed('r1')];
  const reported = [];
  const out = await runPipe(sseResponse(first), {
    onCompleted: () => {
      throw new Error('boom');
    },
    onError: (err) => reported.push(err.message),
  });
  assert.equal(out.text, first.join(''));
  assert.deepEqual(reported, ['boom']);
});

const message = (id, text) => ({
  id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }],
});

test('streamed output items stand in for a completed output that is empty or missing', async () => {
  const item = message('msg_a', 'A');
  for (const completed of [ev('response.completed', { response: { id: 'r1', output: [] } }), ev('response.completed', { response: { id: 'r1' } })]) {
    const first = [created('r1'), ev('response.output_item.done', { item }), completed];
    const asked = [];
    const out = await runPipe(sseResponse(first), {
      onCompleted(data) {
        asked.push(data.response.output);
        return null;
      },
    });
    assert.equal(out.text, first.join(''), 'released as it came, since no continuation was given');
    assert.deepEqual(asked, [[item]], 'the decision sees the streamed item as the output');
  }
});

test('a completed output that disagrees with the streamed items is released without asking', async () => {
  const a = message('msg_a', 'A');
  const b = message('msg_b', 'B');
  const first = [
    created('r1'),
    ev('response.output_item.done', { item: a }),
    ev('response.output_item.done', { item: b }),
    ev('response.completed', { response: { id: 'r1', output: [a] } }),
  ];
  let asked = false;
  const out = await runPipe(sseResponse(first), {
    onCompleted() {
      asked = true;
      return null;
    },
  });
  assert.equal(out.text, first.join(''));
  assert.equal(asked, false);
});

test('a continuation renumbers sequence_number and output_index and gives the terminal event the whole response', async () => {
  const seq = (type, n, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n, ...data })}\n\n`;
  const itemA = message('msg_a', 'A');
  const itemB = message('msg_b', 'B');
  const first = [
    seq('response.created', 0, { response: { id: 'r1' } }),
    seq('response.output_item.done', 1, { output_index: 0, item: itemA }),
    seq('response.completed', 2, { response: { id: 'r1', output: [itemA] } }),
  ];
  const second = [
    seq('response.created', 0, { response: { id: 'r2' } }),
    ': ping\n\n',
    'event: response.output_item.done\ndata: not json\n\n',
    seq('response.output_item.done', 1, { output_index: 0, item: itemB }),
    seq('response.output_text.delta', 2, { output_index: 0, delta: 'B' }),
    seq('response.completed', 3, { response: { id: 'r2', output: [itemB] } }),
  ];
  const out = await runPipe(sseResponse(first), {
    onCompleted: (data, round) => (round === 0 ? sseResponse(second) : null),
  });
  assert.equal(out.text, [
    first[0],
    first[1],
    ': ping\n\n',
    'event: response.output_item.done\ndata: not json\n\n',
    seq('response.output_item.done', 2, { output_index: 1, item: itemB }),
    seq('response.output_text.delta', 3, { output_index: 1, delta: 'B' }),
    seq('response.completed', 4, { response: { id: 'r1', output: [itemA, itemB] } }),
  ].join(''));
});

test('a continuation that fails mid-stream still ends the client stream with exactly one completed event', async () => {
  const first = [created('r1'), delta('Next I will add tests.'), completed('r1')];
  const broken = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(created('r2') + delta('Added.')));
    },
    pull(controller) {
      controller.error(new Error('socket hang up'));
    },
  });
  const reported = [];
  const out = await runPipe(sseResponse(first), {
    onCompleted: (data, round) => (round === 0 ? new Response(broken, { headers: { 'content-type': 'text/event-stream' } }) : null),
    onError: (err) => reported.push(err.message),
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.errors, [], 'the error does not destroy the response');
  assert.deepEqual(reported, ['socket hang up']);
  assert.equal(out.text, created('r1') + delta('Next I will add tests.') + delta('Added.') + completed('r1'));
});

test('a continuation that ends without a terminal event closes with the replaced completed event, renumbered and with its items', async () => {
  const seq = (type, n, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n, ...data })}\n\n`;
  const item = message('msg_b', 'B');
  const first = [seq('response.created', 0, { response: { id: 'r1' } }), seq('response.completed', 1, { response: { id: 'r1', output: [] } })];
  const second = [seq('response.created', 0, { response: { id: 'r2' } }), seq('response.output_item.done', 0, { output_index: 0, item })];
  const out = await runPipe(sseResponse(first), {
    onCompleted: (data, round) => (round === 0 ? sseResponse(second) : null),
  });
  assert.equal(out.text, [
    first[0],
    seq('response.output_item.done', 1, { output_index: 0, item }),
    seq('response.completed', 2, { response: { id: 'r1', output: [item] } }),
  ].join(''));
});

test('events after a released completed event are forwarded in order', async () => {
  const tail = [completed('r1'), delta('after'), ev('response.metadata', { note: 1 })];
  const out = await runPipe(sseResponse([tail.join('').slice(0, 20), tail.join('').slice(20)]), {
    onCompleted: () => null,
  });
  assert.equal(out.text, tail.join(''));
});

test('a client that disconnects stops the stream and never asks for a continuation', async () => {
  let pulls = 0;
  let cancelled = false;
  let asked = false;
  const endless = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 2));
      pulls++;
      controller.enqueue(enc.encode(delta('x')));
      if (pulls >= 2000) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const upstream = new Response(endless, { headers: { 'content-type': 'text/event-stream' } });
  let finished;
  const server = http.createServer((req, res) => {
    finished = pipeWithContinuation(res, upstream, {
      onCompleted: () => {
        asked = true;
        return null;
      },
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: abort.signal });
    const reader = res.body.getReader();
    await reader.read();
    abort.abort();
    await finished;
    assert.equal(cancelled, true);
    assert.equal(asked, false);
    assert.ok(pulls < 2000, 'the upstream was not drained after the client left');
  } finally {
    server.close();
  }
});
