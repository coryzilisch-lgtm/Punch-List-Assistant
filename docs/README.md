# Reference documents

**Not committed.** These PDFs are gitignored (`docs/*.pdf`) because they carry client
project details and jobsite photos, and a git commit is permanent. Drop them into
this folder locally to test with them.

`sample-darden-ops-punchlist.pdf` — a real Darden (LongHorn #5728, Durham NC) ops
punch list, 59 items over 17 pages. This is the document the extractor was built
against and the right first test after deploying.

`sample-darden-punch-coversheet.pdf` — Darden's punch list cover sheet. Not a
source of punch items; kept because it shows what else arrives in the same email
and what the reader has to correctly ignore.

## What makes the ops punch list a good test

- **Every page is a single full-page JPEG with no text layer.** There is no
  text-parsing shortcut; the whole document must be read as images.
- **The photo detector has to discriminate.** Page 2 carries a restaurant photo in
  the header and an App Store QR badge in the footer alongside three real defect
  photos. Both must be discarded rather than attached to items 1 and 3.
- **Fields are labelled but mostly blank.** Room, Sheet, Comment, Assign To and
  Resolution Date are printed on every row and filled on almost none. A reader
  that echoes labels instead of returning null produces 59 items that all claim
  to be assigned to "Assign To".
- **Items are terse.** "Seal all holes", "Remove plastic", "Fix door". The
  temptation to expand these into professional-sounding sentences is exactly what
  the extraction prompt forbids — the superintendent and the owner both track the
  owner's wording.
- **Photo counts vary per row**, 0 to 2, so pairing cannot assume one each.

Expected result: 59 items, numbered 1–59, none from page 1 (the header/summary
page), with photos on most rows and no logo or QR code anywhere in the set.
