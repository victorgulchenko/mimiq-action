/**
 * A local stand-in for Mimiq's hosted MCP server (mcp-hosted/src/server.js),
 * matching its transport behavior:
 *   - initialize and notifications/initialized answer with plain JSON (server.js:1343)
 *     and an Mcp-Session-Id header (echoed from the request, or minted: server.js:1298);
 *   - tools/call answers as an SSE stream with ": ping" comments and one
 *     "event: message" carrying the JSON-RPC reply (server.js:1318-1339);
 *   - tool failures are results with isError and a JSON {code, message} block (server.js:937-951).
 */
import http from 'node:http';

const tick = () => new Promise((resolve) => setImmediate(resolve));

export const KEY = 'mq_sk_test_9f8e7d6c5b4a';

export function persona(name, action, actionClass, objections = []) {
  return { persona_id: name.toLowerCase(), name, action, action_class: actionClass, objections, monologue: `${name} thinking.` };
}

/** A finished mimiq.test_page result in the shape of mcp-envelope.js buildMcpEnvelope. */
export function finishedEnvelope({ personas, sessionId = 'sess_abc123', reportUrl = `https://www.mimiqai.com/app/t/${sessionId}` } = {}) {
  return {
    tool: 'mimiq.test_page',
    sample_size: personas.length,
    counts: { converted: 0, engaged: 0, bounced: 0 },
    personas,
    run: { simulation_ids: ['sim_1'], mode: 'visual_journey', duration_seconds: 120, extraction_errors: 0 },
    notes: [],
    summary_card: 'preview: simulated people',
    report_url: reportUrl,
    results_url: reportUrl,
    audience: { summary: 'Founders at seed-stage startups.', examples: [], fit: { fit_rate: 0.9, warning: null } },
    review_id: sessionId,
  };
}

/** pending-run.js pendingRun plus the page-test audience fields (server.js:711-716). */
export function stillRunning({ sessionId = 'sess_abc123', reportUrl = `https://www.mimiqai.com/app/t/${sessionId}` } = {}) {
  return {
    status: 'still_running',
    simulation_id: 'sim_1',
    report_url: reportUrl,
    message: `The test is still running and will be saved when it finishes. Show the report again in a minute, or open ${reportUrl} to follow it.`,
    review_id: sessionId,
    audience: { summary: 'Founders at seed-stage startups.', examples: [], fit: { fit_rate: 0.9 } },
  };
}

/** report-widget.js runningReport. */
export function runningReport({ sessionId = 'sess_abc123', done = 3, total = 10 } = {}) {
  return {
    title: 'preview.example.com', kind: 'page', status: 'running', progress: { done, total },
    headline: 'Still running', reason: `${done} of ${total} simulated people have reacted so far.`, versions: [],
    report_url: `https://www.mimiqai.com/app/t/${sessionId}`, limitation: 'Simulated people. Reading a report never uses credits.',
  };
}

/** report-widget.js renderReport, finished single test. */
export function finishedReport({ sessionId = 'sess_abc123', total = 10, stayed = 6, left = 4, objections } = {}) {
  return {
    title: 'preview.example.com', kind: 'page', status: 'finished',
    headline: `7 of ${total} understood it. 5 felt it was for them.`, reason: '',
    versions: [{
      label: 'Your test', title: 'preview.example.com',
      counts: { total, stayed, left, rated: total, understood: 7, for_them: 5 },
      objections: objections || [
        { quote: 'I cannot tell what it costs.', person: 'Maya', count: 3 },
        { quote: 'Who is behind this?', person: 'Sam', count: 1 },
      ],
    }],
    report_url: `https://www.mimiqai.com/app/t/${sessionId}`,
    limitation: 'Simulated people. Use this as a first read before a larger test.',
  };
}

function sendJson(res, status, body, sessionId) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });
  res.end(payload);
}

/**
 * options.tools: { [toolName]: (args, { call }) => ({ data, text? } | { error: {code, message} } | { rpcError }) }
 * options.transport: 'sse' (default, as server.js) or 'json'
 * options.crlf / options.chunked: stress the SSE parser
 * options.sessionId: header to hand out; null hands out none
 */
export async function startMockMcp(options = {}) {
  const opts = { transport: 'sse', sessionId: 'mock-session-1', tools: {}, initializedStatus: 200, ...options };
  const state = { requests: [], toolCalls: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* recorded as null */
    }
    state.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (opts.httpStatus) {
      res.writeHead(opts.httpStatus, { 'content-type': 'text/plain' });
      res.end(opts.httpBody || '');
      return;
    }
    const sid = req.headers['mcp-session-id'] || opts.sessionId || undefined;

    if (body?.method === 'initialize') {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params?.protocolVersion || '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'mimiq', version: 'mock' }, instructions: 'mock' } }, sid);
      return;
    }
    if (body?.method === 'notifications/initialized') {
      if (opts.initializedStatus === 202) {
        res.writeHead(202, sid ? { 'mcp-session-id': sid } : {});
        res.end();
      } else {
        sendJson(res, 200, { jsonrpc: '2.0', id: null, result: {} }, sid);
      }
      return;
    }
    if (body?.method === 'tools/call') {
      const { name, arguments: args } = body.params || {};
      state.toolCalls.push({ name, args, headers: req.headers });
      const call = state.toolCalls.filter((c) => c.name === name).length;
      const handler = opts.tools[name];
      const out = handler ? await handler(args, { call, headers: req.headers }) : { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
      let message;
      if (out.rpcError) message = { jsonrpc: '2.0', id: body.id, error: out.rpcError };
      else if (out.error) message = { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ...out.error, request_id: 'req-mock' }) }, ...(out.error.text ? [{ type: 'text', text: out.error.text }] : [])] } };
      else {
        const result = { content: [{ type: 'text', text: JSON.stringify(out.data) }, ...(out.text ? [{ type: 'text', text: out.text }] : [])] };
        if (!opts.noStructured) result.structuredContent = out.data;
        message = { jsonrpc: '2.0', id: body.id, result };
      }
      const transport = out.transport || opts.transport;
      if (transport === 'json') {
        sendJson(res, 200, message, sid);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...(sid ? { 'mcp-session-id': sid } : {}) });
      const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
      let payload = `: ping\n\nevent: message\ndata: ${JSON.stringify(progress)}\n\n: ping\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
      if (opts.crlf) payload = payload.replace(/\n/g, '\r\n');
      if (opts.chunked) {
        for (let i = 0; i < payload.length; i += 5) {
          res.write(payload.slice(i, i + 5));
          await tick();
        }
      } else {
        res.write(payload);
      }
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: `Method not found: ${body?.method}` } }, sid);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
