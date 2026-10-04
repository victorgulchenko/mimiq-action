import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/index.js';
import { HONEST_LINE, MARKER } from '../src/comment.js';
import { finishedEnvelope, KEY, persona, runningReport, startMockMcp, stillRunning } from './helpers/mock-mcp.js';
import { startMockGitHub } from './helpers/mock-github.js';

const GH_TOKEN = 'ghs_mocktoken_123456';
const SHA = 'abc1234def5678';
const PREVIEW = 'https://site-git-feature-acme.vercel.app';

const crowd = (stay, skim, leave) => [
  ...Array.from({ length: stay }, (_, i) => persona(`Stay${i} Person`, 'read', 'engaged', i === 0 ? ['I cannot tell what it costs.'] : [])),
  ...Array.from({ length: skim }, (_, i) => persona(`Skim${i} Person`, 'skimmed', 'bounced', ['Too much jargon up top.'])),
  ...Array.from({ length: leave }, (_, i) => persona(`Leave${i} Person`, 'left', 'bounced', ['I cannot tell what it costs.'])),
];

const deploymentEvent = (overrides = {}) => ({
  deployment: { id: 11, sha: SHA, environment: 'Preview', production_environment: false },
  deployment_status: { state: 'success', environment_url: PREVIEW, target_url: 'https://vercel.com/acme/site/deploy-log', ...overrides },
  repository: { full_name: 'acme/site' },
});

async function setup(t, { mcp = {}, github = {} } = {}) {
  const mock = await startMockMcp(mcp);
  const gh = await startMockGitHub(github);
  const dir = mkdtempSync(join(tmpdir(), 'mimiq-action-'));
  t.after(async () => {
    await mock.close();
    await gh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = 5_000_000;
  const logs = [];
  const go = async ({ eventName = 'deployment_status', event = deploymentEvent(), inputs = {}, env = {} } = {}) => {
    const eventPath = join(dir, 'event.json');
    const outputPath = join(dir, `output-${logs.length}.txt`);
    const summaryPath = join(dir, 'summary.md');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, '');
    writeFileSync(summaryPath, '');
    const lines = [];
    const res = await run({
      env: {
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REPOSITORY: 'acme/site',
        GITHUB_API_URL: gh.url,
        GITHUB_SHA: 'fallbacksha0000',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '42',
        MIMIQ_MCP_URL: mock.url,
        'INPUT_API-KEY': KEY,
        'INPUT_GITHUB-TOKEN': GH_TOKEN,
        INPUT_PEOPLE: '10',
        INPUT_COMMENT: 'true',
        'INPUT_TIMEOUT-MINUTES': '8',
        ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
        ...env,
      },
      write: (s) => { lines.push(s); logs.push(s); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 15_000,
    });
    return { ...res, log: lines.join(''), outputs: parseOutputs(readFileSync(outputPath, 'utf8')), summary: readFileSync(summaryPath, 'utf8') };
  };
  return { mock, gh, go, logs };
}

function parseOutputs(text) {
  const out = {};
  const re = /^([\w-]+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
}

const finishedTool = (stay, skim, leave) => ({ 'mimiq.test_page': () => ({ data: finishedEnvelope({ personas: crowd(stay, skim, leave), sessionId: 'sess_e2e' }) }) });

test('deployment_status: tests environment_url, comments once on the open PR, sets outputs and the summary', async (t) => {
  const { mock, gh, go } = await setup(t, { mcp: { tools: finishedTool(6, 2, 2) } });
  const res = await go({ inputs: { audience: 'seed-stage founders', goal: 'join the waitlist' } });
  assert.equal(res.exitCode, 0);

  const call = mock.state.toolCalls.find((c) => c.name === 'mimiq.test_page');
  assert.deepEqual(call.args, { url: PREVIEW, count: 10, timeout_seconds: 300, audience: 'seed-stage founders', goal: 'join the waitlist' });

  assert.ok(gh.state.requests.some((r) => r.method === 'GET' && r.path === `/repos/acme/site/commits/${SHA}/pulls`));
  assert.equal(gh.state.comments.length, 1);
  const body = gh.state.comments[0].body;
  assert.equal(gh.state.comments[0].issue, 7);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /### Mimiq: Holds attention/);
  assert.match(body, /\*\*6 of 10 simulated people would stay\*\*/);
  assert.match(body, /\| 6 \| 2 \| 2 \|/);
  assert.match(body, /"I cannot tell what it costs\." \(Leave0 and 2 others\)/);
  assert.equal(body.trimEnd().split('\n').pop(), HONEST_LINE);
  // The running comment was posted first, then updated in place (one POST, one PATCH).
  assert.equal(gh.state.requests.filter((r) => r.method === 'POST').length, 1);
  assert.equal(gh.state.requests.filter((r) => r.method === 'PATCH').length, 1);
  assert.match(gh.state.requests.find((r) => r.method === 'POST').body.body, /Mimiq is testing this preview/);

  assert.deepEqual(res.outputs, { 'report-url': 'https://www.mimiqai.com/app/t/sess_e2e', stayed: '6', people: '10', verdict: 'Holds attention' });
  assert.match(res.summary, /6 of 10 simulated people would stay/);
  for (const r of gh.state.requests) assert.equal(r.headers.authorization, `Bearer ${GH_TOKEN}`);
});

test('deployment_status: falls back to target_url when there is no environment_url', async (t) => {
  const { mock, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) } });
  await go({ event: deploymentEvent({ environment_url: undefined, target_url: 'https://site-abc123.vercel.app/' }) });
  assert.equal(mock.state.toolCalls[0].args.url, 'https://site-abc123.vercel.app/');
});

test('a later run updates the existing marked comment instead of adding one', async (t) => {
  const { gh, go } = await setup(t, {
    mcp: { tools: finishedTool(2, 3, 5) },
    github: { comments: [
      { id: 1, issue: 7, body: 'Looks good to me', user: { login: 'human' } },
      { id: 2, issue: 7, body: `${MARKER}\n### Mimiq: Mixed\nold result`, user: { login: 'github-actions[bot]' } },
      { id: 3, issue: 8, body: `${MARKER}\nother PR`, user: { login: 'github-actions[bot]' } },
    ] },
  });
  const res = await go();
  assert.equal(res.exitCode, 0);
  assert.equal(gh.state.requests.filter((r) => r.method === 'POST').length, 0, 'no new comment');
  const patches = gh.state.requests.filter((r) => r.method === 'PATCH');
  assert.equal(patches.length, 2);
  for (const p of patches) assert.equal(p.path, '/repos/acme/site/issues/comments/2');
  assert.equal(gh.state.comments.find((c) => c.id === 1).body, 'Looks good to me');
  assert.equal(gh.state.comments.find((c) => c.id === 3).body, `${MARKER}\nother PR`);
  assert.match(gh.state.comments.find((c) => c.id === 2).body, /### Mimiq: Loses most/);
});

test('deployment_status that is not success: skipped, no Mimiq call, no credits', async (t) => {
  const { mock, gh, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) } });
  const res = await go({ event: deploymentEvent({ state: 'pending' }) });
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.verdict, 'skipped');
  assert.equal(mock.state.requests.length, 0);
  assert.equal(gh.state.requests.length, 0);
});

test('deployment_status with no open pull request (a production deploy): skipped, no credits', async (t) => {
  const { mock, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) }, github: { pulls: [{ number: 3, state: 'closed' }] } });
  const res = await go();
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.verdict, 'skipped');
  assert.equal(mock.state.requests.length, 0);
  assert.match(res.log, /No open pull request/);
});

test('label trigger (pull_request): finds the URL from the head commit\'s successful deployment', async (t) => {
  const { mock, gh, go } = await setup(t, {
    mcp: { tools: finishedTool(4, 3, 3) },
    github: {
      deployments: [{ id: 501 }, { id: 500 }],
      statuses: { 501: [{ state: 'in_progress' }], 500: [{ state: 'success', environment_url: 'https://site-pr-9.vercel.app' }] },
    },
  });
  const res = await go({ eventName: 'pull_request', event: { action: 'labeled', label: { name: 'mimiq' }, pull_request: { number: 9, head: { sha: 'headsha99' } } } });
  assert.equal(res.exitCode, 0);
  assert.equal(mock.state.toolCalls[0].args.url, 'https://site-pr-9.vercel.app');
  assert.ok(gh.state.requests.some((r) => r.path === '/repos/acme/site/deployments' && r.query.sha === 'headsha99'));
  assert.equal(gh.state.comments[0].issue, 9);
  assert.match(gh.state.comments[0].body, /### Mimiq: Mixed/);
});

test('workflow_dispatch with an explicit url and comment off: no GitHub writes, outputs still set', async (t) => {
  const { mock, gh, go } = await setup(t, { mcp: { tools: finishedTool(1, 1, 8) } });
  const res = await go({ eventName: 'workflow_dispatch', event: { inputs: {} }, inputs: { url: 'https://staging.example.com/', comment: 'false' } });
  assert.equal(res.exitCode, 0);
  assert.equal(mock.state.toolCalls[0].args.url, 'https://staging.example.com/');
  assert.equal(gh.state.requests.length, 0);
  assert.equal(res.outputs.verdict, 'Losing them');
  assert.match(res.summary, /1 of 10 simulated people would stay/);
});

test('people above 25 is capped at 25 with a warning', async (t) => {
  const { mock, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) } });
  const res = await go({ inputs: { people: '100' } });
  assert.equal(res.exitCode, 0);
  assert.equal(mock.state.toolCalls[0].args.count, 25);
  assert.match(res.log, /::warning::people is 100, but this Action caps a run at 25/);
});

test('people that is not a whole number fails before anything runs', async (t) => {
  const { mock, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) } });
  const res = await go({ inputs: { people: 'ten' } });
  assert.equal(res.exitCode, 1);
  assert.equal(mock.state.requests.length, 0);
  assert.match(res.log, /::error::.*people must be a whole number from 1 to 25/);
});

test('fail-below: fails the step when too few would stay, and says so in the comment', async (t) => {
  const { gh, go } = await setup(t, { mcp: { tools: finishedTool(3, 2, 5) } });
  const res = await go({ inputs: { 'fail-below': '50' } });
  assert.equal(res.exitCode, 1);
  // Workflow commands escape % as %25; the runner shows it as %.
  assert.match(res.log, /::error::30%25 of simulated people would stay, below the fail-below bar of 50%25/);
  assert.match(gh.state.comments[0].body, /Check: failed\. 30% would stay, below the 50% bar\./);
  assert.equal(res.outputs.stayed, '3');
});

test('fail-below: passes at or above the bar', async (t) => {
  const { gh, go } = await setup(t, { mcp: { tools: finishedTool(5, 2, 3) } });
  const res = await go({ inputs: { 'fail-below': '50%' } });
  assert.equal(res.exitCode, 0);
  assert.match(gh.state.comments[0].body, /Check: passed\. 50% would stay; the bar is 50%\./);
});

test('fail-below: off by default, so a weak page does not fail the check', async (t) => {
  const { go } = await setup(t, { mcp: { tools: finishedTool(0, 0, 10) } });
  const res = await go();
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputs.verdict, 'Losing them');
});

test('timeout: comments that the test is still running, with the report link, and does not fail', async (t) => {
  const { mock, gh, go } = await setup(t, {
    mcp: { tools: {
      'mimiq.test_page': () => ({ data: stillRunning({ sessionId: 'sess_slow' }) }),
      'mimiq.show_report': (args) => ({ data: runningReport({ sessionId: args.session_id, done: 6 }) }),
    } },
  });
  const res = await go({ inputs: { 'timeout-minutes': '2', 'fail-below': '50' } });
  assert.equal(res.exitCode, 0);
  assert.ok(mock.state.toolCalls.filter((c) => c.name === 'mimiq.show_report').length >= 1);
  assert.deepEqual(res.outputs, { 'report-url': 'https://www.mimiqai.com/app/t/sess_slow', stayed: '', people: '', verdict: 'running' });
  const body = gh.state.comments[0].body;
  assert.match(body, /### Mimiq: still running/);
  assert.match(body, /after 2 minutes\. 6 of 10 have reacted so far\./);
  assert.match(body, /\[Open the report\]\(https:\/\/www\.mimiqai\.com\/app\/t\/sess_slow\)/);
  assert.match(res.log, /::warning::fail-below was not checked/);
});

test('a Mimiq refusal fails the step and replaces the comment with the reason', async (t) => {
  const { gh, go } = await setup(t, { mcp: { tools: { 'mimiq.test_page': () => ({ error: { code: 'INSUFFICIENT_CREDITS', reason: 'out_of_credits', message: 'This account is out of people credits. This needs 10 credits and the account has 3.' } }) } } });
  const res = await go();
  assert.equal(res.exitCode, 1);
  assert.equal(res.outputs.verdict, 'error');
  assert.match(res.log, /::error::Mimiq could not run the test\. This account is out of people credits/);
  assert.equal(gh.state.comments.length, 1);
  assert.match(gh.state.comments[0].body, /### Mimiq could not run the test/);
  assert.match(gh.state.comments[0].body, /needs 10 credits and the account has 3/);
});

test('a comment that cannot be written (fork token) warns but does not fail a good run', async (t) => {
  const { go } = await setup(t, { mcp: { tools: finishedTool(6, 2, 2) }, github: { failWrites: true } });
  const res = await go();
  assert.equal(res.exitCode, 0);
  assert.match(res.log, /::warning::Could not write the pull request comment/);
  assert.equal(res.outputs.verdict, 'Holds attention');
});

test('a missing api-key fails with how to get one, before any request', async (t) => {
  const { mock, gh, go } = await setup(t, { mcp: { tools: finishedTool(5, 0, 5) } });
  const res = await go({ env: { 'INPUT_API-KEY': '' } });
  assert.equal(res.exitCode, 1);
  assert.match(res.log, /api-key is empty\. Create a key in Mimiq under Settings, "Use Mimiq from your coding agent"/);
  assert.equal(mock.state.requests.length, 0);
  assert.equal(gh.state.requests.length, 0);
});

test('the API key is masked first and never appears in logs, outputs, summary or the comment', async (t) => {
  // A hostile or buggy server echoes the key back in its error message.
  const { mock, gh, go } = await setup(t, { mcp: { tools: { 'mimiq.test_page': () => ({ error: { code: 'BACKEND_ERROR', message: `Mimiq hit a server problem (bad header Bearer ${KEY}).` } }) } } });
  const res = await go({ inputs: { audience: 'founders' } });
  assert.equal(res.exitCode, 1);

  // The key was sent to Mimiq, as a bearer token, and only there.
  assert.equal(mock.state.requests[0].headers.authorization, `Bearer ${KEY}`);
  for (const r of gh.state.requests) assert.equal(JSON.stringify(r).includes(KEY), false);

  const lines = res.log.split('\n');
  assert.equal(lines[0], `::add-mask::${KEY}`, 'the key is masked before anything else is printed');
  const leaks = lines.filter((l) => l.includes(KEY) && !l.startsWith('::add-mask::'));
  assert.deepEqual(leaks, []);
  assert.match(res.log, /bad header Bearer \*\*\*/);
  assert.equal(JSON.stringify(res.outputs).includes(KEY), false);
  // Markdown escaping must not smuggle the key through as mq\_sk\_..., which GitHub renders as the key.
  const unescaped = (s) => s.replace(/\\/g, '');
  assert.equal(unescaped(res.summary).includes(KEY), false);
  for (const c of gh.state.comments) assert.equal(unescaped(c.body).includes(KEY), false);
  assert.match(gh.state.comments[0].body, /bad header Bearer \\\*\\\*\\\*/);
});

test('a key echoed inside a finished result (a quoted doubt) is removed from the comment too', async (t) => {
  const personas = [persona('Ana Ruiz', 'left', 'bounced', [`My token is ${KEY} lol`]), persona('Bo Li', 'read', 'engaged', [])];
  const { gh, go } = await setup(t, { mcp: { tools: { 'mimiq.test_page': () => ({ data: finishedEnvelope({ personas }) }) } } });
  const res = await go();
  assert.equal(res.exitCode, 0);
  const body = gh.state.comments[0].body;
  assert.equal(body.replace(/\\/g, '').includes(KEY), false);
  assert.match(body, /My token is \\\*\\\*\\\* lol/);
  assert.equal(res.summary.replace(/\\/g, '').includes(KEY), false);
});

test('an unreachable Mimiq server fails cleanly without leaking the key', async (t) => {
  const { go } = await setup(t, {});
  const res = await go({ env: { MIMIQ_MCP_URL: 'http://127.0.0.1:9/mcp' } });
  assert.equal(res.exitCode, 1);
  assert.match(res.log, /::error::Mimiq could not run the test\. Could not reach Mimiq/);
  assert.equal(res.log.split('\n').filter((l) => l.includes(KEY) && !l.startsWith('::add-mask::')).length, 0);
});
