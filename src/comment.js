/**
 * The pull request comment. Copy rules (Mimiq brand and legal):
 *   - say "simulated people", never "users" alone;
 *   - no em dashes and no emojis, including inside quoted words;
 *   - never name AI models or vendors;
 *   - end with the honest line below.
 * The hidden marker lets the Action find and update its own comment.
 */
export const MARKER = '<!-- mimiq-action -->';
export const HONEST_LINE = 'Simulated reactions are a first read, not a forecast of real conversion.';
const APP_URL = 'https://www.mimiqai.com';

/** Plain, single-line text: em dashes become commas, emojis go, long text is clipped. */
export function cleanText(value, max = 240) {
  let text = String(value ?? '')
    .replace(/\s*[\u2014\u2015]\s*/g, ', ')
    .replace(/\s+\u2013\s+/g, ', ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 3).trimEnd()}...`;
  return text;
}

/** Untrusted text inside markdown: no formatting, links, HTML or @mentions sneak in. */
export function mdText(value, max) {
  return cleanText(value, max)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]|~])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;');
}

/** Where the page is, without query or fragment (they can hold access tokens). */
export function displayUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url ?? '');
  }
}

export function pageLink(url) {
  try {
    const u = new URL(url);
    const href = displayUrl(url).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const label = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    return `[${mdText(label, 120)}](${href})`;
  } catch {
    return mdText(url, 120);
  }
}

const link = (label, href) => `[${label}](${String(href).replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function contextLines({ audience, goal, result }) {
  const lines = [];
  lines.push(sentence(`Audience: ${audience ? mdText(audience, 300) : 'picked by Mimiq from the page'}`));
  if (goal) lines.push(sentence(`Goal: ${mdText(goal, 300)}`));
  if (result?.fitWarning) lines.push(sentence(`Audience note: ${mdText(result.fitWarning, 300)}`));
  return lines;
}

function footer({ sha, people, runUrl }) {
  const bits = [];
  if (sha) bits.push(`Commit ${mdText(String(sha).slice(0, 7))}`);
  if (people) bits.push(`${plural(people, 'simulated person', 'simulated people')}, one credit each`);
  if (runUrl) bits.push(link('Workflow run', runUrl));
  return [...(bits.length ? [`<sub>${bits.join(' · ')}</sub>`, ''] : []), HONEST_LINE];
}

function doubtLines(doubts) {
  if (!doubts?.length) return ['**Top doubts, in their words:** none raised.'];
  return [
    '**Top doubts, in their words**',
    '',
    ...doubts.map((d) => {
      const others = d.count > 1 ? ` and ${plural(d.count - 1, 'other', 'others')}` : '';
      return `- "${mdText(d.quote, 220)}" (${mdText(d.person, 40)}${others})`;
    }),
  ];
}

export function stayPercent(result) {
  if (!result || !(result.total > 0)) return null;
  return (result.stayed / result.total) * 100;
}

function checkLine(check) {
  if (!check) return [];
  const bar = `${check.failBelow}%`;
  if (check.passed === null) return [`Check: not evaluated, because the test had not finished. The bar is ${bar}.`];
  const pct = `${Math.round(check.percent)}%`;
  return [check.passed ? `Check: passed. ${pct} would stay; the bar is ${bar}.` : `Check: failed. ${pct} would stay, below the ${bar} bar.`];
}

export function renderRunning({ url, people, sha, runUrl, audience, goal }) {
  return [
    MARKER,
    '### Mimiq is testing this preview',
    '',
    `${plural(people, 'simulated person is', 'simulated people are')} visiting ${pageLink(url)} now. This comment updates with what they did and why, usually within a few minutes.`,
    '',
    ...contextLines({ audience, goal }),
    '',
    ...footer({ sha, people, runUrl }),
  ].join('\n');
}

export function renderFinished({ url, people, sha, runUrl, audience, goal, result, verdict, check }) {
  const table = result.skimmed === null
    ? ['| Would stay | Skimmed or left |', '| :-: | :-: |', `| ${result.stayed} | ${result.left} |`]
    : ['| Would stay | Skimmed | Left |', '| :-: | :-: | :-: |', `| ${result.stayed} | ${result.skimmed} | ${result.left} |`];
  return [
    MARKER,
    `### Mimiq: ${verdict || 'Result'}`,
    '',
    `**${result.stayed} of ${plural(result.total, 'simulated person', 'simulated people')} would stay** on ${pageLink(url)}.`,
    '',
    ...table,
    '',
    ...(result.headline ? [`Mimiq's read: ${mdText(result.headline, 300)}`, ''] : []),
    ...doubtLines(result.doubts),
    '',
    result.reportUrl ? link('Open the full report', result.reportUrl) : 'The full report is in your Mimiq account.',
    '',
    ...contextLines({ audience, goal, result }),
    ...checkLine(check),
    '',
    ...footer({ sha, people, runUrl }),
  ].join('\n');
}

export function renderStillRunning({ url, people, sha, runUrl, audience, goal, reportUrl, progress, minutes, check }) {
  const sofar = progress ? ` ${progress.done} of ${progress.total} have reacted so far.` : '';
  return [
    MARKER,
    '### Mimiq: still running',
    '',
    `The simulated people are still visiting ${pageLink(url)} after ${plural(minutes, 'minute', 'minutes')}.${sofar} Mimiq saves the result when they finish.`,
    '',
    reportUrl ? `${link('Open the report', reportUrl)} to see it.` : 'Open your Mimiq account to see it.',
    '',
    ...contextLines({ audience, goal }),
    ...checkLine(check),
    '',
    ...footer({ sha, people, runUrl }),
  ].join('\n');
}

export function renderAudienceReview({ url, people, sha, runUrl, audience, goal, review }) {
  const fit = Number.isFinite(review.fitRate) ? `Audience fit: ${Math.round(review.fitRate * 100)}% verified.` : '';
  const details = [fit, review.summary ? mdText(review.summary, 300) : '', review.warning ? mdText(review.warning, 300) : ''].filter(Boolean).join(' ');
  return [
    MARKER,
    '### Mimiq: paused before the test',
    '',
    `Mimiq recruited simulated people for ${pageLink(url)}, but too many of them did not match the audience you described, so the test did not run.`,
    '',
    ...(details ? [details, ''] : []),
    `Make the \`audience\` input more specific and run the workflow again.${review.reviewId ? ` ${link('See who was recruited', `${APP_URL}/app/t/${review.reviewId}`)}.` : ''}`,
    '',
    ...contextLines({ audience, goal }),
    '',
    ...footer({ sha, people, runUrl }),
  ].join('\n');
}

export function renderError({ url, sha, runUrl, message }) {
  return [
    MARKER,
    '### Mimiq could not run the test',
    '',
    ...(url ? [`Page: ${pageLink(url)}`, ''] : []),
    mdText(message, 600),
    '',
    ...footer({ sha, runUrl }),
  ].join('\n');
}
