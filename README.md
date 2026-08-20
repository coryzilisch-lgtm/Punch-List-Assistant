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
| `ANTHROPIC_API_KEY` | yes | Reading the documents |
| `PUNCH_EXTRACT_MODEL` | no | Defaults to `claude-opus-5` |
| `PUNCH_EXTRACT_EFFORT` | no | Defaults to `medium`. A latency control for the 45s function limit, not a cost dial. |

The same Procore credentials the Safety Dashboard uses live in Key Vault as
`procore-client-id` / `procore-client-secret` / `procore-company-id`.

### 4. Procore permissions

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
- **Extraction quality is unverified against a live model.** The photo-pairing
  logic is unit-tested and the detector is verified against the real document, but
  no page has been through the actual API yet — that needs a deployment with
  `ANTHROPIC_API_KEY` set. Run the Darden list as the first test — see
  `docs/README.md`.
- **Nothing is persisted.** An import lives in the browser tab until it is pushed.
  Closing the tab mid-review loses the work (you get a warning first). If supers
  start wanting to hand a half-finished review to someone else, that is when to
  add storage.
- **No duplicate detection.** Uploading the same PDF twice creates two sets of
  punch items. Items that succeed are unchecked automatically so pressing send
  twice in one session is safe, but a re-upload is not.
