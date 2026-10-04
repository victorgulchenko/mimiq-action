/**
 * One Mimiq page test, end to end: mimiq.test_page, then mimiq.show_report until
 * the run finishes or the time runs out. Both result shapes are reduced to one:
 *
 *   { total, stayed, skimmed, left, doubts, reportUrl, sessionId, headline, ... }
 *
 * The outcome rules are ported from Mimiq's own app logic
 * (mcp-hosted/src/vendor/app-logic.js: outcomeOf, summarize, VERDICT_WORDS), so
 * the comment counts the way the linked report does.
 */
import { McpError, ToolError } from './mcp.js';

export const MAX_PEOPLE = 25;
export const DEFAULT_PEOPLE = 10;
/** How long one test_page call waits on the server before it returns "still running" (server default 300, max 900). */
export const CALL_WAIT_SECONDS = 300;
export const DEFAULT_POLL_MS = 15_000;
/** show_report itself waits up to 40 s on the server for a run to settle. */
const REPORT_CALL_TIMEOUT_MS = 120_000;

// app-logic.js outcomeOf: the action words the app sorts into its four outcomes.
const CONVERT = ['converted', 'act', 'signup', 'sign_up', 'signed_up', 'purchase', 'purchased', 'buy', 'bought', 'subscribe', 'subscribed', 'would_use', 'yes', 'book_demo', 'demo_booked', 'start_trial', 'trial', 'share', 'shared'];
const STAY = ['clicked_cta', 'read', 'reading', 'saved', 'explored', 'explore', 'engaged', 'engage', 'like', 'liked', 'reply', 'replied', 'comment', 'interested', 'click', 'clicked'];
const SKIM = ['skimmed', 'skim', 'scroll', 'maybe', 'confused', 'glanced', 'neutral'];
const LEAVE = ['left', 'leave', 'bounced', 'bounce', 'ignore', 'ignored', 'scrolled_past', 'no', 'not_for_me', 'hide', 'negative', 'unsubscribe', 'delete', 'deleted', 'dismissed'];

// app-logic.js summarize: the page verdict from the share who stayed (thresholds 0.6, 0.4, 0.2).
const PAGE_VERDICTS = ['Holds attention', 'Mixed', 'Loses most', 'Losing them'];

/**
 * One simulated person's outcome on a page: converted, stayed, skimmed or left
 * (null for an errored run). Unknown actions fall back to the backend's bucket the
 * way the app falls back to category (converted -> positive -> stayed,
 * bounced -> negative -> left, anything else -> neutral -> skimmed).
 */
export function pageOutcome(action, actionClass) {
  const a = String(action || '').toLowerCase().trim().replace(/\s+/g, '_');
  if (a === 'error') return null;
  if (CONVERT.includes(a)) return 'converted';
  if (STAY.includes(a)) return 'stayed';
  if (SKIM.includes(a)) return 'skimmed';
  if (LEAVE.includes(a)) return 'left';
  const cls = String(actionClass || '').toLowerCase().trim();
  if (cls === 'converted') return 'stayed';
  if (cls === 'bounced') return 'left';
  return 'skimmed';
}

export function verdictFor(stayed, total) {
  if (!Number.isFinite(stayed) || !Number.isFinite(total) || total <= 0) return null;
  const rate = stayed / total;
  if (rate >= 0.6) return PAGE_VERDICTS[0];
  if (rate >= 0.4) return PAGE_VERDICTS[1];
  if (rate >= 0.2) return PAGE_VERDICTS[2];
  return PAGE_VERDICTS[3];
}

/** The saved test's ID from a report link: https://mimiqai.com/app/t/<id>. */
export function sessionIdFromUrl(url) {
  const match = /\/app\/t\/([A-Za-z0-9_-]{1,100})(?:[/?#]|$)/.exec(String(url || ''));
  return match ? match[1] : null;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'A simulated person';
const RANK = { left: 0, skimmed: 1, stayed: 2, converted: 3 };

/**
 * The top doubts in the simulated people's own words: the same objection said by
 * several people counts once per person; ties go to people least taken with the page.
 */
export function topDoubts(people, limit = 3) {
  const byQuote = new Map();
  let order = 0;
  for (const person of people) {
    const seen = new Set();
    for (const raw of person.objections || []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const quote = raw.trim();
      const key = quote.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item = byQuote.get(key) || { quote, person: person.first, count: 0, rank: RANK[person.outcome] ?? 9, order: (order += 1) };
      item.count += 1;
      if ((RANK[person.outcome] ?? 9) < item.rank) {
        item.rank = RANK[person.outcome];
        item.person = person.first;
      }
      byQuote.set(key, item);
    }
  }
  return [...byQuote.values()]
    .sort((a, b) => b.count - a.count || a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ quote, person, count }) => ({ quote, person, count }));
}

/** A finished mimiq.test_page result (mcp-envelope.js buildMcpEnvelope). */
export function fromTestPage(data) {
  const people = (Array.isArray(data?.personas) ? data.personas : [])
    .map((p) => ({ first: firstName(p?.name), outcome: pageOutcome(p?.action, p?.action_class), objections: Array.isArray(p?.objections) ? p.objections : [] }))
    .filter((p) => p.outcome);
  const counts = { converted: 0, stayed: 0, skimmed: 0, left: 0 };
  for (const p of people) counts[p.outcome] += 1;
  const reportUrl = data?.report_url || data?.results_url || null;
  return {
    source: 'test_page',
    total: people.length,
    stayed: counts.converted + counts.stayed,
    wouldAct: counts.converted,
    skimmed: counts.skimmed,
    left: counts.left,
    doubts: topDoubts(people),
    reportUrl,
    sessionId: data?.review_id || sessionIdFromUrl(reportUrl),
    headline: null,
    audience: data?.audience?.summary || null,
    fitWarning: data?.audience?.fit?.warning || data?.audience_fit?.warning || null,
  };
}

/**
 * A finished mimiq.show_report result (report-widget.js renderReport). Its counts
 * merge skimmed into left (counts.left = left + skimmed), so skimmed is null here.
 */
export function fromReport(data, { sessionId = null } = {}) {
  const version = Array.isArray(data?.versions) ? data.versions[0] : null;
  if (!version?.counts) throw new McpError('Mimiq returned a finished report without counts.', { code: 'BAD_RESPONSE' });
  const c = version.counts;
  return {
    source: 'show_report',
    total: Number(c.total) || 0,
    stayed: Number(c.stayed) || 0,
    wouldAct: null,
    skimmed: null,
    left: Number(c.left) || 0,
    doubts: (Array.isArray(version.objections) ? version.objections : [])
      .filter((o) => typeof o?.quote === 'string' && o.quote.trim())
      .slice(0, 3)
      .map((o) => ({ quote: o.quote.trim(), person: o.person || 'A simulated person', count: Number(o.count) || 1 })),
    reportUrl: data.report_url || null,
    sessionId,
    headline: data.headline || null,
    audience: null,
    fitWarning: null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reading a report spends no credits, so these failures are worth another try. */
function retryableRead(error) {
  if (error instanceof ToolError) return error.code === 'RATE_LIMITED' || /not ready yet/i.test(error.message);
  if (error instanceof McpError) return ['TIMEOUT', 'NETWORK', 'BAD_RESPONSE'].includes(error.code) || (error.status >= 500);
  return false;
}

/**
 * Runs the test. Returns one of:
 *   { state: 'finished', result }
 *   { state: 'running', reportUrl, sessionId, progress }       (the time ran out)
 *   { state: 'audience_review', reviewId, summary, fitRate, warning }
 * Throws ToolError (Mimiq said no) or McpError (transport).
 */
export async function runPageTest({
  client,
  url,
  audience = '',
  goal = '',
  people = DEFAULT_PEOPLE,
  timeoutMs = 8 * 60_000,
  pollIntervalMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleep = defaultSleep,
  log = () => {},
}) {
  const count = Math.min(MAX_PEOPLE, Math.max(1, Math.floor(Number(people) || DEFAULT_PEOPLE)));
  const deadline = now() + timeoutMs;
  await client.initialize();

  const waitSeconds = Math.min(900, Math.max(30, Math.floor(Math.min(CALL_WAIT_SECONDS, timeoutMs / 1000))));
  const args = { url, count, timeout_seconds: waitSeconds };
  if (audience) args.audience = audience;
  if (goal) args.goal = goal;

  // Never retried: a second start could recruit and charge twice.
  const data = await client.callTool('mimiq.test_page', args, { timeoutMs: (waitSeconds + 180) * 1000 });

  if (data?.status === 'audience_review') {
    const fit = data.audience_fit || data.audience?.fit || {};
    return {
      state: 'audience_review',
      reviewId: data.review_id || null,
      summary: data.summary || data.audience?.summary || null,
      fitRate: Number.isFinite(fit.fit_rate) ? fit.fit_rate : null,
      warning: fit.warning || null,
    };
  }
  if (Array.isArray(data?.personas)) return { state: 'finished', result: fromTestPage(data) };
  if (data?.status === 'finished' && Array.isArray(data.versions)) return { state: 'finished', result: fromReport(data) };
  if (data?.status !== 'still_running') throw new McpError('Mimiq returned a test result this Action cannot read.', { code: 'BAD_RESPONSE' });

  // Still running: follow the saved test with show_report (free) until it finishes or time runs out.
  const sessionId = data.review_id || sessionIdFromUrl(data.report_url);
  let reportUrl = data.report_url || null;
  let progress = null;
  log(`The test is still running${reportUrl ? `: ${reportUrl}` : ''}. Checking again every ${Math.round(pollIntervalMs / 1000)} seconds.`);
  if (!sessionId) return { state: 'running', reportUrl, sessionId: null, progress };

  for (;;) {
    if (now() + pollIntervalMs > deadline) return { state: 'running', reportUrl, sessionId, progress };
    await sleep(pollIntervalMs);
    let report;
    try {
      report = await client.callTool('mimiq.show_report', { session_id: sessionId }, { timeoutMs: REPORT_CALL_TIMEOUT_MS });
    } catch (error) {
      if (!retryableRead(error)) throw error;
      log(`Reading the report failed for now (${error.message}). Trying again.`);
      continue;
    }
    reportUrl = report?.report_url || reportUrl;
    if (report?.status === 'running') {
      progress = report.progress && Number.isInteger(report.progress.done) ? report.progress : progress;
      log(progress ? `Still running: ${progress.done} of ${progress.total} simulated people have reacted.` : 'Still running.');
      continue;
    }
    return { state: 'finished', result: fromReport(report, { sessionId }) };
  }
}
