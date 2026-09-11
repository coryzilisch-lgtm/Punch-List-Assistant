# Pushing to Procore as the superintendent, not as the integration

Research note, September 2026. Nothing here is built yet.

## Why this keeps coming up

Procore derives ball-in-court from the workflow, and a **Draft punch item sits in
its creator's court**. Since the service account creates everything, every
imported draft waits on `ABS abs-api-export-b171139a` — a robot nobody is going
to check. Naming a punch item manager does not move it (item #274 proves that).

So the creator is not cosmetic. It decides whose queue the work lands in.

`GET /api/inspect?as_user=<id>` established that this service account **cannot**
act on behalf of a person: all four candidate headers returned 200 and Procore
still saw the service account. Per-user OAuth is the remaining route.

## What changes

Today the app holds **one** credential — a client-credentials (DMSA) service
account — and every request in every session uses it. Per-user OAuth means each
superintendent authorizes Procore once, and their pushes run as them.

What that buys, beyond the creator name:

- A draft waits in **their** court, which is the behaviour actually wanted.
- Procore's own permission model applies. Today a project the service account
  was never added to is a 403 no super can resolve; with their own token, if they
  can see the project in Procore they can import to it.
- The audit trail in Procore matches who did the work.

## The flow

Standard authorization-code grant. Two endpoints, both on `login.procore.com`:

1. **Send the super to** `GET https://login.procore.com/oauth/authorize`
   with `response_type=code`, `client_id`, `redirect_uri`, and a `state` value
   bound to their session. Top-level navigation, not fetch.
2. Procore redirects back to `redirect_uri` with `?code=…`. The code is
   **one-use and expires in 10 minutes**.
3. **Exchange it:** `POST https://login.procore.com/oauth/token` with
   `grant_type=authorization_code`, `client_id`, `client_secret`, `code`,
   `redirect_uri`. Returns an access token and a refresh token.
4. **Refresh:** same endpoint, `grant_type=refresh_token`, plus `client_id`,
   `client_secret`, `redirect_uri`, `refresh_token`.

Access tokens last about two hours and Procore has said it is moving that toward
15 minutes, so store the **refresh** token and mint an access token per push.

## The part that will bite

**Refresh tokens rotate, and a refresh token does not expire until it is used.**
Exchanging one returns a *new* pair and invalidates the old. So exactly one valid
refresh token exists per user at a time, and two concurrent refreshes race: the
loser writes a token Procore has already invalidated, and that super is silently
signed out until they reconnect.

This is not hypothetical here. A push of sixty items is several batched calls,
Azure may run them on more than one Function instance, and the 45-second cap
means the app is *designed* to fan work out.

The store therefore needs compare-and-swap, not just "write the new token" —
Azure Table Storage ETags or a blob lease. Refresh once per push and pass the
access token down, rather than letting each request refresh on demand.

## What has to exist in Procore

The current credentials are a **Data Connection (DMSA)** app. Authorization-code
is a **different app type** — "Embedded (Auth code)" — so this needs its own app
in the developer portal, its own client id and secret, and its own registered
redirect URI (`https://<swa-host>/api/procore/callback`).

Notably, auth-code apps need **no permission template**: permissions follow the
signed-in user. That is the upside and also the thing to check before promising
it — a super whose Procore role cannot create punch items on a project will get a
403 the app cannot fix, where the service account would have succeeded.

There is also an install step: a company admin installs the custom app from
**Company Admin → App Management → Install Custom App** using the 36-character
App Version ID, after promoting the manifest from sandbox to production.

## Shape of the build

Keep both credentials. The service account stays as the fallback, so nothing
regresses for a super who has not connected yet and nothing breaks if a super
lacks a permission.

- `GET /api/procore/connect` → redirect to Procore's authorize URL with `state`.
- `GET /api/procore/callback` → exchange the code, store the refresh token keyed
  by the **Entra object id** from the SWA principal (never by email, which can be
  reassigned), redirect back into the app.
- `GET /api/me` → also report whether this person is connected.
- The push resolves a token: the signed-in super's if connected, else the service
  account — and the result says which was used, because "created by the
  integration" should never be a surprise.
- A Disconnect action that drops the stored token.

Storage: a table in an Azure Storage account, connection string in app settings —
SWA managed Functions cannot use managed identity reliably, and they do not
support Key Vault references either. **Refresh tokens are credentials**: one is a
standing grant to act as that person in Procore until revoked. Encrypt at rest,
never log them, never return one to the browser, and treat the store as
security-relevant.

Roughly a day, plus the Procore-side app registration and install, which needs a
company admin.

## Sources

Procore's API reference is unreachable from the build environment (the egress
proxy blocks `developers.procore.com` and its `procore.github.io` mirror), so
this was assembled from search summaries of those same pages. Endpoint names and
parameters should be confirmed against the live docs before implementation — that
assumption is exactly what cost three silent-failure rounds on the punch item
write contract.

---

# Adding an Embedded component instead of a second app

A Procore app is a manifest made of **components**. This one currently has a
**Data Connection (DMSA)** component — that is the client-credentials service
account. The other two are **Embedded Full Screen** and **Side Panel**, and both
are authorization-code: they run as the signed-in user.

So "act on behalf of a user" and "open inside Procore" are not two projects. Add
an Embedded component to the existing app and both arrive together. Keep the Data
Connection component alongside it; the service account stays useful as the
fallback and for anything that has to run without a person present.

- **Embedded Full Screen** puts the app in Procore's **Select an App** menu, at
  project level and/or company level, rendered in an iframe.
- **Side Panel** docks it beside an existing tool — which for this app would mean
  opening it from the Punch List tool itself, on the project the super is already
  looking at. Worth considering: it removes the project-picking step entirely.

## The constraint that shapes the whole design

**Procore's login page will not render in an iframe** — deliberately, for
clickjacking reasons. So an embedded app cannot simply redirect to the OAuth
authorize URL the way a normal web app does.

`procore-iframe-helpers` exists for this. The iframe asks the parent to open a
real browser window:

```javascript
const context = ProcoreIframeHelpers.initialize();

context.authentication.authenticate({
  url: "/auth/procore",           // our endpoint, which redirects to Procore
  onSuccess: function (payload) { /* token is in hand */ },
  onFailure: function (error) { console.log(error); },
});
```

and the page our OAuth callback renders — in that popup window, on our origin —
closes the loop:

```javascript
ProcoreIframeHelpers.initialize().authentication.notifySuccess({});
```

which fires `onSuccess` in the iframe and closes the window.

## What embedding costs us here, and it is not small

This app is currently gated end to end by Azure Static Web Apps + Entra: every
route requires an authenticated principal, a 401 redirects to
`/.auth/login/aad`, and the CSP sets `frame-ancestors 'none'`. Every one of those
is incompatible with running inside Procore's iframe:

- `frame-ancestors 'none'` blocks the render outright. It has to become an
  explicit allowance for Procore's origin — **not** a wildcard, and not removed.
- Microsoft's login page also refuses to be framed, so the Entra redirect cannot
  complete inside the iframe either.

Which means: **inside Procore, Procore is the identity provider, not Entra.** The
API has to accept either a valid SWA principal (standalone URL) or a valid
Procore token (embedded), and the app shell has to be reachable without the Entra
gate. That is a real reduction in the current security posture and should be a
deliberate decision, not a side effect — the mitigation is that the API verifies
the Procore token against Procore on every call rather than trusting the frame.

## Where the token lives — the cheap option is also the better one

The research above assumed refresh tokens stored server-side, which drags in a
storage account and a compare-and-swap to survive rotation. Embedding makes that
mostly unnecessary.

The popup flow ends with an access token in the browser. Keep it there, send it
to our API in a custom header per request, and never store a refresh token at
all. This is exactly the pattern Herd-Intranet already uses for Microsoft Graph
(`X-Graph-Token`), so it is a known quantity in this stack:

- No storage account, no connection string, no new secret at rest.
- No refresh-token rotation race — the failure mode that would have silently
  signed people out mid-push.
- The client secret still never reaches the browser: the code-for-token exchange
  happens in our callback Function.

The cost is re-authenticating when the token expires. That is ~2 hours today,
which comfortably covers a punch import. Procore has said it is moving toward 15
minutes, and that would start to bite during a long review — at which point add
the server-side refresh-token store as an upgrade, with the concurrency care
described above. Starting without it is not a shortcut that has to be undone; the
token-resolution seam is the same either way.

## Order of operations

Procore-side first, because it gates everything:

1. Add the Embedded Full Screen (and/or Side Panel) component to the existing app
   in the developer portal.
2. Register the redirect URI: `https://<swa-host>/api/procore/callback`.
3. Note the auth-code **client id and secret** — these are separate from the DMSA
   credentials already in the app settings.
4. Promote the manifest from sandbox to production, then have a company admin
   install it: **Company Admin → App Management → Install Custom App**, using the
   36-character App Version ID.

Then the code: `/api/procore/connect` and `/api/procore/callback`, the iframe
helper wired into the dashboard, CSP and SWA route changes for the embedded path,
dual identity in the API, and the push choosing the user's token when present and
the service account when not — reporting which it used, because "created by the
integration" should never come as a surprise.
