# Vendored third-party code

`pdf.mjs` / `pdf.worker.mjs` — pdf.js **legacy** build, `pdfjs-dist@4.10.38`, Apache-2.0
(see `pdfjs-LICENSE`).

Vendored rather than loaded from a CDN for two reasons:

1. The app's Content-Security-Policy is `script-src 'self'`. A CDN would require
   loosening it.
2. Superintendents open this on job sites over LTE and hotel wifi. A CDN that is
   slow, blocked by a client's guest network, or unreachable would take the whole
   upload flow down.

The **legacy** build is deliberate: it targets older Safari, which is what an
iPad in the field is running.

To update: `npm pack pdfjs-dist@<version>`, then copy `legacy/build/pdf.mjs` and
`legacy/build/pdf.worker.mjs` here. Both files must come from the same version —
pdf.js throws a version-mismatch error if the worker and main bundle disagree.
