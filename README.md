# Punch List Assistant

Turns an owner's punch list PDF into Procore punch items, with the photos attached.

A superintendent picks the project, uploads the PDF the owner sent, reviews what
was read off it, and presses send. Today that same work is retyping every item
into Procore by hand — a 59-item list like the Darden example described in `docs/README.md` is an
afternoon.

---

## How it works

```
Owner's PDF (usually a scan — no text layer)
   │
   ▼  browser: pdf.js renders each page, finds and crops the photos
Page image + photo positions
   │
   ▼  POST /api/extract — Claude reads the page, returns structured items
Draft punch items
   │
   ▼  the superintendent reviews and corrects every row      ← the point of the app
Approved items
   │
   ▼  POST /api/push — creates punch items, attaches photos
Procore punch list
```

### Why the PDF is processed in the browser

Rendering a PDF page to a bitmap needs pdf.js and a canvas. SWA managed
Functions cannot install native packages and cap a deployment at ~15,000 files,
so putting it server-side would be a fight. The browser already has a canvas.
It also means a 40 MB punch list never leaves the superintendent's device —
only the rendered pages and cropped photos do.

### Why one page per request

SWA managed Functions hard-stop a request at **45 seconds**. A whole document in
one call would time out and lose the work. Page-at-a-time gives real progress,
and one failed page can be retried on its own — click the red page number.

### Why the review step is not optional

Everything before the review is a model reading a scan. Everything after it is a
live write into a real project that dispatches subcontractors. Items read with
low confidence are flagged **Check this** in amber, and nothing is created that a
person did not look at.

---

## Setup

### 1. Azure resources

Create a Static Web App (Standard tier is not required). Point it at this repo:

- **app_location:** `dashboard`
- **api_location:** `api`
- **output_location:** *(empty)*

Add the deploy token to the repo as the secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.

### 2. Entra sign-in

`staticwebapp.config.json` requires an authenticated user for every route. Create
an Entra app registration with redirect URI
`https://<swa-host>/.auth/login/aad/callback`, add a client secret, then set
`AAD_CLIENT_ID` and `AAD_CLIENT_SECRET` in the SWA app settings. The tenant id is
already pinned in the config to Buffalo's tenant.

There is no admin/view-only split — anyone who can sign in can import. Every push
is logged with the signer's email, and each created item carries the source
document name in its `reference` field.

### 3. App settings

| Setting | Required | Purpose |
|---|---|---|
| `AAD_CLIENT_ID` | yes | Entra sign-in |
| `AAD_CLIENT_SECRET` | yes | Entra sign-in |
| `PROCORE_CLIENT_ID` | yes | Procore OAuth (client credentials) |
| `PROCORE_CLIENT_SECRET` | yes | Procore OAuth |
| `PROCORE_COMPANY_ID` | yes | `18895` for BCI |
| `ANTHROPIC_FOUNDRY_RESOURCE` | yes | Azure AI Foundry resource name — the first label of the endpoint host. For `1coryzilisch-resource.services.ai.azure.com`, this is `1coryzilisch-resource`. |
| `ANTHROPIC_FOUNDRY_API_KEY` | yes | Key from that resource's **Keys and Endpoint** page |
| `PUNCH_EXTRACT_MODEL` | yes | The Claude model deployed in the resource. **No default on Foundry** — the id depends on what you deployed. |
| `PUNCH_EXTRACT_EFFORT` | no | Defaults to `medium`. A latency control for the 45s function limit, not a cost dial. Only sent to models that accept it. |
| `PUNCH_EXTRACT_REASONING` | no | `auto` (default), `adaptive`, or `basic`. See **Choosing a model**. |
| `ANTHROPIC_API_KEY` | no | Local-development fallback only. Ignored when the Foundry settings are present. |
| `PUNCH_AI_PROVIDER` | no | Force `foundry` or `anthropic`. Only needed to override the automatic choice. |

The same Procore credentials the Safety Dashboard uses live in Key Vault as
`procore-client-id` / `procore-client-secret` / `procore-company-id`.

### Where Claude runs

Production uses **Claude on Microsoft Foundry** — the model runs against
Buffalo's own Azure AI Foundry resource and bills through the Microsoft
Marketplace at standard API rates, so this app never depends on a personal
Anthropic key. Setting `ANTHROPIC_FOUNDRY_RESOURCE` is what selects it; the
direct Anthropic API is a local-development fallback and loses whenever the
Foundry settings are present.

Requests go to `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
with the key in an `x-api-key` header. That is the same Foundry resource that
serves the GPT deployment behind Roman — Claude is an additional deployment in
it, not a separate resource.

### 4. Deploy Claude in Azure AI Foundry

In the [Azure AI Foundry portal](https://ai.azure.com), with the same resource
that already serves the GPT deployment selected:

1. **Model catalog** → search **Claude** → pick the model you want to run.
2. **Deploy**. The first Claude deployment in a subscription asks you to accept
   an Azure Marketplace offer — that is the billing agreement that keeps this on
   company spend rather than a personal key. Someone with permission to accept
   Marketplace purchases on the subscription has to do this step.
3. Note the **deployment name** — that is the value for `PUNCH_EXTRACT_MODEL`.
   Do not assume it matches the first-party model id.
4. **Keys and Endpoint** on the resource → copy a key into
   `ANTHROPIC_FOUNDRY_API_KEY`, and the first label of the endpoint host into
   `ANTHROPIC_FOUNDRY_RESOURCE`.

Verify before wiring the app — this proves the resource, key and deployment name
all agree, and it needs nothing but curl:

```bash
curl -sS https://<resource>.services.ai.azure.com/anthropic/v1/messages \
  -H "x-api-key: <key>" \
  -H "content-type: application/json" \
  -d '{"model":"<deployment-name>","max_tokens":16,
       "messages":[{"role":"user","content":"say ok"}]}'
```

A `404` almost always means the deployment name is wrong; a `401`/`403` means the
key belongs to a different resource. Once that returns a message, set the three
app settings and open the app — the **Connection check** on step 1 runs the same
request shape the extractor uses, including structured output and thinking, and
says which of the three is wrong if any.

### Choosing a model

`PUNCH_EXTRACT_MODEL` takes any Claude model. The default is `claude-opus-5`.

**Cost is not the deciding factor.** Measured shape of one page: roughly 4,300
input tokens (a 150 DPI page image is ~2,500 of those) and ~1,200 output. For the
59-item, 17-page reference document that is about 73K input and 20K output, which
comes to roughly:

| Model | Rate (in / out per MTok) | That document |
|---|---|---|
| `claude-opus-5` | $5 / $25 | ~$0.90 |
| `claude-sonnet-5` | $3 / $15 | ~$0.55 |
| `claude-haiku-4-5` | $1 / $5 | ~$0.20 |

The spread is about seventy cents per punch list, against an afternoon of a
superintendent's time. Pick on accuracy and latency, not price. The CLI harness
prints real token counts, so you can compute your own rather than trust the
estimate above.

**The arguments that do matter.** Haiku is faster, which buys margin against the
45-second function ceiling on dense pages. Against that, this is careful-reading
work on degraded scans — transcribing verbatim, telling a blank field from its
printed label, keeping photos on the right row — and it feeds subcontractor
dispatch, so a wrong row costs a trip to the site. Which way that trades is an
empirical question about *your* documents, so measure it:

```bash
cd tools/extract-cli
for m in claude-opus-5 claude-sonnet-5 claude-haiku-4-5; do
  ANTHROPIC_API_KEY=... node run.mjs punchlist.pdf --model $m --json /tmp/$m.json
done
```

Compare item counts, gaps in the owner's numbering, and how many rows come back
flagged. If a cheaper model matches on your owners' formats, take it.

**Reasoning parameters are gated on the model.** `thinking: {type:'adaptive'}`
and `output_config.effort` arrived with the 4.6 generation and are *rejected with
a 400* by Haiku 4.5 and Sonnet 4.5 — not ignored. The extractor therefore sends
them only to models that accept them, so switching models is a one-setting change
rather than an outage. On Foundry the model id is a deployment name that may not
identify the model (`punch-list-prod`), so an unrecognized id falls back to the
plain request; set `PUNCH_EXTRACT_REASONING=adaptive` to force them on for a
custom-named deployment of a modern model, or `basic` to force them off.

### 5. Procore permissions

The service account needs the **Punch List** tool at a permission level that can
create items on the projects being imported into — reading is not enough. Check a
project before trusting it: pick it in step 1 and read the **Connection check**
card, or call `GET /api/probe?project_id=<id>` directly.

---

## First run on a new project

Procore's punch list is heavily tenant-configurable: which fields are required is
set per company in the Punch List tool's configuration, not by the API. This code
deliberately does not hardcode a required-field list. Instead:

1. On the send step, press **Preview payloads** — a dry run that shows exactly
   what would be sent and creates nothing.
2. Select **one** item and send it for real.
3. If Procore rejects it, the error row shows Procore's own field-level message
   (`punch_item_manager_id can't be blank`, and so on). Set that field on the
   review step and send again.
4. Once one item goes through, send the rest.

`punch_item_manager_id` and `final_approver_id` are required in most tenants,
which is why the review step warns when they are unset.

---

## Development

```bash
cd api
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc -> dist/
npm test              # node --test
```

The dashboard has no build step — it is static files plus a vendored pdf.js (see
`dashboard/vendor/README.md`). Validate its scripts with:

```bash
node --check dashboard/app.js       # copy to .mjs first; they are ES modules
```

### Testing extraction without deploying

`tools/extract-cli` runs the extractor against a PDF from the command line,
using the same detector and the same prompt as the deployed app. Use it to judge
quality on a real document before standing up Azure, and whenever a new owner's
format turns up:

```bash
cd tools/extract-cli && npm install
node run.mjs ~/Downloads/punchlist.pdf --no-ai --out /tmp/crops   # free
ANTHROPIC_API_KEY=sk-ant-... node run.mjs ~/Downloads/punchlist.pdf
```

See `tools/extract-cli/README.md`. It lives outside `api/` so its PDF and canvas
dependencies never ride along into the Static Web App deployment.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness plus which integrations are configured |
| `GET /api/me` | Signed-in user, for attribution |
| `GET /api/projects` | Procore projects, read live (not from the Fabric mirror) |
| `GET /api/projects/{id}/config` | Punch item types, locations, trades, vendors, users |
| `GET /api/probe?project_id=` | Plain-language readiness check |
| `POST /api/extract` | Read one page |
| `POST /api/push` | Create a batch of punch items (`dryRun` supported) |

Projects are read straight from Procore rather than through the Fabric mirror the
Safety Dashboard uses. The mirror is a nightly snapshot — right for reporting,
wrong here, because a punch walk often happens on a project set up that morning
and the ids we write against must be current.

---

## Known limits

- **Photo detection is a heuristic.** It scores regions by tone distribution and
  colour, which separates photographs from text reliably; it was verified against
  every page of the reference document. Genuinely novel layouts may need the
  thresholds in `dashboard/pdf-pipeline.js` revisited. Wrong photos can be removed
  per item in the review step.
- **Extraction quality is unverified against a live model.** The photo detector
  is verified end to end against every page of the real reference document, and
  detection and photo-pairing are unit-tested — but no page has been through a
  live model yet. `tools/extract-cli` is the fastest way to close that gap: it
  needs only an API key, no deployment.
- **Structured outputs and adaptive thinking are beta on Foundry**, and GA only on
  the first-party API. The extractor depends on both. If a Foundry deployment
  rejects them, the Connection check says so explicitly rather than failing
  mid-document, and the fix is to express the schema as a tool instead of
  `output_config` — contained to `api/src/lib/extract.ts`.
- **Nothing is persisted.** An import lives in the browser tab until it is pushed.
  Closing the tab mid-review loses the work (you get a warning first). If supers
  start wanting to hand a half-finished review to someone else, that is when to
  add storage.
- **No duplicate detection.** Uploading the same PDF twice creates two sets of
  punch items. Items that succeed are unchecked automatically so pressing send
  twice in one session is safe, but a re-upload is not.
