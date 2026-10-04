#!/usr/bin/env node
/**
 * Mimiq page test, as a GitHub Action.
 *
 * On a successful preview deployment (or a label, or a manual run) it shows the
 * page to a small crowd of simulated people through Mimiq's hosted MCP server,
 * then posts or updates ONE pull request comment with the verdict, how many would
 * stay, skim or leave, their top doubts and a link to the full report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore, InputError } from './core.js';
import { createMcpClient, DEFAULT_MCP_URL, McpError, ToolError } from './mcp.js';
import { DEFAULT_PEOPLE, DEFAULT_POLL_MS, MAX_PEOPLE, runPageTest, verdictFor } from './mimiq.js';
import { displayUrl, renderAudienceReview, renderError, renderFinished, renderRunning, renderStillRunning, stayPercent } from './comment.js';
import { createGitHub } from './github.js';

const KEY_HELP = 'Create a key in Mimiq under Settings, "Use Mimiq from your coding agent", save it as a repository secret (for example MIMIQ_API_KEY) and pass it as api-key: ${{ secrets.MIMIQ_API_KEY }}.';
const MAX_TEXT = 500; // test_page caps audience and goal at 500 characters (server.js inputSchema)

export function readInputs(core) {
  // Mask the key before anything else can print it.
  const apiKey = core.getInput('api-key');
  if (apiKey) core.setSecret(apiKey);
  const githubToken = core.getInput('github-token');
  if (githubToken) core.setSecret(githubToken);
  if (!apiKey) throw new InputError(`api-key is empty. ${KEY_HELP} Pull requests from forks do not receive repository secrets.`);

  const rawPeople = core.getInput('people') || String(DEFAULT_PEOPLE);
  if (!/^\d+$/.test(rawPeople) || Number(rawPeople) < 1) {
    throw new InputError(`people must be a whole number from 1 to ${MAX_PEOPLE}, got "${rawPeople}".`);
  }
  let people = Number(rawPeople);
  if (people > MAX_PEOPLE) {
    core.warning(`people is ${people}, but this Action caps a run at ${MAX_PEOPLE} simulated people to limit credit spend. Running ${MAX_PEOPLE}.`);
    people = MAX_PEOPLE;
  }

  const rawFail = core.getInput('fail-below');
  let failBelow = null;
  if (rawFail) {
    const n = Number(rawFail.replace(/%$/, '').trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new InputError(`fail-below must be a percentage from 0 to 100, got "${rawFail}".`);
    failBelow = n;
  }

  const rawTimeout = core.getInput('timeout-minutes') || '8';
  const timeoutMinutes = Number(rawTimeout);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    throw new InputError(`timeout-minutes must be a number from 1 to 60, got "${rawTimeout}".`);
  }

  const audience = core.getInput('audience');
  const goal = core.getInput('goal');
  if (audience.length > MAX_TEXT) throw new InputError(`audience is ${audience.length} characters; Mimiq accepts up to ${MAX_TEXT}.`);
  if (goal.length > MAX_TEXT) throw new InputError(`goal is ${goal.length} characters; Mimiq accepts up to ${MAX_TEXT}.`);

  const url = core.getInput('url');
  if (url) checkUrl(url, 'url');

  return { apiKey, githubToken, url, audience, goal, people, failBelow, timeoutMinutes, comment: core.getBooleanInput('comment', true) };
}

function checkUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError(`${field} is not a valid URL: "${value}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new InputError(`${field} must be an http or https URL.`);
}

function readEvent(env) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function describeError(error) {
  if (error instanceof InputError) return error.message;
  if (error?.code === 'UNAUTHORIZED') return `Mimiq did not accept the API key. ${KEY_HELP}`;
  if (error instanceof ToolError) return error.message;
  if (error instanceof McpError) {
    if (error.code === 'TIMEOUT' && /tools\/call/.test(error.message)) return `${error.message} The test may still be running: its report will appear in your Mimiq account.`;
    return error.message;
  }
  return `Unexpected error: ${error?.message || error}`;
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every string Mimiq sent back, with secrets removed before it is rendered or escaped. */
function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  return value;
}

/**
 * Runs the Action. Everything that touches the outside world is injectable for tests.
 * Returns { exitCode, outputs }.
 */
export async function run({ env = process.env, fetchImpl = globalThis.fetch, write, sleep = defaultSleep, now = Date.now, pollIntervalMs = DEFAULT_POLL_MS } = {}) {
  const core = createCore({ env, ...(write ? { write } : {}) });
  let outputs = { 'report-url': '', stayed: '', people: '', verdict: '' };
  const finish = (exitCode) => {
    for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
    return { exitCode, outputs };
  };

  let gh = null;
  let pr = null;
  let commenting = false;
  let ctx = {};
  const writeComment = async (body) => {
    if (!commenting) return;
    try {
      const done = await gh.upsertComment(pr, core.redact(body));
      core.info(`${done.action === 'created' ? 'Posted' : 'Updated'} the pull request comment${done.url ? `: ${done.url}` : ''}.`);
    } catch (e) {
      core.warning(`Could not write the pull request comment: ${e.message}. The workflow needs "pull-requests: write" permission, and pull requests from forks get a read-only token.`);
    }
  };

  try {
    const inputs = readInputs(core);
    const eventName = env.GITHUB_EVENT_NAME || '';
    const event = readEvent(env);
    const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;

    // A deployment that is pending, failed or in progress has nothing to test yet.
    if (eventName === 'deployment_status') {
      const state = String(event.deployment_status?.state || '');
      if (state !== 'success') {
        core.info(`The deployment status is "${state || 'unknown'}", not "success". Skipping, so no credits are spent.`);
        outputs.verdict = 'skipped';
        return finish(0);
      }
    }

    if (inputs.githubToken && env.GITHUB_REPOSITORY) {
      gh = createGitHub({ token: inputs.githubToken, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL || 'https://api.github.com', fetchImpl });
    }
    const sha = event.deployment?.sha || event.pull_request?.head?.sha || env.GITHUB_SHA || '';
    pr = event.pull_request?.number || (event.issue?.pull_request ? event.issue.number : null) || null;
    if (!pr && gh && sha && (inputs.comment || eventName === 'deployment_status')) {
      try {
        pr = (await gh.openPullRequestsForCommit(sha))[0]?.number || null;
      } catch (e) {
        core.warning(`Could not look up the pull request for commit ${sha.slice(0, 7)}: ${e.message}`);
      }
    }
    // Preview deploys are tested for their pull request. Production deploys and
    // branches without an open pull request are skipped, so they spend nothing.
    if (eventName === 'deployment_status' && !pr) {
      core.notice('No open pull request was found for this deployment, so no test ran and no credits were spent. Production deployments end here.');
      outputs.verdict = 'skipped';
      return finish(0);
    }

    let url = inputs.url;
    let from = 'the url input';
    if (!url && eventName === 'deployment_status') {
      url = event.deployment_status?.environment_url || event.deployment_status?.target_url || '';
      from = 'the deployment status';
    }
    if (!url && gh && sha) {
      try {
        url = (await gh.findDeploymentUrl(sha)) || '';
        from = `the latest successful deployment of ${sha.slice(0, 7)}`;
      } catch (e) {
        core.warning(`Could not look up deployments for commit ${sha.slice(0, 7)}: ${e.message}`);
      }
    }
    if (!url) {
      throw new InputError('No URL to test. Run this Action on a successful deployment_status event, set the url input, or give the workflow "deployments: read" permission so it can find the commit\'s deployment.');
    }
    checkUrl(url, 'The deployment URL');

    ctx = { url, people: inputs.people, sha, runUrl, audience: inputs.audience, goal: inputs.goal };
    commenting = Boolean(inputs.comment && gh && pr);
    if (inputs.comment && !commenting) core.info('No pull request was found for this run, so the result goes to the job summary and the outputs only.');
    core.info(`Testing ${displayUrl(url)} (from ${from}) on ${inputs.people} simulated people. This uses up to ${inputs.people} credits.`);
    await writeComment(renderRunning(ctx));

    const client = createMcpClient({ url: env.MIMIQ_MCP_URL || DEFAULT_MCP_URL, apiKey: inputs.apiKey, fetchImpl });
    const rawOutcome = await runPageTest({
      client,
      url,
      audience: inputs.audience,
      goal: inputs.goal,
      people: inputs.people,
      timeoutMs: inputs.timeoutMinutes * 60_000,
      pollIntervalMs,
      now,
      sleep,
      log: (m) => core.info(m),
    });
    const outcome = redactDeep(rawOutcome, core.redact);

    const check = inputs.failBelow === null ? null : { failBelow: inputs.failBelow, passed: null, percent: null };
    let body;
    let exitCode = 0;
    if (outcome.state === 'finished') {
      const result = outcome.result;
      const verdict = verdictFor(result.stayed, result.total);
      outputs = { 'report-url': result.reportUrl || '', stayed: String(result.stayed), people: String(result.total), verdict: verdict || '' };
      core.info(`${result.stayed} of ${result.total} simulated people would stay${verdict ? ` (${verdict})` : ''}.${result.reportUrl ? ` Report: ${result.reportUrl}` : ''}`);
      if (check) {
        const percent = stayPercent(result);
        check.percent = percent;
        check.passed = percent === null ? null : percent >= check.failBelow;
        if (check.passed === false) {
          core.error(`${Math.round(percent)}% of simulated people would stay, below the fail-below bar of ${check.failBelow}%.`);
          exitCode = 1;
        } else if (check.passed === null) {
          core.warning('fail-below was not checked because no simulated people reacted.');
        }
      }
      body = renderFinished({ ...ctx, result, verdict, check });
    } else if (outcome.state === 'running') {
      outputs = { ...outputs, 'report-url': outcome.reportUrl || '', verdict: 'running' };
      core.warning(`The test was still running after ${inputs.timeoutMinutes} minutes. Mimiq saves the result when it finishes${outcome.reportUrl ? `: ${outcome.reportUrl}` : ''}.`);
      if (check) core.warning('fail-below was not checked because the test had not finished.');
      body = renderStillRunning({ ...ctx, reportUrl: outcome.reportUrl, progress: outcome.progress, minutes: inputs.timeoutMinutes, check });
    } else {
      outputs = { ...outputs, verdict: 'audience-mismatch' };
      core.warning('Mimiq paused before the test: the simulated people it recruited did not match the audience. Make the audience input more specific and run again.');
      body = renderAudienceReview({ ...ctx, review: outcome });
    }
    await writeComment(body);
    core.appendSummary(body);
    return finish(exitCode);
  } catch (error) {
    const message = core.redact(describeError(error));
    core.error(`Mimiq could not run the test. ${message}`);
    outputs = { ...outputs, verdict: 'error' };
    const body = renderError({ ...ctx, message });
    await writeComment(body);
    core.appendSummary(body);
    return finish(1);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run().then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (error) => {
      const key = String(process.env['INPUT_API-KEY'] || '').trim();
      let message = String(error?.message || error).replace(/\r?\n/g, ' ');
      if (key) message = message.split(key).join('***');
      process.stdout.write(`::error::Unexpected failure: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
