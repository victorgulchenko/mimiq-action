import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient, createSseParser, McpError, PROTOCOL_VERSION, ToolError, toolData } from '../src/mcp.js';
import { KEY, startMockMcp } from './helpers/mock-mcp.js';

const collect = () => {
  const events = [];
  return { events, parser: createSseParser((e) => events.push(e)) };
};

test('SSE parser: comments are skipped, events dispatch on a blank line', () => {
  const { events, parser } = collect();
  parser.push(': ping\n\nevent: message\ndata: {"a":1}\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '{"a":1}' }]);
});

test('SSE parser: CRLF split across chunks, multi-line data, default event name', () => {
  const { events, parser } = collect();
  for (const chunk of ['data: line one\r', '\ndata: line two\r', '\n\r', '\n', 'data:x\r\r', 'data: y\n\n']) parser.push(chunk);
  assert.deepEqual(events, [
    { event: 'message', data: 'line one\nline two' },
    { event: 'message', data: 'x' },
    { event: 'message', data: 'y' },
  ]);
});

test('SSE parser: a final event without a trailing blank line dispatches on end()', () => {
  const { events, parser } = collect();
  parser.push('event: message\ndata: {"b":2}');
  assert.equal(events.length, 0);
  parser.end();
  assert.deepEqual(events, [{ event: 'message', data: '{"b":2}' }]);
});

test('handshake: initialize, then notifications/initialized, then tools/call, carrying the session and auth', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.show_report': () => ({ data: { ok: true } }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'mimiq');
  const data = await client.callTool('mimiq.show_report', { session_id: 'abc' });
  assert.deepEqual(data, { ok: true });

  const [first, second, third] = mock.state.requests;
  assert.equal(mock.state.requests.length, 3);
  assert.equal(first.body.method, 'initialize');
  assert.equal(first.body.params.protocolVersion, PROTOCOL_VERSION);
  assert.equal(typeof first.body.id, 'number');
  assert.equal(first.headers['mcp-session-id'], undefined, 'no session before the server hands one out');

  assert.equal(second.body.method, 'notifications/initialized');
  assert.equal('id' in second.body, false, 'a notification has no id');
  assert.equal(third.body.method, 'tools/call');
  assert.deepEqual(third.body.params, { name: 'mimiq.show_report', arguments: { session_id: 'abc' } });

  for (const r of [first, second, third]) {
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.match(r.headers.accept, /application\/json/);
    assert.match(r.headers.accept, /text\/event-stream/);
    assert.equal(r.headers['content-type'], 'application/json');
  }
  for (const r of [second, third]) {
    assert.equal(r.headers['mcp-session-id'], 'mock-session-1');
    assert.equal(r.headers['mcp-protocol-version'], PROTOCOL_VERSION);
  }
  assert.equal(client.sessionId, 'mock-session-1');
});

test('handshake: a 202 to notifications/initialized and no session header both work', async (t) => {
  const mock = await startMockMcp({ sessionId: null, initializedStatus: 202, tools: { 'mimiq.show_report': () => ({ data: { ok: 1 } }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  assert.deepEqual(await client.callTool('mimiq.show_report', { session_id: 'a' }), { ok: 1 });
  assert.equal(client.sessionId, null);
  assert.equal(mock.state.requests[2].headers['mcp-session-id'], undefined);
});

test('tools/call: plain JSON reply', async (t) => {
  const mock = await startMockMcp({ transport: 'json', tools: { 'mimiq.test_page': (args) => ({ data: { echoed: args.url } }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  assert.deepEqual(await client.callTool('mimiq.test_page', { url: 'https://a.example' }), { echoed: 'https://a.example' });
});

test('tools/call: SSE reply with pings, a server notification first, CRLF and tiny chunks', async (t) => {
  const mock = await startMockMcp({ crlf: true, chunked: true, tools: { 'mimiq.test_page': () => ({ data: { status: 'still_running', review_id: 'x' } }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  assert.deepEqual(await client.callTool('mimiq.test_page', { url: 'https://a.example' }), { status: 'still_running', review_id: 'x' });
});

test('tools/call: reads the JSON text block when structuredContent is absent', async (t) => {
  const mock = await startMockMcp({ noStructured: true, tools: { 'mimiq.show_report': () => ({ data: { n: 5 }, text: 'Plain summary' }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  assert.deepEqual(await client.callTool('mimiq.show_report', { session_id: 'a' }), { n: 5 });
  assert.throws(() => toolData({ content: [{ type: 'text', text: 'not json' }] }), McpError);
});

test('tools/call: an isError result throws ToolError with the code and message', async (t) => {
  const mock = await startMockMcp({ tools: { 'mimiq.test_page': () => ({ error: { code: 'INSUFFICIENT_CREDITS', reason: 'out_of_credits', message: 'This account is out of people credits.' } }) } });
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  await assert.rejects(client.callTool('mimiq.test_page', { url: 'https://a.example' }), (e) => {
    assert.ok(e instanceof ToolError);
    assert.equal(e.code, 'INSUFFICIENT_CREDITS');
    assert.equal(e.reason, 'out_of_credits');
    assert.equal(e.message, 'This account is out of people credits.');
    return true;
  });
});

test('a JSON-RPC error and an HTTP 401 surface as McpError', async (t) => {
  const mock = await startMockMcp({});
  t.after(mock.close);
  const client = createMcpClient({ url: mock.url, apiKey: KEY });
  await client.initialize();
  await assert.rejects(client.callTool('mimiq.nope', {}), (e) => e instanceof McpError && e.code === -32601);

  const denied = await startMockMcp({ httpStatus: 401 });
  t.after(denied.close);
  await assert.rejects(createMcpClient({ url: denied.url, apiKey: KEY }).initialize(), (e) => e instanceof McpError && e.code === 'UNAUTHORIZED');
});
