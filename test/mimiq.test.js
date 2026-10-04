import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient, McpError, ToolError } from '../src/mcp.js';
import { fromTestPage, MAX_PEOPLE, pageOutcome, runPageTest, sessionIdFromUrl, topDoubts, verdictFor } from '../src/mimiq.js';
import { finishedEnvelope, finishedReport, KEY, persona, runningReport, startMockMcp, stillRunning } from './helpers/mock-mcp.js';

/** A clock that only moves when the code sleeps, so polling tests run instantly. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms) => { t += ms; } };
}

const crowd = [
  persona('Maya Chen', 'converted', 'converted', ['I cannot tell what it costs.']),
  persona('Sam Ortiz', 'clicked_cta', 'converted', []),
  persona('Ana Ruiz', 'read', 'engaged', ['I cannot tell what it costs.']),
  persona('Joe Park', 'skimmed', 'bounced', ['Too much jargon up top.']),
  persona('Lee Wong', 'left', 'bounced', ['Who is behind this?', 'I cannot tell what it costs.']),
  persona('Kim Ito', 'error', 'engaged', ['should be ignored']),
];

test('pageOutcome follows the app rules, with the backend bucket as fallback', () => {
  assert.equal(pageOutcome('converted', 'converted'), 'converted');
  assert.equal(pageOutcome('signup'), 'converted');
  assert.equal(pageOutcome('clicked_cta', 'converted'), 'stayed');
  assert.equal(pageOutcome('read', 'engaged'), 'stayed');
  assert.equal(pageOutcome('saved'), 'stayed');
  assert.equal(pageOutcome('explored'), 'stayed');
  assert.equal(pageOutcome('skimmed', 'bounced'), 'skimmed');
  assert.equal(pageOutcome('Left', 'bounced'), 'left');
  assert.equal(pageOutcome('error'), null);
  assert.equal(pageOutcome('something_new', 'converted'), 'stayed');
  assert.equal(pageOutcome('something_new', 'bounced'), 'left');
  assert.equal(pageOutcome('something_new', 'engaged'), 'skimmed');
});

test('verdictFor uses the app page thresholds', () => {
  assert.equal(verdictFor(6, 10), 'Holds attention');
  assert.equal(verdictFor(4, 10), 'Mixed');
  assert.equal(verdictFor(2, 10), 'Loses most');
  assert.equal(verdictFor(1, 10), 'Losing them');
  assert.equal(verdictFor(0, 0), null);
});

test('fromTestPage counts stay, skim and leave, drops errored people, ranks doubts', () => {
  const r = fromTestPage(finishedEnvelope({ personas: crowd }));
  assert.equal(r.total, 5);
  assert.equal(r.stayed, 3);
  assert.equal(r.skimmed, 1);
  assert.equal(r.left, 1);
  assert.equal(r.reportUrl, 'https://www.mimiqai.com/app/t/sess_abc123');
  assert.equal(r.sessionId, 'sess_abc123');
  assert.deepEqual(r.doubts[0], { quote: 'I cannot tell what it costs.', person: 'Lee', count: 3 });
  assert.deepEqual(r.doubts.map((d) => d.quote), ['I cannot tell what it costs.', 'Who is behind this?', 'Too much jargon up top.']);
});

test('topDoubts counts a person once per quote and keeps at most three', () => {
  const doubts = topDoubts([
    { first: 'A', outcome: 'left', objections: ['x', 'x', 'y', 'z', 'w'] },
    { first: 'B', outcome: 'stayed', objections: ['y'] },
  ]);
  assert.equal(doubts.length, 3);
  assert.deepEqual(doubts[0], { quote: 'y', person: 'A', count: 2 });
  assert.equal(doubts.find((d) => d.quote === 'x').count, 1);
});

test('sessionIdFromUrl reads /app/t/<id>', () => {
  assert.equal(sessionIdFromUrl('https://www.mimiqai.com/app/t/abc-123_X'), 'abc-123_X');
  assert.equal(sessionIdFromUrl('https://mimiqai.com/app/t/abc?x=1'), 'abc');
  assert.equal(sessionIdFromUrl('https://mimiqai.com/app/compare/a/b'), null);
});

test('finished on the first call: sends url, count, audience, goal and a bounded wait', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ data: finishedEnvelope({ personas: crowd }) }) } });
  t.after(mock.close);
  const clock = fakeClock();
  const out = await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', audience: 'seed-stage founders', goal: 'join the waitlist', people: 10, timeoutMs: 8 * 60_000, ...clock });
  assert.equal(out.state, 'finished');
  assert.equal(out.result.stayed, 3);
  assert.equal(mock.state.toolCalls.length, 1);
  assert.deepEqual(mock.state.toolCalls[0].args, { url: 'https://preview.example.com/', count: 10, timeout_seconds: 300, audience: 'seed-stage founders', goal: 'join the waitlist' });
});

test('people is capped at 25 even if a caller passes more, and audience and goal are omitted when empty', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ data: finishedEnvelope({ personas: crowd }) }) } });
  t.after(mock.close);
  await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', people: 400, ...fakeClock() });
  assert.equal(MAX_PEOPLE, 25);
  assert.equal(mock.state.toolCalls[0].args.count, 25);
  assert.equal('audience' in mock.state.toolCalls[0].args, false);
  assert.equal('goal' in mock.state.toolCalls[0].args, false);
});

test('pending, then finished: polls show_report with the saved session ID until it finishes', async (t) => {
  const mock = await startMockMcp({
    tools: {
      'mimiq.test_page': () => ({ data: stillRunning({ sessionId: 'sess_poll' }) }),
      'mimiq.show_report': (args, { call }) => {
        if (call === 1) return { error: { code: 'INVALID_INPUT', message: 'This report is not ready yet. Open the full report to follow its progress.' } };
        if (call <= 3) return { data: runningReport({ sessionId: args.session_id, done: call * 3 }) };
        return { data: finishedReport({ sessionId: args.session_id }) };
      },
    },
  });
  t.after(mock.close);
  const clock = fakeClock();
  const logs = [];
  const out = await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', pollIntervalMs: 15_000, timeoutMs: 8 * 60_000, log: (m) => logs.push(m), ...clock });
  assert.equal(out.state, 'finished');
  const reports = mock.state.toolCalls.filter((c) => c.name === 'mimiq.show_report');
  assert.equal(reports.length, 4);
  for (const r of reports) assert.deepEqual(r.args, { session_id: 'sess_poll' });
  // Every poll uses the same MCP session as the test.
  for (const r of mock.state.toolCalls) assert.equal(r.headers['mcp-session-id'], 'mock-session-1');
  assert.deepEqual(clock.sleeps, [15_000, 15_000, 15_000, 15_000]);
  assert.equal(out.result.total, 10);
  assert.equal(out.result.stayed, 6);
  assert.equal(out.result.left, 4);
  assert.equal(out.result.skimmed, null, 'show_report merges skimmed into left');
  assert.equal(out.result.headline, '7 of 10 understood it. 5 felt it was for them.');
  assert.deepEqual(out.result.doubts[0], { quote: 'I cannot tell what it costs.', person: 'Maya', count: 3 });
  assert.equal(out.result.reportUrl, 'https://www.mimiqai.com/app/t/sess_poll');
  assert.ok(logs.some((l) => /9 of 10 simulated people have reacted/.test(l)));
});

test('timeout: stops polling at the deadline and returns the report link', async (t) => {
  const mock = await startMockMcp({
    tools: {
      'mimiq.test_page': () => ({ data: stillRunning({ sessionId: 'sess_slow' }) }),
      'mimiq.show_report': (args) => ({ data: runningReport({ sessionId: args.session_id, done: 4 }) }),
    },
  });
  t.after(mock.close);
  const clock = fakeClock();
  const out = await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', pollIntervalMs: 60_000, timeoutMs: 5 * 60_000, ...clock });
  assert.equal(out.state, 'running');
  assert.equal(out.sessionId, 'sess_slow');
  assert.equal(out.reportUrl, 'https://www.mimiqai.com/app/t/sess_slow');
  assert.deepEqual(out.progress, { done: 4, total: 10 });
  const polls = mock.state.toolCalls.filter((c) => c.name === 'mimiq.show_report').length;
  assert.equal(polls, 5, 'five one-minute polls fit in five minutes, and no more');
  assert.ok(clock.now() - 1_000_000 <= 5 * 60_000);
  // The first call waits at most min(300 s, timeout) on the server.
  assert.equal(mock.state.toolCalls[0].args.timeout_seconds, 300);
});

test('a short timeout shortens the server-side wait (never below 30 s)', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ data: stillRunning() }), 'mimiq.show_report': () => ({ data: runningReport() }) } });
  t.after(mock.close);
  await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', timeoutMs: 60_000, pollIntervalMs: 15_000, ...fakeClock() });
  assert.equal(mock.state.toolCalls[0].args.timeout_seconds, 60);
});

test('a failed run while polling is not retried', async (t) => {
  const mock = await startMockMcp({
    tools: {
      'mimiq.test_page': () => ({ data: stillRunning() }),
      'mimiq.show_report': () => ({ error: { code: 'SIM_FAILED', message: 'This test did not finish, and a failed run is refunded.' } }),
    },
  });
  t.after(mock.close);
  await assert.rejects(
    runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', ...fakeClock() }),
    (e) => e instanceof ToolError && e.code === 'SIM_FAILED',
  );
  assert.equal(mock.state.toolCalls.filter((c) => c.name === 'mimiq.show_report').length, 1);
});

test('test_page errors are never retried (a retry could charge twice)', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ error: { code: 'RATE_LIMITED', message: 'Too many tool calls in the last minute.' } }) } });
  t.after(mock.close);
  await assert.rejects(runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', ...fakeClock() }), ToolError);
  assert.equal(mock.state.toolCalls.length, 1);
});

test('audience review: reported, never acknowledged on the user\'s behalf', async (t) => {
  const mock = await startMockMcp({
    tools: {
      'mimiq.test_page': () => ({ data: { status: 'audience_review', review_id: 'sess_rev', summary: 'Mostly students.', audience_fit: { fit_rate: 0.4, warning: 'Results may describe the wrong customers.' } } }),
    },
  });
  t.after(mock.close);
  const out = await runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', ...fakeClock() });
  assert.deepEqual(out, { state: 'audience_review', reviewId: 'sess_rev', summary: 'Mostly students.', fitRate: 0.4, warning: 'Results may describe the wrong customers.' });
  assert.equal(mock.state.toolCalls.length, 1);
  assert.equal(mock.state.toolCalls.some((c) => c.args.audience_fit_acknowledged), false);
});

test('an unreadable result is an error, not a silent pass', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ data: { something: 'else' } }) } });
  t.after(mock.close);
  await assert.rejects(runPageTest({ client: createMcpClient({ url: mock.url, apiKey: KEY }), url: 'https://preview.example.com/', ...fakeClock() }), McpError);
});
