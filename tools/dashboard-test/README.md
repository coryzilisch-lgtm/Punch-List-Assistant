# Browser checks for the dashboard

`node --check` proves the file parses. It cannot prove a handler does the right
thing — and the sibling Safety Dashboard shipped a page that threw before a
single handler bound, with a clean syntax check, because of exactly that gap.

These drive the **real** `dashboard/` files in headless Chromium against a stubbed
API. Today they cover the name/company picker, which has now had two bugs of that
shape:

- a filter that only looked at the person's name, so typing a company matched
  nobody;
- a `scroll` listener registered in the **capture** phase, which fired on the
  popup's own scrolling and closed the list you were trying to read.

```bash
cd tools/dashboard-test
npm install          # playwright only; Chromium is already on the image
npm test
```

`tools/` is outside the Static Web App's `app_location`, so nothing here is
deployed and none of it counts against the ~15,000-file deployment cap.

**A test that passes against the broken code is worth nothing.** Both bugs above
were re-introduced and confirmed to fail these tests before the fixes were
committed. Do that for anything added here.
