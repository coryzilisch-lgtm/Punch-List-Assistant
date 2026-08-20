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
| Deployment source | **Other** |

**Standard, not Free.** This app brings its own Entra registration, and custom
authentication is a Standard-plan feature — on Free you only get the
preconfigured providers and sign-in will not work.

**Deployment source "Other", not GitHub.** If you pick GitHub, Azure writes a
*second* workflow file into the repo with its own randomly-named token secret,
alongside the one already committed. Two workflows both deploying is the exact
mess the Herd Intranet notes warn about. Pick Other and wire the token yourself
in the next step.

After it is created, note the **URL** (`https://<something>.azurestaticapps.net`).
You need it in step 3.

### Wire up deployment

1. In the Static Web App → **Overview** → **Manage deployment token** → copy it.
2. In GitHub → the repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**.
3. Name it exactly `AZURE_STATIC_WEB_APPS_API_TOKEN`. Paste the token.

The committed workflow (`.github/workflows/azure-static-web-apps.yml`) reads that
name.

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

That is the whole list. `PUNCH_EXTRACT_MODEL` is not needed — the direct API path
defaults to `claude-opus-5`.

Key Vault values are in `kv-dataplatform-bci.vault.azure.net`, the same secrets
the Safety Dashboard notebooks use.

---

## Step 5 — Deploy

The workflow deploys on push to `main`, so merge the pull request:

> https://github.com/coryzilisch-lgtm/Punch-List-Assistant/pull/1

Watch the run under the repo's **Actions** tab. First deploy takes 2–4 minutes
because Oryx installs and builds the API.

Then open `https://<swa-host>` and sign in with your Buffalo account.

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
| Deploy fails "No matching Static Web App" | The GitHub secret name is not exactly `AZURE_STATIC_WEB_APPS_API_TOKEN` |
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
