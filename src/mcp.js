/**
 * A minimal MCP client over Streamable HTTP (JSON-RPC 2.0), enough to call
 * Mimiq's hosted server the way coding agents do:
 *
 *   1. POST initialize                    -> JSON reply, may carry Mcp-Session-Id
 *   2. POST notifications/initialized      -> no reply expected (202, or 200 with a body we ignore)
 *   3. POST tools/call                     -> JSON, or an SSE stream ending in the reply
 *
 * Every request after the server hands out a session ID carries it back in the
 * Mcp-Session-Id header, plus the negotiated MCP-Protocol-Version.
 */
import { VERSION } from './version.js';

export const DEFAULT_MCP_URL = 'https://mcp.mimiqai.com/mcp';
export const PROTOCOL_VERSION = '2025-06-18';

/** Transport or protocol failure: the server was unreachable, refused, or sent something unreadable. */
export class McpError extends Error {
  constructor(message, { code = 'MCP_ERROR', status = null, data = null } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** The tool ran and said no (isError: true): out of credits, bad key, bad URL, a failed run. */
export class ToolError extends Error {
  constructor(message, { code = 'TOOL_ERROR', reason = null, reportUrl = null, requestId = null } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.reason = reason;
    this.reportUrl = reportUrl;
    this.requestId = requestId;
  }
}

/**
 * Incremental parser for text/event-stream (the WHATWG rules that matter here):
 * lines end in \n, \r\n or \r; a blank line dispatches the event; lines starting
 * with ":" are comments (Mimiq's keep-alive pings); multi-line data joins with \n.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let data = [];
  let event = '';

  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
    data = [];
    event = '';
  };
  const handleLine = (text) => {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };

  return {
    push(chunk) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        // A trailing \r may be the first half of \r\n split across chunks: wait for more.
        if (ch === '\r' && i === buffer.length - 1) break;
        handleLine(buffer.slice(start, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) handleLine(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}

const isReplyTo = (message, id) => message && typeof message === 'object' && message.id === id && ('result' in message || 'error' in message);

async function readJsonReply(res, id) {
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpError('Mimiq sent a reply that is not JSON.', { code: 'BAD_RESPONSE', status: res.status });
  }
  const reply = Array.isArray(parsed) ? parsed.find((m) => isReplyTo(m, id)) : parsed;
  if (!isReplyTo(reply, id)) throw new McpError('Mimiq sent a JSON reply without an answer to this request.', { code: 'BAD_RESPONSE', status: res.status });
  return reply;
}

async function readSseReply(res, id) {
  if (!res.body) throw new McpError('Mimiq opened an event stream with no body.', { code: 'BAD_RESPONSE', status: res.status });
  let reply = null;
  const parser = createSseParser(({ event, data }) => {
    if (reply || event !== 'message') return;
    try {
      const message = JSON.parse(data);
      if (isReplyTo(message, id)) reply = message;
      // Server requests and notifications on the stream are not needed by this client.
    } catch {
      /* not JSON: ignore the event */
    }
  });
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    while (!reply) {
      const { value, done } = await reader.read();
      if (value) parser.push(decoder.decode(value, { stream: true }));
      if (done) {
        parser.push(decoder.decode());
        parser.end();
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!reply) throw new McpError('The event stream from Mimiq ended without an answer.', { code: 'BAD_RESPONSE', status: res.status });
  return reply;
}

async function drain(res) {
  try {
    await res.arrayBuffer();
  } catch {
    /* nothing to keep */
  }
}

/** The tool result's data: structuredContent, or the JSON in the first text block (older servers). */
export function toolData(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const item of result?.content || []) {
    if (item?.type !== 'text') continue;
    try {
      const value = JSON.parse(item.text);
      if (value && typeof value === 'object') return value;
    } catch {
      /* plain text block */
    }
  }
  throw new McpError('Mimiq returned a result this Action cannot read.', { code: 'BAD_RESPONSE' });
}

/** An isError result: Mimiq puts {code, message, reason?, report_url?} as JSON in the first text block. */
export function toolErrorFrom(result) {
  const texts = (result?.content || []).filter((c) => c?.type === 'text').map((c) => String(c.text || ''));
  for (const text of texts) {
    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === 'object' && (payload.message || payload.code)) {
        return new ToolError(String(payload.message || payload.code), {
          code: String(payload.code || 'TOOL_ERROR'),
          reason: payload.reason || null,
          reportUrl: payload.report_url || null,
          requestId: payload.request_id || null,
        });
      }
    } catch {
      /* plain text block */
    }
  }
  return new ToolError(texts.join('\n').trim() || 'Mimiq returned an error without a message.');
}

export function createMcpClient({ url = DEFAULT_MCP_URL, apiKey, fetchImpl = globalThis.fetch, clientName = 'mimiq-github-action' } = {}) {
  if (!apiKey) throw new McpError('An API key is required.', { code: 'UNAUTHORIZED' });
  let sessionId = null;
  let protocolVersion = null;
  let nextId = 1;

  const headers = () => {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
      'user-agent': `mimiq-github-action/${VERSION}`,
    };
    if (sessionId) h['mcp-session-id'] = sessionId;
    if (protocolVersion) h['mcp-protocol-version'] = protocolVersion;
    return h;
  };

  async function post(message, { timeoutMs, expectReply }) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new McpError(`Mimiq did not answer ${message.method} within ${Math.round(timeoutMs / 1000)} seconds.`, { code: 'TIMEOUT' });
      }
      throw new McpError(`Could not reach Mimiq: ${e?.cause?.code || e?.message || e}.`, { code: 'NETWORK' });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid && !sessionId) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      await drain(res);
      throw new McpError(`Mimiq did not accept the API key (HTTP ${res.status}).`, { code: 'UNAUTHORIZED', status: res.status });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new McpError(`Mimiq answered HTTP ${res.status} to ${message.method}${body ? `: ${body}` : ''}.`, { code: 'HTTP_ERROR', status: res.status });
    }
    if (!expectReply) {
      await drain(res);
      return null;
    }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    try {
      return type.includes('text/event-stream') ? await readSseReply(res, message.id) : await readJsonReply(res, message.id);
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new McpError(`Mimiq did not finish answering ${message.method} within ${Math.round(timeoutMs / 1000)} seconds.`, { code: 'TIMEOUT' });
      }
      throw e;
    }
  }

  async function request(method, params, { timeoutMs = 30_000 } = {}) {
    const id = nextId;
    nextId += 1;
    const reply = await post({ jsonrpc: '2.0', id, method, params }, { timeoutMs, expectReply: true });
    if (reply.error) {
      throw new McpError(`Mimiq returned an error for ${method}: ${reply.error.message || reply.error.code}.`, { code: reply.error.code, data: reply.error.data });
    }
    return reply.result;
  }

  async function notify(method, params, { timeoutMs = 30_000 } = {}) {
    const message = { jsonrpc: '2.0', method };
    if (params) message.params = params;
    await post(message, { timeoutMs, expectReply: false });
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get protocolVersion() {
      return protocolVersion;
    },

    async initialize({ timeoutMs = 30_000 } = {}) {
      const result = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: VERSION },
      }, { timeoutMs });
      protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
      await notify('notifications/initialized', undefined, { timeoutMs });
      return result;
    },

    /** Calls a tool and returns its data; an isError result throws ToolError. */
    async callTool(name, args, { timeoutMs = 60_000 } = {}) {
      const result = await request('tools/call', { name, arguments: args }, { timeoutMs });
      if (result?.isError) throw toolErrorFrom(result);
      return toolData(result);
    },
  };
}
