# Local extraction harness

Run the punch list extractor against a PDF from your laptop — no Azure, no
deployment. Use it to judge extraction quality on a real owner's document before
committing to the setup, and afterwards whenever a new owner's format shows up.

It imports the shipped code rather than reimplementing it: the same
`dashboard/photo-detect.js` the browser uses and the same `api/src/lib/extract.ts`
prompt and schema the deployed endpoint uses. What you see here is what the app
produces.

## Setup

```bash
cd api && npm install && npm run build   # the harness imports api/dist
cd ../tools/extract-cli && npm install
```

`@napi-rs/canvas` ships prebuilt binaries — nothing compiles, and no system
packages are needed.

## Use

```bash
# free: rendering + photo detection only, no API calls
node run.mjs ~/Downloads/punchlist.pdf --no-ai --out /tmp/crops

# the real thing
ANTHROPIC_API_KEY=sk-ant-... node run.mjs ~/Downloads/punchlist.pdf

# one page, with the crops written out so you can look at them
ANTHROPIC_API_KEY=sk-ant-... node run.mjs punchlist.pdf --pages 2 --out /tmp/crops

# full run, saved for comparison against a later change
ANTHROPIC_API_KEY=sk-ant-... node run.mjs punchlist.pdf --json /tmp/result.json
```

| Option | |
|---|---|
| `--no-ai` | Render and detect photos only. Costs nothing. Start here. |
| `--pages 2` or `--pages 3-7` | Just those pages. |
| `--out DIR` | Write page renders and cropped photos, to check the crops by eye. |
| `--json FILE` | Full structured result. |

It reads `ANTHROPIC_API_KEY` for the direct API, or the `ANTHROPIC_FOUNDRY_*`
settings to test the Foundry path — the same resolution the deployed app uses.

## Reading the output

```
page  2  items   3 item(s)  6 image region(s)  2 discarded as page furniture  8421ms
     #1  Water heater not working [Mechanical] (1 photo)
     #2  Kinetico not hooked up [Mechanical] (2 photo)
     #3  Seal all holes [Mechanical] (1 photo)
```

The marker before each item is its confidence: blank for high, `?` for medium,
`!` for low. A `!` row is one the review screen flags in amber.

The summary line checks the owner's own numbering for gaps. If a 59-item list
comes back numbered 1–59 with no holes, the read is almost certainly complete —
that is the cheapest signal that no page was skipped or misread.

## What it does not cover

Nothing here touches Procore. It proves the reading half only; creating punch
items still needs the deployed app, because that is where the Procore
credentials live.
