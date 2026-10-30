---
name: waf-compatibility
description: Use before changing anything a browser or scheduled caller sends to this app (a new or renamed API route, HTTP method, query parameter, custom request header, cookie, request content type, upload, request body shape or size, a new free-text / URL / base64 / secret field, or a new non-browser caller such as a GitHub Actions cron, Zapier, a Procore webhook or a Fabric pipeline Web activity). Also use when a request works locally but fails in production with a 403 and no Function log. The app is served through an Azure Application Gateway WAF (OWASP DRS 2.1) with exclusions derived from the code; a change that is not reflected there is blocked at the gateway, not in the app.
---

# WAF compatibility (Azure Application Gateway, OWASP DRS 2.1)

IT fronts every Buffalo Static Web App with an Application Gateway WAF. The WAF was tuned
from an inventory of what each app sends (routes, headers, cookies, content types, body
sizes, machine callers), kept in **`docs/waf-exclusions.md`** in this repo. The company-wide
write-up with every app and the consolidated rule list is the Claude doc
"Azure App Gateway WAF exclusions for the Buffalo apps"
(https://claude.ai/artifact/Q6EaFGC4UZ5CtvxjKJdzMA).

**The failure mode to design against:** a request the WAF rejects gets a 403 HTML page from
the gateway. It never reaches SWA, so there is no Function log, no app error, and a scheduled
caller simply stops running. The only record is the gateway's `ApplicationGatewayFirewallLog`
(rule id, path, matched field).

## 1. Decide whether the change touches the request surface

Answer yes if the change adds, removes or renames any of:

- an API route, a method (PUT, PATCH, DELETE are each a separate question), a query parameter
- a custom request header (anything the browser or a script sets beyond `Content-Type`)
- a cookie the app sets
- a request content type (anything that is not `application/json`)
- a request body shape: a new JSON key that will carry free text, a URL, markdown or HTML,
  base64 data, a secret, or a file name
- an upload, or a change to how big a body can be
- a non-browser caller (GitHub Actions, Zapier, Procore webhook, Fabric Web activity, curl)
- how long a request can run

No to all of them: nothing to do. Yes to any: continue.

## 2. Prefer a shape that needs no new exclusion

| Instead of | Do | Why |
| --- | --- | --- |
| a raw body with its real type (`image/jpeg`, `application/pdf`, Office types) | keep the existing raw-body endpoints as they are (920420 is already off for them); for a NEW endpoint send `application/octet-stream` and put the real type in a custom header the server reads | each new content type is one more reason the content-type rule has to be off |
| a name, email or free text as a URL path segment | an id in the path, the text in a JSON body | path segments are inspected by every rule family and cannot be excluded by key |
| a secret or token in a query string | a custom header | query values are logged and inspected; a header can be excluded by name |
| a new custom header with a generic name | a name prefixed `X-` and listed in the inventory | it needs a `RequestHeaderNames` exclusion |
| a scheduled caller with no `Accept` or `User-Agent` | send both (`Accept: application/json`, a named User-Agent) | 920300, 920320, 920330 and 913xxx fire on bare clients |
| a body that grows without bound | a server-side cap and one page per request | only the first 128 KB of any body is inspected; size enforcement is off, but a 45 s Function still dies |
| a request that can run past 60 s | split it, or return early and poll | the gateway's backend timeout is 120 s and SWA's is 45 s |

## 3. Record it in the same PR

1. Update `docs/waf-exclusions.md`: the route table, and the Part A or Part B table if a new
   exclusion is needed. Use the same columns.
2. Put a **WAF impact** line in the PR description: either `WAF impact: none` or the exact
   exclusion rows IT has to add, in this form:

   `RequestHeaderNames | Equals | x-my-header | global | <why>`

   `RequestArgNames | Contains | <json key> | rules 941xxx, 942xxx | <why>`

3. If an exclusion is needed, IT applies it **before** the merge deploys, not after. Merge to
   `main` is a live deploy, and the gateway blocks first.

## 4. Mapping a change to an exclusion

| Change | Exclusion |
| --- | --- |
| new custom request header | `RequestHeaderNames` Equals `<lowercase name>`, global |
| new cookie | `RequestCookieNames` Equals or StartsWith `<name>`, global |
| new JSON key carrying base64, a sealed token or a secret | `RequestArgNames` Contains `<leaf key>`, global |
| new JSON key or query parameter carrying a URL | `RequestArgNames` Equals `<key>`, rules 931120 and 931130 |
| new JSON key carrying free text, markdown or HTML | nothing up front; name it as a Part B candidate for 941/942/932 and confirm in Detection |
| new file-path style value | `RequestArgNames` Equals `<key>`, rule group 930 |
| new raw content type on an upload | rule 920420 off on this app's policy (or the octet-stream pattern above) |
| new method (PUT, PATCH, DELETE) | watch 911100 in Detection; disable it on this policy if it fires |
| new machine caller | its User-Agent and Accept behaviour noted in the inventory; 920300/920320/920330/913xxx excluded for its path if it fires |

The operator is **Contains** (not Equals) for JSON keys that sit inside arrays or nested
objects, because the engine names them with their path (`items.0.photos.0`).

## 5. After the deploy

A request blocked by the WAF is a 403 with the gateway's HTML body, and nothing in the app's
log. Confirm in the `ApplicationGatewayFirewallLog` (Log Analytics) by path and rule id, send
IT the row, and do not work around it by loosening the app's own validation.
