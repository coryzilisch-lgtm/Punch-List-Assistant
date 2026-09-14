# Punch List Assistant — Claude Code context

> **New session? Read this first, then `docs/SETUP.md` for anything operational
> and `docs/procore-oauth.md` before touching who items are created by.**

## What this is

A superintendent picks a Procore project, uploads the punch list PDF the owner
sent, reviews what was read off it, and presses send. The app creates the punch
items in Procore with their photos attached. The work it replaces is retyping
59 items by hand — an afternoon per list.

```
Owner's PDF (a scan, no text layer)
  │  browser: pdf.js renders each page, finds + crops the photos
  ▼
POST /api/extract   one page per request — Claude reads it, returns structured items
  ▼
the superintendent reviews and corrects every row        ← the point of the app
  ▼
POST /api/push      creates punch items, attaches photos, optionally sends them
  ▼
Procore punch list
```

Deployed to Azure Static Web Apps on push to `main`:
**nice-grass-0ac50c20f.6.azurestaticapps.net**. Entra sign-in gates the whole app.

---

## 🛑 The rule that overrides everything else

**Never guess a Procore contract. Make the tenant answer.**

`developers.procore.com` **and** its `procore.github.io` mirror are both blocked
by this build environment's egress proxy (CONNECT answered 403). Every Procore
detail in this repo was therefore inferred from search snippets, and that
inference has been wrong three separate times — each time Procore answered
**200** and stored **nothing**, because Rails filters unpermitted parameters
silently and does not tell you that you misnamed a key.

So:

- **Never trust a 2xx.** Read the record back and report what Procore actually
  stored. A write that "succeeds" without a read-back is unverified.
- **`GET /api/inspect` is the tool for this.** It is strictly read-only and
  exists precisely so nobody has to guess. Extend it rather than guessing.
- **A count of zero is never evidence on its own.** An empty tenant, a
  permission-filtered endpoint and a row-dropping filter look identical from
  outside.
- **A 200 with an empty array is not a working endpoint.** This is how the
  curated project team hid for two sessions in the sibling repo.

---

## Settled facts — do not re-derive these

| Fact | Detail |
|---|---|
| `workflow_status` is the Draft/Initiated field | `draft` → `initiated` → … → `closed`. **`status` is `Open`/`Closed`** and says nothing about the workflow. The first send step gated on `status === 'draft'`, so it never ran and reported nothing. |
| The assignee key is `login_information_id` | **Not** `assignee_id`. The obvious name is the wrong one, accepted and filtered out. Locked down by a test in `api/test/punch-payload.test.mjs`. |
| The photo file part is `punch_item[attachments][]` | **Not** `images[]` — `images` is an empty array even on items that have photos. `has_attachments` is the boolean to trust; `web_images` mirrors `attachments`. |
| Ball-in-court is derived, never writable | A **Draft** sits with its **creator**; an **initiated** item with its **assignee**. Naming a punch item manager does not move it (item #274 proves it). |
| The service account cannot act as a user | All four candidate impersonation headers returned 200 and Procore still saw the service account. Probed and confirmed. Per-user OAuth is the only remaining route — `docs/procore-oauth.md`. |
| Running the app inside Procore was decided against | Reasoning in `docs/SETUP.md`. The iframe and *acting as a user* are independent problems; do not conflate them. |
| Procore has no validate-only mode for punch items | The only way to test a write is to create a real one. Hence: preview payloads, then push exactly one item. |

The tenant: company `18895`, service account `abs-api-export-b171139a@procore.com`,
which is **shared with the Safety Dashboard ingest** — so its ~3,600/hour rate
limit is shared too, and a push can be throttled partway by somebody else's
nightly sync.

---

## Repo layout

```
api/                            SWA managed Azure Functions (v4 node, TypeScript)
  src/lib/procore.ts            the Procore client: auth, pagination, list discovery,
                                the punch-item write contract, the strategy chains
  src/lib/fabric.ts             Fabric SQL — the project mirror, and the vendor-table probe
  src/lib/extract.ts            page → structured items (schema + prompt)
  src/lib/model.ts              Anthropic API or Claude on Foundry; reasoning params
  src/lib/http.ts               guarded(), json(), errorResponse()
  src/functions/                one route per file
dashboard/                      vanilla JS SPA, no build
  app.js                        state, review screen, name combos, push
  pdf-pipeline.js               pdf.js render + page dispatch
  photo-detect.js               finds and crops the jobsite photos
tools/extract-cli/              run the extraction locally against a PDF, no Azure
docs/SETUP.md                   the runbook, and most of the hard-won Procore detail
docs/procore-oauth.md           acting as the superintendent instead of the robot
```

### Endpoints

| Route | Purpose |
|---|---|
| `GET /api/health` | config flags — `procoreConfigured`, `extractionConfigured`, provider, model |
| `GET /api/me` | signed-in identity from the SWA principal |
| `GET /api/projects` · `/{id}` · `/{id}/config` | the picker, and everything the review dropdowns need |
| `POST /api/extract` | one page → structured items |
| `POST /api/push` | create items (+ photos, assignees, optional send). `dryRun` previews payloads |
| `POST /api/resend` | finish items that were created but never sent — **creates nothing** |
| `GET /api/drafts` | imports that were created and never sent |
| `GET /api/probe?project_id=` | the connection check the app shows on step 1 |
| `GET /api/inspect` | the read-only truth probe — see below |

### `/api/inspect` modes

```
?project_id=123                  survey: enums, collections, objects, raw rows
?project_id=123&punch_item_id=N  dump one item verbatim
?project_id=123&lists=1          which list paths this tenant serves + vendor sources
?project_id=123&uploads=1        does the direct-upload flow exist here
?as_user=<procore user id>       can the service account act as a person (answer: no)
```

---

## How lists are resolved (trades, vendors) — Sept 2026

**The symptom was:** "Some dropdowns will be empty. Vendors unavailable (404);
Trades unavailable (404)". A 404 on a list endpoint means the **path** is wrong,
not that the data is missing — Procore is inconsistent about whether a
company-scoped collection is nested (`/companies/{id}/thing`) or flat with a
query parameter (`/thing?company_id=`).

**The app no longer holds an opinion about which is right. It asks.**
`listCandidates()` holds five candidates per list; `resolveList()` tries them and
keeps the one that answers **with rows**. This is the same
candidate-chain-with-memory pattern the write path already uses — applied to
reads, where it is far cheaper: every candidate is a GET that changes nothing,
and the answer verifies itself, because a list of `{id, name}` rows *is* the
contract.

Four properties are load-bearing and must survive any refactor:

1. **A 200 with an empty array does not win the chain.** It is remembered and
   discovery continues; it only becomes the answer if nothing returns rows.
2. **"Reachable but empty" and "no path answered" are reported differently.** The
   first is a tenant with no Trades defined — a configuration choice. The second
   is a broken integration. The old message could not tell them apart.
3. **A transient failure records no verdict.** A 429 or 5xx aborts discovery and
   is retried; writing it down as "this path does not exist" is the mistake the
   send chain already made once, which poisoned every later item in the push.
4. **The probe imports the same candidate list.** A probe with a private copy can
   pass while the app still fails.

Vendors additionally come **from this job first**: `/projects/{id}/users` already
works and every row carries the person's company, so `vendorsFromDirectory()`
takes the subs actually on site. They are merged with the company-wide list
rather than replacing it, and flagged `onProject` so the review screen floats
them to the top of the picker. **Only companies carrying a numeric Procore vendor
id are kept** — a name cannot be sent, and another system's id would assign the
item to the wrong company silently.

⚠️ **The Vendor Compliance Fabric list is reported by the probe and deliberately
NOT wired into the picker.** It is only usable if it carries *Procore's* vendor
id. `looksLikeProcoreId` rules a column **out**, never in; that judgement needs a
person who knows how that tool keys its rows. Point the probe at its database
with `PUNCH_VENDOR_SQL_DATABASE` if it is not the one `FABRIC_SQL_*` names.

---

## Known gotchas

- **SWA managed Functions are killed at 45 seconds**, with no error the app can
  catch — the browser just sees "Backend call failure". This shapes everything:
  one PDF page per request, `paginateWithBudget` on every list, a wall-clock
  budget on anything that chains calls. `PUNCH_EXTRACT_EFFORT=low` if a page
  times out.
- **SWA caps a deployment at ~15,000 files** and the error is the opaque "Failure
  during content distribution". Count **files**, not bytes. Check any new
  dependency's file count first — adding one SDK broke every Herd Intranet deploy
  for hours. This API has five runtime deps deliberately.
- **Key Vault references do not work in SWA app settings** for managed functions,
  and managed identity is unreliable in that sandbox. Secrets are pasted. ⚠️
  Rotating the Procore secret means updating **both** Key Vault (for the Safety
  Dashboard notebooks) and this app's settings.
- **`mssql`/`tedious` cannot connect to `*.datawarehouse.fabric.microsoft.com`.**
  Fabric **SQL Database** (`*.database.fabric.microsoft.com`) only. No driver
  option fixes it.
- **The deploy token secret is `AZURE_STATIC_WEB_APPS_API_TOKEN`** — deliberately
  *not* the `…_<NAME>` one Azure generates, whose name embeds a resource that may
  be deleted and recreated. Keep exactly one workflow file.
- **`X-Rate-Limit-Reset` is not reliably an epoch second.** Treating a
  seconds-from-now value as one gives a negative wait clamped to zero, and the
  retry fires immediately against a limit still in force. `rateLimitWaitMs` never
  returns less than the normal backoff.
- **A throttled push is not a failed import.** The items are in Procore with
  their photos. Use **Retry sending** (`POST /api/resend`) — pushing the list
  again duplicates everything that already landed.
- **Procore's punch list is one of the most tenant-configurable tools in the
  product.** Which fields are required is set per company, not by the API schema.
  Do not hardcode a required-field set; surface Procore's own error body.

---

## Verify before pushing

```bash
cd api && npx tsc --noEmit && npm test    # pretest runs tsc
node --check dashboard/app.js
```

Commit messages end with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## Open work

- **Run `GET /api/inspect?project_id=603781&lists=1`** and read `resolved`. The
  discovery above makes the app self-correcting, but the probe is what confirms
  which path this tenant serves and whether the project directory carries vendor
  ids. It also reports what the Vendor Compliance database holds, which is the
  one question a human still has to answer.
- **The service account's display name is blank in Procore**, which is why every
  imported item reads as "ABS abs-api-export-b171139a". Renaming it in Procore's
  directory is a two-minute fix with no code — but that account is **shared with
  the Safety Dashboard ingest**, so change it knowing that.
- **Items are created by the integration, not the superintendent**, so a Draft
  waits in a robot's court. Per-user OAuth is the route; the full design, the
  refresh-token rotation race it has to survive, and the Procore-side app
  registration are in `docs/procore-oauth.md`.
- **Claude on Foundry** — swap three settings when the Marketplace agreement
  lands (`ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `PUNCH_EXTRACT_MODEL`); no code change.
