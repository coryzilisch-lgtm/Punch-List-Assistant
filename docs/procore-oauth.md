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
