import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, HONEST_LINE, MARKER, mdText, pageLink, renderAudienceReview, renderError, renderFinished, renderRunning, renderStillRunning } from '../src/comment.js';

const base = { url: 'https://preview.example.com/pricing?x-vercel-protection-bypass=SECRET#top', people: 10, sha: 'abcdef1234567', runUrl: 'https://github.com/acme/site/actions/runs/42', audience: 'seed-stage founders', goal: 'join the waitlist' };
const result = {
  total: 10, stayed: 6, skimmed: 1, left: 3, headline: null, reportUrl: 'https://www.mimiqai.com/app/t/sess_1', fitWarning: null,
  doubts: [
    { quote: 'I can\u2019t tell what it costs \u2014 at all \u{1F914}', person: 'Maya', count: 3 },
    { quote: 'Ping @everyone, see [this](https://evil.example) <b>now</b> | ok', person: 'Sam', count: 1 },
  ],
};

const bodies = () => [
  renderRunning(base),
  renderFinished({ ...base, result, verdict: 'Holds attention', check: { failBelow: 50, passed: true, percent: 60 } }),
  renderFinished({ ...base, result: { ...result, skimmed: null, headline: '7 of 10 understood it.' }, verdict: 'Holds attention', check: null }),
  renderStillRunning({ ...base, reportUrl: 'https://www.mimiqai.com/app/t/sess_1', progress: { done: 4, total: 10 }, minutes: 8, check: { failBelow: 50, passed: null } }),
  renderAudienceReview({ ...base, review: { reviewId: 'sess_r', summary: 'Mostly students.', fitRate: 0.4, warning: 'Results may describe the wrong customers.' } }),
  renderError({ ...base, message: 'This account is out of people credits.' }),
];

test('every comment carries the marker, says "simulated people" and ends with the honest line', () => {
  for (const body of bodies()) {
    assert.ok(body.startsWith(MARKER), 'marker first');
    assert.equal(body.trimEnd().split('\n').pop(), HONEST_LINE);
    assert.doesNotMatch(body, /\busers?\b/i, 'never "users"');
  }
  for (const body of bodies().slice(0, 5)) assert.match(body, /simulated (people|person)/);
});

test('no em dashes and no emojis, even when the simulated people used them', () => {
  for (const body of bodies()) {
    assert.doesNotMatch(body, /[\u2014\u2015]/);
    assert.doesNotMatch(body, /\p{Extended_Pictographic}/u);
  }
  assert.equal(cleanText('Fast \u2014 cheap \u{1F680}\u{1F680}'), 'Fast, cheap');
});

test('no AI model or vendor names in the copy', () => {
  for (const body of bodies()) assert.doesNotMatch(body, /\b(claude|anthropic|openai|gpt|gemini|llama|mistral|bedrock|llm|language model)\b/i);
});

test('the finished comment gives the verdict, the counts, the doubts and the report link', () => {
  const body = bodies()[1];
  assert.match(body, /### Mimiq: Holds attention/);
  assert.match(body, /\*\*6 of 10 simulated people would stay\*\*/);
  assert.match(body, /\| 6 \| 1 \| 3 \|/);
  assert.match(body, /"I can\u2019t tell what it costs, at all" \(Maya and 2 others\)/);
  assert.match(body, /\[Open the full report\]\(https:\/\/www\.mimiqai\.com\/app\/t\/sess_1\)/);
  assert.match(body, /Check: passed\. 60% would stay; the bar is 50%\./);
  assert.match(body, /Audience: seed-stage founders\./);
  assert.match(body, /Goal: join the waitlist\./);
  assert.match(body, /Commit abcdef1/);
});

test('the report-only shape shows "Skimmed or left" and Mimiq\'s read', () => {
  const body = bodies()[2];
  assert.match(body, /\| Would stay \| Skimmed or left \|/);
  assert.match(body, /\| 6 \| 3 \|/);
  assert.match(body, /Mimiq's read: 7 of 10 understood it\./);
});

test('quoted words cannot inject links, HTML or mentions', () => {
  const body = bodies()[1];
  assert.doesNotMatch(body, /@everyone/);
  assert.doesNotMatch(body, /\[this\]\(https:\/\/evil/);
  assert.doesNotMatch(body, /<b>/);
  assert.match(mdText('a|b'), /a\\\|b/);
});

test('the page link drops the query and fragment, which can hold access tokens', () => {
  for (const body of bodies()) assert.doesNotMatch(body, /SECRET|protection-bypass/);
  assert.equal(pageLink('https://preview.example.com/'), '[preview.example.com](https://preview.example.com/)');
});

test('still running and paused comments explain what happened', () => {
  const [, , , running, review] = bodies();
  assert.match(running, /still visiting .* after 8 minutes\. 4 of 10 have reacted so far\./);
  assert.match(running, /\[Open the report\]\(https:\/\/www\.mimiqai\.com\/app\/t\/sess_1\) to see it\./);
  assert.match(running, /Check: not evaluated/);
  assert.match(review, /did not match the audience you described, so the test did not run/);
  assert.match(review, /Audience fit: 40% verified\./);
});
