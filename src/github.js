/**
 * The GitHub REST calls this Action makes, over fetch:
 *   - open pull requests for a commit (to find where to comment);
 *   - the latest successful deployment of a commit (the default URL outside deployment_status);
 *   - find the Action's own comment by its hidden marker, then update it or create one.
 */
import { MARKER } from './comment.js';
import { VERSION } from './version.js';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

const MAX_COMMENT_PAGES = 20;

export function createGitHub({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  const [owner, repo] = String(repository || '').split('/');
  if (!token || !owner || !repo) throw new GitHubError('A GitHub token and GITHUB_REPOSITORY are required.', 0);
  const base = String(apiUrl).replace(/\/+$/, '');
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function api(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': `mimiq-github-action/${VERSION}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new GitHubError(`GitHub API ${method} ${path} failed: ${e?.cause?.code || e?.message || e}`, 0);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
      let detail = text;
      try {
        detail = JSON.parse(text).message || text;
      } catch {
        /* not JSON */
      }
      throw new GitHubError(`GitHub API ${method} ${path.split('?')[0]} answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    /** Open pull requests whose head contains this commit, newest first as GitHub lists them. */
    async openPullRequestsForCommit(sha) {
      const list = await api('GET', `${repoPath}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`);
      return (Array.isArray(list) ? list : []).filter((pr) => pr?.state === 'open');
    },

    /** The URL of the newest deployment of this commit that has a successful status, or null. */
    async findDeploymentUrl(sha) {
      const deployments = await api('GET', `${repoPath}/deployments?sha=${encodeURIComponent(sha)}&per_page=10`);
      for (const deployment of (Array.isArray(deployments) ? deployments : []).slice(0, 5)) {
        const statuses = await api('GET', `${repoPath}/deployments/${deployment.id}/statuses?per_page=20`);
        const ok = (Array.isArray(statuses) ? statuses : []).find((s) => s?.state === 'success' && (s.environment_url || s.target_url));
        if (ok) return ok.environment_url || ok.target_url;
      }
      return null;
    },

    async findMarkedComment(issueNumber) {
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const comments = await api('GET', `${repoPath}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
        const list = Array.isArray(comments) ? comments : [];
        const mine = list.find((c) => typeof c?.body === 'string' && c.body.includes(MARKER));
        if (mine) return mine;
        if (list.length < 100) return null;
      }
      return null;
    },

    /** One comment per pull request: update the marked one if it exists, else create it. */
    async upsertComment(issueNumber, body) {
      const existing = await this.findMarkedComment(issueNumber);
      if (existing) {
        const updated = await api('PATCH', `${repoPath}/issues/comments/${existing.id}`, { body });
        return { action: 'updated', id: existing.id, url: updated?.html_url || existing.html_url || null };
      }
      const created = await api('POST', `${repoPath}/issues/${issueNumber}/comments`, { body });
      return { action: 'created', id: created?.id ?? null, url: created?.html_url || null };
    },
  };
}
