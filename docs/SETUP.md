# Setup, start to finish

Ordered so that the things other people control start early, and so you prove the
app is worth deploying before you deploy it.

Rough timing: Step 0 is 15 minutes at your desk. Steps 1–5 are about an hour of
portal work. Step 6 is the real test.

---

## Step 0 — Prove the reading works, before touching Azure

No Azure, no deployment. This answers the only question that matters — does it
read a real owner's punch list correctly — using an Anthropic API key you already
have.

```bash
git clone https://github.com/coryzilisch-lgtm/Punch-List-Assistant.git
cd Punch-List-Assistant
git checkout claude/punch-list-procore-importer-49ajvz

cd api && npm install && npm run build && npm test
cd ../tools/extract-cli && npm install
```

Find the PDF and check the path printed is the right file. (Do not paste a
placeholder path — let the shell find it, or drag the file from Finder into the
terminal after `node run.mjs ` to paste its real path.)

```bash
PDF=$(ls ~/Downloads/*[Pp]unch*.pdf | head -1); echo "$PDF"
```

Free run first — rendering and photo detection only, no API calls:

```bash
node run.mjs "$PDF" --no-ai --out /tmp/crops
open /tmp/crops
```

Open `/tmp/crops` and look at the cropped photos. They should be the jobsite
photos, cleanly cropped. Expected on the Darden document: 70 image regions across
17 pages, page 1 zero.

Then one page for real:

```bash
ANTHROPIC_API_KEY=sk-ant-... node run.mjs "$PDF" --pages 2
```

Then the whole document:

```bash
ANTHROPIC_API_KEY=sk-ant-... node run.mjs "$PDF" --json /tmp/result.json
```

**What good looks like** on the Darden list: 59 items, `source numbering 1-59,
complete`, most items carrying a photo, and the header photo and App Store QR
badge reported as discarded page furniture rather than attached to items 1 and 3.

If the numbering has gaps, or items come back reworded rather than verbatim, stop
here and send me the output. Everything below is wasted effort until this is
right.

---

## Step 1 — Start the Procore permission request

Do this first because it may need someone else, and it is the single most likely
thing to block the last step.

The Procore service account (`abs-api-export-b171139a@procore.com`) needs the
**Punch List** tool at a permission level that can **create** items on the
projects you will import into. Read access is not enough, and it is granted per
permission template, so a project the account can read may still refuse a write.

There is no way to test this without writing — Procore has no validate-only mode
for punch items. Step 6 sends exactly one item as the test.

While you are in Procore, pick a **test project** to use in step 6. Ideally one
that is real but not politically sensitive if a few stray punch items appear on
it.

---

## Step 2 — Create the Static Web App

Azure portal → **Create a resource** → **Static Web App**.

| Field | Value |
|---|---|
| Resource group | Same one as Safety-Dash, or a new one |
| Name | `punchlist-swa` (anything) |
| Plan type | **Standard** |
| Region | Same region as your other apps |
| Deployment source | **GitHub** → this repo → branch `main` |

**Standard, not Free.** This app brings its own Entra registration, and custom
authentication is a Standard-plan feature — on Free you only get the
preconfigured providers and sign-in will not work.

**Azure writes its own workflow, and its defaults are wrong for this repo.**
On creation Azure commits `.github/workflows/azure-static-web-apps-<name>.yml`
to `main` and adds a matching `AZURE_STATIC_WEB_APPS_API_TOKEN_<NAME>` secret,
where `<NAME>` is generated from the app's own name.
Its generated build configuration defaults to:

```yaml
app_location: "./dashboard"
api_location: ""        # <- deploys NO API
output_location: "."    # <- wrong for a no-build static app
```

`api_location: ""` means the Functions are never deployed, so every `/api/*`
route 404s and the app loads as a shell with nothing behind it — a failure that
looks like a bug in the app rather than a deployment setting. Fix the file to:

```yaml
app_location: "./dashboard"
api_location: "api"
output_location: ""
```

Azure also omits the deployment token from the generated `close_pull_request_job`,
so that job fails on every PR close until you add
`azure_static_web_apps_api_token` to it. Both corrections are already applied to
the workflow in this repo.

**Keep exactly one workflow.** If a second workflow file is present, both deploy
on every push. This repo keeps Azure's generated file, because its token secret
already exists and is bound to the real resource; the hand-written one was
removed.

After it is created, note the **URL** (`https://<something>.azurestaticapps.net`).
You need it in step 3.

### Deployment token

The workflow in this repo reads a **resource-neutral** secret name,
**`AZURE_STATIC_WEB_APPS_API_TOKEN`** — not the `…_<NAME>` one Azure generates.
That is deliberate: Azure's generated name embeds the app's name, so deleting and
recreating the Static Web App leaves both the name and the token pointing at a
resource that no longer exists. The deploy then fails with

```
Reason: No matching Static Web App was found or the api key was invalid.
```

which reads like a bad credential rather than a stale reference, and costs an
afternoon. It cost one here.

So after creating the app:

1. Static Web App → **Overview** → **Manage deployment token** → copy.
2. GitHub → **Settings** → **Secrets and variables** → **Actions** → new secret
   named exactly **`AZURE_STATIC_WEB_APPS_API_TOKEN`** → paste.
3. Delete the `AZURE_STATIC_WEB_APPS_API_TOKEN_<NAME>` secret Azure created, so
   there is only one and nobody updates the wrong one later.

Recreating the app from then on is a one-secret value change with nothing in the
repo to touch.

---

## Step 3 — Entra app registration for sign-in

Azure portal → **Microsoft Entra ID** → **App registrations** → **New
registration**.

| Field | Value |
|---|---|
| Name | `Punch List Assistant` |
| Supported account types | **Single tenant** |
| Redirect URI | **Web** → `https://<swa-host>/.auth/login/aad/callback` |

Then, still in the registration:

1. **Authentication** → under *Implicit grant and hybrid flows*, tick **ID
   tokens**. Sign-in fails without it.
2. **Certificates & secrets** → **New client secret** → copy the **Value** column,
   not the Secret ID. The Secret ID is a GUID and using it produces
   `AADSTS700054`, which took a while to diagnose on a previous app.
3. **Overview** → copy the **Application (client) ID**.

No Graph permissions and no admin consent are needed — this registration only
proves who someone is. That is deliberate: it avoids the tenant consent wall that
`Tasks.ReadWrite` hit on the Herd Intranet.

If your tenant blocks users from registering applications, this is the one step
that needs IT.

---

## Step 4 — App settings

Static Web App → **Settings** → **Environment variables** → add each of these,
then **Save**.

| Name | Value |
|---|---|
| `AAD_CLIENT_ID` | Application (client) ID from step 3 |
| `AAD_CLIENT_SECRET` | The secret **Value** from step 3 |
| `PROCORE_CLIENT_ID` | Key Vault `procore-client-id` |
| `PROCORE_CLIENT_SECRET` | Key Vault `procore-client-secret` |
| `PROCORE_COMPANY_ID` | `18895` |
| `ANTHROPIC_API_KEY` | The key you tested with in step 0 |

**Optional but recommended — read the project list from Fabric.** Listing
projects from the Procore API is serial, paginated, and shares a ~3,600/hour
quota with the Safety Dashboard's ingest, inside a Function Azure kills at 45
seconds. Pointing it at the existing Fabric mirror makes it instant and costs
Procore nothing. Add these and the app switches over on its own; leave them out
and it uses Procore.

| Name | Value |
|---|---|
| `FABRIC_SQL_SERVER` | `54jvo5wifiiejghqbdvjkuwfay-rqmkwr6prz3uvivvev3rm3fgpa.database.fabric.microsoft.com` |
| `FABRIC_SQL_DATABASE` | The database holding the project mirror (`herd-intranet` or `Safety-Dash-…`) |
| `AZURE_CLIENT_ID` | Service principal with read access to it |
| `AZURE_CLIENT_SECRET` | |
| `AZURE_TENANT_ID` | `765713ef-2ac8-4410-98f0-08ea9552c506` |
| `PUNCH_PROJECTS_TABLE` | Optional. The table is auto-detected; set this to force one. |

Two things that are easy to get wrong, both learned on the sibling apps:

- The server must be a Fabric **SQL Database** (`*.database.fabric.microsoft.com`).
  The Lakehouse/Warehouse endpoint (`*.datawarehouse.fabric.microsoft.com`)
  cannot be reached by this driver at all — no auth mode or TLS setting fixes it.
- The service principal needs **both** workspace Contributor **and** Read-all-data
  on the database item, granted in the Fabric portal. T-SQL `CREATE USER` was
  locked down at GA and is not an alternative.

That is the whole list. `PUNCH_EXTRACT_MODEL` is not needed — the direct API path
defaults to `claude-opus-5`.

Key Vault values are in `kv-dataplatform-bci.vault.azure.net`, the same secrets
the Safety Dashboard notebooks use:

```bash
az keyvault secret show --vault-name kv-dataplatform-bci \
  --name procore-client-id --query value -o tsv
az keyvault secret show --vault-name kv-dataplatform-bci \
  --name procore-client-secret --query value -o tsv
```

Verify them before pasting — this separates "wrong credentials" from "wrong
permissions" later, and should come back as the service account
`abs-api-export-b171139a@procore.com`:

```bash
CID='<client-id>'; CSEC='<client-secret>'
TOKEN=$(curl -sS -X POST https://login.procore.com/oauth/token \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$CID\",\"client_secret\":\"$CSEC\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -sS https://api.procore.com/rest/v1.0/me \
  -H "Authorization: Bearer $TOKEN" -H "Procore-Company-Id: 18895"
```

### Why the values are pasted, not Key Vault references

The obvious improvement is `@Microsoft.KeyVault(SecretUri=...)` instead of the
literal secret. **It does not work here.** Key Vault references in Static Web Apps
application settings are supported only for *bring-your-own* (linked) Function
Apps — **not for the managed functions this app uses**, which is what
`api_location` deploys. Microsoft documents the limitation, and it has been open
on the Static Web Apps tracker for years:

- <https://learn.microsoft.com/en-us/azure/static-web-apps/key-vault-secrets>
- <https://github.com/Azure/static-web-apps/issues/1090>
- <https://github.com/Azure/static-web-apps/issues/428>

The next idea — read Key Vault from code with `DefaultAzureCredential` and a
managed identity — is worse here for two independently sufficient reasons, both
already paid for on the Herd Intranet:

1. **Managed identity is unreliable inside SWA managed functions.** It is a
   restricted sandbox; the Herd Intranet dropped `@azure/identity` for exactly
   this and settled on key auth.
2. **`@azure/identity` + `@azure/keyvault-secrets` add well over a thousand
   files.** SWA caps a deployment at **~15,000 files**, and adding one SDK
   (`openai`) is what broke every Herd Intranet deploy for hours. This API is
   deliberately small — see the deps in `api/package.json`.

**⚠️ Rotation consequence.** The Procore credentials now live in two places: Key
Vault (for the Safety Dashboard notebooks) and this app's settings. Rotating the
Procore secret means updating **both**, or this app starts failing auth while the
dashboard keeps working. The Connection check on step 1 of the app reports it
plainly when that happens.

This is not much of a security downgrade: Static Web Apps settings are encrypted
at rest and readable only by someone with Azure RBAC on the resource. What is
lost is central rotation and Key Vault's access audit trail.

---

## Step 5 — Deploy

The workflow deploys on push to `main`, so merge the pull request:

> https://github.com/coryzilisch-lgtm/Punch-List-Assistant/pull/1

Watch the run under the repo's **Actions** tab. First deploy takes 2–4 minutes
because Oryx installs and builds the API.

The run prints the site URL on success — use that one, not a host you noted
earlier:

```
Visit your site at: https://<name>.azurestaticapps.net
```

Open it, sign in with your Buffalo account, then check `/api/health`. A healthy
deployment answers:

```json
{"status":"ok","procoreConfigured":true,"extractionConfigured":true,
 "aiProvider":"anthropic","aiModel":"claude-opus-5"}
```

Both `*Configured` flags `true` is the fastest proof that all six app settings
are readable by the Functions. If either is `false`, the settings were probably
saved against a preview environment rather than **Production** — the
Environment variables blade has an environment selector at the top.

---

## Step 6 — First real run

1. **Pick your test project.** Read the **Connection check** card. Every line
   should be a green tick. The one to read closely is *Punch list read access* —
   if it fails, step 1 has not landed yet.
2. **Upload the punch list.** Pages are read a few at a time with a progress bar.
   A red page number means that page failed; click it to retry.
3. **Review.** Set **Punch item manager** and **Final approver** in the "Apply to
   every selected item" card — most Procore configurations require both. Fix any
   row badged **Check this**.
4. **Preview payloads.** Press it on the send step. Nothing is created; it shows
   exactly what would be sent. Sanity-check one item.
5. **Send exactly one item.** Clear the selection, tick a single row, send.
   - Created → the contract is proven, go to step 6.
   - Rejected → the error row carries Procore's own message
     (`punch_item_manager_id can't be blank`). Set that field on the review step
     and send the same one item again.
6. **Send the rest.** Items that succeeded are unticked automatically, so you
   cannot double-create by pressing send twice.
7. **Check Procore.** Open the project's punch list and confirm the items are
   there with their photos attached.

---

## When something goes wrong

| Symptom | Cause |
|---|---|
| Sign-in loops, or `AADSTS700054` | The Secret **ID** was pasted instead of the secret **Value** (step 3.2) |
| Sign-in fails with no useful error | **ID tokens** not ticked (step 3.1), or the app is on the Free plan (step 2) |
| Deploy fails "No matching Static Web App" | The secret is missing, named something other than `AZURE_STATIC_WEB_APPS_API_TOKEN`, or still holds a token from a Static Web App that was deleted and recreated |
| Deploy fails "Could not determine the Static Web App from the GitHub OIDC workflow reference" | The workflow is using OIDC, which identifies the app by matching the **workflow filename** to the one Azure generated. This repo deploys with the token instead, precisely so the filename does not matter — do not re-add `github_id_token` or the `id-token` permission |
| `/api/health` returns 404 | Almost always the wrong host, or no deploy has succeeded yet. The site URL is printed at the end of a successful run: `Visit your site at: https://<name>.azurestaticapps.net`. Note an unauthenticated `/api/*` request 302s to login rather than 404ing, so a cold 404 means nothing is deployed at that host |
| Two deploys run per push | Azure wrote its own workflow file. Delete it; keep `azure-static-web-apps.yml` |
| Projects list is empty | Procore credentials wrong or missing — check the Connection check card |
| Every page fails to read | `ANTHROPIC_API_KEY` missing or wrong; `/api/health` reports whether it is configured |
| A page times out | SWA Functions stop at 45 seconds. Set `PUNCH_EXTRACT_EFFORT` to `low` |
| Punch items rejected | Read the field-level message on the failed row — it names the field |

`GET /api/health` and `GET /api/probe?project_id=<id>` answer most of these
directly.

---

## Later: moving to Claude on Foundry

When the Azure Marketplace purchase agreement is in place, deploy a Claude model
in the Foundry resource and swap three settings — `ANTHROPIC_FOUNDRY_RESOURCE`,
`ANTHROPIC_FOUNDRY_API_KEY`, `PUNCH_EXTRACT_MODEL` (the *deployment name*) — then
remove `ANTHROPIC_API_KEY`. No code change and no redeploy beyond saving the
settings. Full steps are in the main README under **Deploy Claude in Azure AI
Foundry**.

## Reading Procore's real field shapes (`/api/inspect`)

Procore's API reference is unreachable from the environment this app was built
in — the egress proxy answers `CONNECT developers.procore.com` with a 403 — so
the punch-item **write** contract has been inferred from search-result snippets.
That inference has been wrong three times, each time in the same expensive way:
Procore answered `200`, stored nothing, and the app reported success.

`GET /api/inspect` replaces the guessing. It is strictly read-only.

```
/api/inspect?project_id=123                  # survey the project's punch items
/api/inspect?project_id=123&punch_item_id=274 # dump one item verbatim
```

The survey reports:

- `enums` — every scalar field with a small number of repeated values, and how
  often each appears. **This is how you find the field that means "Draft"**
  without knowing its name: a workflow flag shows up as a handful of values
  across hundreds of rows, while a title or a timestamp does not.
- `collections` — every array-valued field that is non-empty somewhere, with one
  example element. This is how the attachment and assignee shapes get pinned
  down: find a row created through Procore's own UI that has a photo on it.
- `objects` — object-valued fields (`ball_in_court`, `punch_item_manager`) and
  their keys.
- `raw` — the full JSON of up to three illustrative items, fetched individually
  because the list view is slimmer than the show view.

The fastest way to settle both open questions: in Procore's UI, add a photo and
an assignee to any punch item on a test project, then call the survey and read
`collections` — the key names it reports are the ones the write payload has to
use.

### Why `status` is not the workflow state

`status` is **open / closed**. An item Procore's UI labels `Draft` reads back as
`status: "open"`. The first version of the send step gated on
`status === 'draft'`, so it never ran, and because nothing errored the app
reported nothing — a super ticked "send to the punch item manager" and silently
got no send at all. Draft detection now checks the plausible workflow fields and
returns **unknown** rather than `false` when none resolve, so unknown falls
through to attempting the send instead of being read as "already sent".
