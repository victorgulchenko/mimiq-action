# Mimiq page test

Test every preview deploy on simulated people, before real ones see it.

When a pull request gets a preview deployment (Vercel, Netlify, or any public URL), this Action shows the page to a small crowd of simulated people with [Mimiq](https://www.mimiqai.com) and posts **one** pull request comment, updated on every run:

- the verdict (Holds attention, Mixed, Loses most or Losing them);
- how many simulated people would stay, skim or leave;
- their top doubts, in their own words;
- a link to the full report in Mimiq.

It runs only on the trigger you configure, never on every push by default, because every run spends your Mimiq credits.

## Quick start (Vercel previews)

1. Get a Mimiq API key (see below) and save it as a repository secret named `MIMIQ_API_KEY`.
2. Add `.github/workflows/mimiq.yml`:

```yaml
on: deployment_status
permissions: { pull-requests: write, contents: read }
jobs:
  mimiq:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: victorgulchenko/mimiq-action@v1
        with:
          api-key: ${{ secrets.MIMIQ_API_KEY }}
```

That is all. Each successful preview deploy of an open pull request gets tested on 10 simulated people, and the pull request gets one comment that updates in place. Add `audience: founders choosing an analytics tool` under `with:` to say who your visitors are; without it, Mimiq picks the likely audience from the page.

Netlify and other hosts that report deployments to GitHub work the same way.

## Get an API key

1. Create a free account at [www.mimiqai.com/sign-up](https://www.mimiqai.com/sign-up?redirect_url=/app/settings).
2. Open [Settings](https://www.mimiqai.com/app/settings), find **"Use Mimiq from your coding agent"**, and choose **Create a key**. The key starts with `mq_sk_` and is shown once.
3. In your repository, go to Settings, Secrets and variables, Actions, and add it as `MIMIQ_API_KEY`.

The Action masks the key in the log and never writes it to the comment, the job summary or the outputs.

## Other triggers

**Only when you ask, with a label.** Add the label `mimiq` to a pull request to test its preview. The Action finds the URL from the newest successful deployment of the pull request's head commit, which needs `deployments: read`:

```yaml
on:
  pull_request:
    types: [labeled]
permissions: { pull-requests: write, contents: read, deployments: read }
jobs:
  mimiq:
    if: github.event.label.name == 'mimiq'
    runs-on: ubuntu-latest
    steps:
      - uses: victorgulchenko/mimiq-action@v1
        with:
          api-key: ${{ secrets.MIMIQ_API_KEY }}
          audience: parents shopping for school shoes
```

**By hand, on any URL.**

```yaml
on:
  workflow_dispatch:
    inputs:
      url: { description: Page to test, required: true }
permissions: { pull-requests: write, contents: read }
jobs:
  mimiq:
    runs-on: ubuntu-latest
    steps:
      - uses: victorgulchenko/mimiq-action@v1
        with:
          api-key: ${{ secrets.MIMIQ_API_KEY }}
          url: ${{ inputs.url }}
```

If the dispatched commit belongs to an open pull request, the result goes to its comment; otherwise it goes to the job summary and the outputs.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `api-key` | (required) | Your Mimiq API key. Pass it from a secret. |
| `url` | from the event | The page to test. On `deployment_status` it uses the status's `environment_url`, then `target_url`. Otherwise it looks up the newest successful deployment of the commit. |
| `audience` | Mimiq picks | Who the visitors are, in plain words. Up to 500 characters. |
| `goal` | none | What the page should get people to do, for example `join the waitlist`. Up to 500 characters. |
| `people` | `10` | How many simulated people visit. Hard maximum **25**, enforced in code: a larger value runs 25, with a warning. This caps what one run can spend. |
| `fail-below` | off | Fail the check when fewer than this percentage would stay, for example `50`. |
| `comment` | `true` | Post or update the pull request comment. |
| `timeout-minutes` | `8` | How long to wait for the result. After that the comment says the test is still running and links to the report, which fills in when it finishes. |
| `github-token` | `${{ github.token }}` | Used to find the pull request, read deployments and write the comment. |

## Outputs

| Output | Value |
| --- | --- |
| `report-url` | Link to the full report in Mimiq. |
| `stayed` | How many simulated people would stay. Empty if the test had not finished in time. |
| `people` | How many simulated people reacted. Empty if the test had not finished in time. |
| `verdict` | `Holds attention`, `Mixed`, `Loses most` or `Losing them`; or `running`, `audience-mismatch`, `skipped` or `error`. |

Use them in later steps, for example `${{ steps.mimiq.outputs.stayed }}` after giving the step `id: mimiq`.

## Credits and limits

- **One credit per simulated person.** A run of 10 people uses 10 credits. The `people` cap of 25 means one run never spends more than 25.
- **It runs only when you say so.** On `deployment_status` it skips every status except `success`, and it skips deployments that have no open pull request (production deploys land there), so those spend nothing.
- **Every successful preview deploy is a run.** With the quick start, ten pushes to a pull request mean ten runs. Use the label trigger to test only when you ask.
- A run that fails on Mimiq's side is refunded. Waiting for a running test and reading its report are free.
- Buy more credits at [www.mimiqai.com/app/usage](https://www.mimiqai.com/app/usage).

## What to know

- **The page must be public.** Simulated people visit it like anyone on the internet. A preview behind a login, such as Vercel Deployment Protection, shows them the login page instead. Turn protection off for the previews you want tested, or point `url` at a public page.
- **Wrong crowd, no test.** If the simulated people Mimiq recruits do not match your `audience`, Mimiq pauses before the test. The comment says so and the verdict is `audience-mismatch`. Describe the audience more specifically and run again.
- **Long runs.** If the result is not ready within `timeout-minutes`, the comment links to the report and the step passes; `fail-below` is not checked for that run. When the result comes from the saved report after a long run, skimmed and left are shown together.
- **Forks.** Pull requests from forks get no secrets and a read-only token, so the Action cannot run or comment for them.
- **How to read it.** Simulated reactions are a first read on what confuses people, what they doubt and what would change their mind. They are not a forecast of real conversion.

## How it talks to Mimiq

The Action uses Mimiq's public MCP server at `https://mcp.mimiqai.com/mcp` (JSON-RPC 2.0 over Streamable HTTP), the same interface coding agents use, with your key as `Authorization: Bearer`. It runs `initialize`, sends `notifications/initialized`, calls `mimiq.test_page`, and if the test is still running, follows it with `mimiq.show_report` (which spends no credits) until it finishes or `timeout-minutes` passes. It has no runtime dependencies: plain Node.js and `fetch`.

## Development

```bash
npm test
```

The tests use Node's built-in test runner against local mock servers; they never call Mimiq.

## License

MIT. See [LICENSE](LICENSE).
