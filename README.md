# KFintech client_id watcher

Loads `https://ipostatus.kfintech.com/` in a headless browser, captures the
company-name / `client_id` mapping that gets printed to the browser console on
page load, and diffs it against the last saved snapshot so you know exactly
what's new or changed.

## Setup

```bash
npm install       # also downloads a Chromium build for Playwright
npm run check
```

That prints a report to the terminal, and updates:

- `data/client-id-map.json` — the latest known company -> client_id mapping
- `data/history/<timestamp>.json` — a snapshot of every run, for an audit trail

Run it again later (or on a schedule) and it'll tell you only what changed
since the last run.

## If it finds nothing on the first run

The extraction logic (`extractPairs` / `extractPairsFromText` in `watch.mjs`)
guesses at the shape of the logged data — an array of `{company, client_id}`
objects, a plain `{ "Company": "12345" }` object, or loose text lines like
`Company Name: 12345`. If the real structure doesn't match any of these, the
script prints the raw captured console text so you can see the actual shape
and adjust the matching logic. You can also run:

```bash
HEADLESS=false npm run check
```

to watch the page load in a visible browser window while you check devtools
yourself.

## Automating it

`.github/workflows/watch.yml` runs this on a schedule (daily by default) via
GitHub Actions and commits the updated `data/` files back to the repo when
something changes — no server of your own required. Push this project to a
GitHub repo and it starts working; adjust the cron schedule in the workflow
file as needed.

### Optional: get notified

Set a repo secret `WEBHOOK_URL` (e.g. a Slack incoming webhook URL) and the
workflow will POST a message listing any new or changed entries after each
run. Locally, you can do the same with:

```bash
WEBHOOK_URL="https://hooks.slack.com/..." npm run check
```

## Using this alongside the PAN status checker app

Once you're confident in the mapping, you could:

- Have the React app fetch `data/client-id-map.json` (e.g. host it as a raw
  GitHub URL, or copy it into the app's `public/` folder) and turn the
  Client ID text input into a dropdown of company names.
- Or keep it manual — this watcher's job is just to tell you when a new
  company/client_id pair shows up so you know to add it.
