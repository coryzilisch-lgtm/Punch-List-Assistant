# WAF exclusions: Punch List Assistant

> Generated from the code on 2026-10-30. **Update this file in the same PR as any change to a
> route, method, query parameter, custom header, cookie, content type, upload, body shape or
> non-browser caller** (see `.claude/skills/waf-compatibility/SKILL.md`). The company-wide
> write-up covering all five apps, with the consolidated rule list IT applies, is
> https://claude.ai/artifact/Q6EaFGC4UZ5CtvxjKJdzMA.

## How to read this

- **Part A** rows are deterministic: they follow from the code and are applied before cutover.
- **Part B** rows are candidates: the rule fires on the *value* a person types later, which code
  cannot predict. They are confirmed from the WAF log while the policy runs in Detection mode,
  then promoted.
- Exclusion rows are `match variable | operator | selector | scope | why`, which is the shape
  Application Gateway takes (Azure CLI `az network application-gateway waf-policy managed-rule
  exclusion add`, or the portal's Managed rules > Exclusions blade).

## Settings common to every Buffalo app (applied on the gateway, not in this repo)

| Setting | Value | Why |
| --- | --- | --- |
| Host header to backend | the custom domain, never rewritten to `*.azurestaticapps.net` | SWA picks the site and builds the Entra redirect from it |
| Health probe | `/`, accept 200-399 | `/` answers 302 to sign-in when there is no cookie |
| Backend request timeout | 120 s (default 20 s) | long requests; SWA itself kills a Function at 45 s |
| Rule set | DRS 2.1, anomaly threshold 5, per-rule exclusions | |
| Request body inspection | on, first 128 KB | |
| Max request body size enforcement | **off** | raw-body uploads up to 30 MB across the apps; a raw body is not a "file upload" to the WAF |
| `RequestCookieNames` StartsWith `StaticWebAppsAuth` | global | SWA session cookies are opaque base64 |
| `RequestArgNames` Equals (one entry per name) `id_token, code, state, session_state, post_login_redirect_uri` | global | the `/.auth/login/aad/callback` form post and sign-in redirect |

## This app (punchass.buffaloconstruction.com)

Every page image and every cropped photo is posted as base64 inside JSON, so this app has the
largest request bodies of the five, and the `pla_procore` cookie rides on every API request.
`/api/procore/callback` is anonymous at the SWA layer because Procore redirects there before the
browser has a session; it must stay reachable through the gateway.

### Request surface

| Item | Detail |
| --- | --- |
| Front end | `dashboard/`: `index.html`, six `.js` modules, `styles.css`, one PNG, vendored pdf.js (`vendor/pdf.mjs`, `vendor/pdf.worker.mjs`) |
| Routes | `health`, `me`, `projects`, `projects/{id}`, `projects/{id}/config`, `inspect`, `probe`, `quota` (GET); `extract`, `push`, `procore/disconnect` (POST); `procore/connect` (GET navigation, 302 to Procore); `procore/callback` (GET, anonymous) |
| Content types | `application/json` on every POST |
| Custom request headers | none |
| Cookies set by the app | `pla_procore` (path `/api`, sealed base64url, up to 3,800 chars, every API request); `pla_procore_state` (path `/api/procore`, 10 min, about 180 chars) |
| Query parameters | `project_id`, `punch_item_id`, `punch_item_number`, `lists`, `uploads`, `history`, `as_user`; on the callback `code`, `state`, `error`, `error_description` |
| `POST /api/extract` | `{pageNumber, totalPages, image, photos:[{index,top,bottom,left,right}]}`; `image` is a base64 JPEG page, about 1.3 MB for letter, server cap 12 MB decoded; 3 requests in flight |
| `POST /api/push` | `{projectId, dryRun, items:[...]}`, 1 to 10 items; each has `name`, `description` (multi-line, carries the `Owner's` apostrophe), `reference` (PDF file name), ids, `photos[]` of base64 JPEG crops with no per-photo cap |
| Machine callers | none |

### Part A

| Match variable | Operator | Selector | Scope | Why |
| --- | --- | --- | --- | --- |
| RequestCookieNames | StartsWith | `pla_procore` | global | sealed base64url on every request |
| RequestArgNames | Contains | `image` | global | base64 JPEG page in `/api/extract` |
| RequestArgNames | Contains | `photos` | global | base64 JPEG crops in `/api/push` (key appears as `items.N.photos.N`) |
| RequestArgNames | Equals (one entry per name) | `code`, `state`, `error`, `error_description` | global | Procore OAuth callback (same names as the SWA common list) |
| Body size enforcement | off | | policy | common setting; every extract and push body exceeds 128 KB |

### Part B

| JSON key | Endpoint | Content | Rules to expect |
| --- | --- | --- | --- |
| `name` | `POST /api/push` | punch item title | 942xxx |
| `description` | `POST /api/push` | multi-line defect text, apostrophes, inch marks | 942xxx, 932xxx |
| `reference` | `POST /api/push` | PDF file name plus ` · Item N` (Unicode middle dot) | 920260, 942xxx |
| `error_description` | `GET /api/procore/callback` | Procore's error text | 941xxx |
