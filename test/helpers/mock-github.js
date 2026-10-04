/** A local stand-in for the few GitHub REST endpoints the Action uses. */
import http from 'node:http';

export async function startMockGitHub({ pulls = [{ number: 7, state: 'open' }], comments = [], deployments = [], statuses = {}, failWrites = false } = {}) {
  const state = { requests: [], comments: comments.map((c) => ({ ...c })), nextId: 9000 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://localhost');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const send = (status, value) => {
      const payload = value === undefined ? '' : JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    };
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/acme\/site\/commits\/([^/]+)\/pulls$/))) return send(200, pulls);
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/acme\/site\/issues\/(\d+)\/comments$/))) {
      const perPage = Number(url.searchParams.get('per_page') || 30);
      const page = Number(url.searchParams.get('page') || 1);
      const list = state.comments.filter((c) => c.issue === Number(m[1]));
      return send(200, list.slice((page - 1) * perPage, page * perPage));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/repos\/acme\/site\/issues\/(\d+)\/comments$/))) {
      if (failWrites) return send(403, { message: 'Resource not accessible by integration' });
      const comment = { id: (state.nextId += 1), issue: Number(m[1]), body: body.body, user: { login: 'github-actions[bot]' }, html_url: `https://github.com/acme/site/pull/${m[1]}#issuecomment-${state.nextId}` };
      state.comments.push(comment);
      return send(201, comment);
    }
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/repos\/acme\/site\/issues\/comments\/(\d+)$/))) {
      if (failWrites) return send(403, { message: 'Resource not accessible by integration' });
      const comment = state.comments.find((c) => c.id === Number(m[1]));
      if (!comment) return send(404, { message: 'Not Found' });
      comment.body = body.body;
      return send(200, comment);
    }
    if (req.method === 'GET' && url.pathname === '/repos/acme/site/deployments') return send(200, deployments);
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/acme\/site\/deployments\/(\d+)\/statuses$/))) return send(200, statuses[m[1]] || []);
    return send(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
