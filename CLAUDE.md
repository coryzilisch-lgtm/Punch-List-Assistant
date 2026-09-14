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
not that the data is missing.

**✅ Answered by the live tenant, 2026-09-14 (project 603781):**

| List | The path that works | Rows |
|---|---|---|
| Trades | `GET /rest/v1.0/companies/{company}/trades` — **nested** | 190 |
| Vendors | `GET /rest/v1.0/projects/{project}/vendors` — **project-scoped** | 30 |

**They are mirror images, and that is the whole lesson.** Trades works nested and
404s flat (`/trades?company_id=`, `/trades?project_id=`, `/projects/{id}/trades`,
and the v1.1 nested form all 404). Vendors 404s nested (`/companies/{id}/vendors`)
and works project-scoped *and* flat with `company_id=`. Whichever rule you infer
from one, the other breaks it. There was no reasoning available here — only
asking.

**So the app does not hold an opinion about the path. It asks.**
`listCandidates()` holds five candidates per list, each tagged `scope`;
`resolveList()` pages them in order and keeps the one that answers **with rows**.
The confirmed winners lead, so steady state is one request per list. This is the
candidate-chain-with-memory pattern the write path already uses, applied to
reads, where it is far cheaper: every candidate is a GET that changes nothing,
and the answer verifies itself, because a list of `{id, name}` rows *is* the
contract.

Five properties are load-bearing and must survive any refactor:

1. **A 200 with an empty array does not win the chain.** It is remembered and
   discovery continues; it only becomes the answer if nothing returns rows.
2. **"Reachable but empty" and "no path answered" are reported differently.** The
   first is a tenant with no Trades defined — a configuration choice. The second
   is a broken integration.
3. **A transient failure records no verdict.** A 429 or 5xx aborts discovery and
   is retried; writing it down as "this path does not exist" is the mistake the
   send chain already made once, which poisoned every later item in a push.
4. **One deadline covers the whole chain**, not one per candidate — five × 12s is
   sixty seconds against a 45-second ceiling. The remaining budget never reaches
   `0`, because `paginateWithBudget` reads `0` as *unlimited*.
5. **The probe imports the same candidate list.** A probe with a private copy can
   pass while the app still fails.

### `onProject` comes from the PATH, not the directory

⚠️ **The first version got this backwards, and the live probe caught it.** The
plan was to read the subs on a job off `/projects/{id}/users`. On project 603781
that directory is **Buffalo's own staff** — every row resolves to Buffalo
Construction Inc. — so the flag landed on the **general contractor** and floated
it to the top of the picker, above the 30 subs a punch item actually gets
assigned to.

`/projects/{id}/vendors` is already the subs on this job, so scope is read off
the winning candidate: a project-scoped path marks every row `onProject`. The
directory is a supplement only — it adds a company the vendor list missed, and it
marks rows when the only list available is company-wide. `vendorsFromDirectory()`
keeps **only companies carrying a numeric Procore vendor id**; a name cannot be
sent, and another system's id would assign the item to the wrong company
silently.

### The Vendor Compliance list in Fabric — reported, and not needed

Vendor lists are being maintained in the Vendor Compliance database. They are
**not** wired into the picker, and after 2026-09-14 they do not need to be:
Procore's own `/projects/{id}/vendors` returns the subs on the job, carries
Procore's ids by definition, and is live rather than a nightly mirror.

The probe still reports them so the option stays open. Note that
`FABRIC_SQL_DATABASE` points at **herd-intranet**, which holds no vendor tables —
the compliance roster lives in the **Safety-Dash** database, so the probe needs
**`PUNCH_VENDOR_SQL_DATABASE`** set to see it (same server, same service
principal, different catalog).

The probe does not ask whether a column *looks like* a Procore id. It intersects
the column's values with the vendor ids Procore just returned for the project
(`matchedProcoreVendorIds`). A column whose values **are** those ids is Procore's
key, proven. `looksLikeProcoreId` rules a column **out**; it never rules one in —
a five-digit sequence from another system is indistinguishable by shape and
points at the wrong company.

## The Procore rate budget

Procore allows ~3,600 requests/hour and the limit is **company-wide**. This app's
service account is the same one the Safety Dashboard's nightly ingest uses, so
the budget is shared: a burst here can be throttled by work nobody in this app
started, and vice versa. Measured, not asserted — `/api/probe` and
`/api/inspect` both report `requests`, the count for that invocation.

**Selecting a project: 34 requests → 7** (measured against live-shaped data: 190
trades, 30 vendors, 5 types, 40 locations, a 214-person directory, 800 punch
items).

| Fix | Why it was costing |
|---|---|
| The probe returns the config | The dashboard called `/api/projects/{id}/config` **and** `/api/probe` in parallel, and the probe built its own copy of the same ~7 requests. One round trip now. |
| `punchItemAccess()` for the read check | The check paged **every** punch item to print a count in a sentence — 9 requests to answer yes/no. One request, with `Total` from the header. |
| `cached()` with in-flight dedup | Two endpoints wanting the same thing at the same moment share one fetch. A result cache alone could not help: neither call had finished when the other started. |
| Page size 1000 on the list reads | 190 trades and a 214-person directory were 5 requests at 100 a page. |
| Discovery pages candidates directly | It used to probe with `per_page=1` and then re-fetch the winner — double cost for the common case. |

Three rules that keep it honest:

1. **A failure is never cached.** Caching one turns a transient 429 into a
   guaranteed minute of failure — the same mistake the write chains make when
   they record a rate limit as a broken contract. `ProjectPunchConfig.degraded`
   exists for the harder version of this: the config never *rejects* (each lookup
   softens to an empty list), so a rate-limited load looks like a good answer to
   a cache and would be served for ten minutes.
2. **⚠️ Never end pagination on `rows.length < perPage` alone.** That reads the
   SERVER's page size as if it were ours: ask for 1000 from an endpoint capped at
   100 and the first short page looks like the end, silently truncating an
   800-item punch list to its first 100 — a wrong answer delivered as a complete
   one. `paginateWithBudget` follows Procore's **`Total`** header when present
   and only falls back to the row count when it is absent. That is what makes
   asking for a big page safe.
3. **`listPunchItems()` is the most expensive read in the app.** Only the
   recovery sweep and the inspect survey need every row. Anything asking "can we
   read this" wants `punchItemAccess()`.

**A push is ~2 requests per item, or ~4 with send** (create, read-back, and for a
send: the workflow write plus its read-back). That is deliberately NOT optimised.
The read-backs are the safety property — Procore has answered 200 and stored
nothing three times — and trading them for rate would reintroduce exactly the bug
class this repo has already paid for. A 60-item list with send is ~240 requests,
which is fine against 3,600/hour; the thing to avoid is running one during the
Safety Dashboard's nightly ingest.

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

- ~~Run the lists probe~~ **done 2026-09-14** — trades and vendors both resolve,
  190 and 30 rows. Two lookups came back **429** in that run (Locations, Project
  users) because the probe fires its candidate sweep and a full config load at
  once; the control call read a location successfully in the same response, so
  nothing is wrong with them. Discovery now pages candidates directly instead of
  probing then re-fetching, which removes one request per list.
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
