# CageTrack — Tool Check-Out Tracker

An internal dashboard for tracking technician tool check-outs, returns, overdue
items, and per-tool history. It reads a Google Sheet (fed by the Formstack
check-out/return form) and updates itself automatically.

**Status:** Live. Reading the team's Google Sheet, auto-refreshing every 60s.

> Internal Peterman Brothers tool. Keep this repository private.

---

## What it does

- **KPI cards:** Check-outs today, returns today, currently out, overdue,
  average time out, and the most active technician today.
- **One focused table with tabs:** *Currently Out · Overdue · Recent Returns ·
  All Check-Outs · Needs Review.*
- **Click-through drill-downs:**
  - Click a **technician** → their profile (vans, nickname, and a Holding /
    Returns / All-history sub-tabbed list).
  - Click a **row** → that transaction's details **plus the tool's full
    history** — every check-out and return of that tool, across all techs, as a
    timeline.
- **Filters:** date range, technician, tool, and van #.
- **Needs Review:** surfaces data problems (unmatched returns, unreadable
  dates, fuzzy auto-matches) and lets you **manually link** an unmatched return
  to the right open check-out.
- **Auto-refresh** every 60s, plus a **print-to-PDF** layout (Ctrl+P).

## How it works

The Formstack form writes to a Google Sheet with two tabs — **Checkouts** and
**Returns**. CageTrack reads both (as CSV, by tab name) and **matches each
check-out to its return** to figure out what's actually still out.

**Status for each tool:**
- Check-out date, no matching return → **Checked Out**
- …and past the allowed window → **Overdue** (window = `RETURN_WINDOW_HOURS`)
- Matched to a return → **Returned**

**Matching** runs in passes: exact name match first (oldest-first), then a
conservative **fuzzy** pass for typos (same technician, return on/after the
check-out, high name similarity). `TOOL_ALIASES` fold known spelling variants
together, and anything the software can't safely match shows up in **Needs
Review** for a human to link.

## Running it locally

The app loads several files and (in live mode) fetches the Google Sheet, so it
needs to be **served** — opening `index.html` straight from disk won't work.

- **Easiest (Windows):** double-click **`dev-server.ps1`**, then open
  **http://localhost:5522**.
- **VS Code:** open the folder and use the **Live Server** extension.
- **Any static host** also works (the app is plain HTML/CSS/JS).

## Files

| File | Purpose |
|------|---------|
| `index.html`     | Page layout (header, KPI cards, tabs, table, sidebar, modal) |
| `styles.css`     | All styling, including the print/PDF layout |
| `app.js`         | Data loading, check-out/return matching, status logic, rendering, drill-downs |
| `config.js`      | **The only file you normally edit.** Sheet URLs, columns, cleanup rules |
| `mockData.js`    | Built-in sample data for `DATA_SOURCE: "mock"` (offline demo) |
| `dev-server.ps1` | Tiny local server for previewing (no Python/Node needed) |
| `assets/`        | Logo |

## Configuration (`config.js`)

| Setting | What it controls |
|---------|------------------|
| `DATA_SOURCE` | `"live"` (Google Sheet) or `"mock"` (built-in sample data) |
| `GOOGLE_SHEET_CHECKOUTS_CSV_URL` / `..._RETURNS_CSV_URL` | The two tab feeds (see below) |
| `AUTO_REFRESH_SECONDS` | How often to re-pull the sheet (`0` = manual only) |
| `RETURN_WINDOW_HOURS` | How long a tool can be out before it's **Overdue** (default 7 days) |
| `CHECKOUT_COLUMNS` / `RETURN_COLUMNS` | Maps the sheet's header names to the fields CageTrack expects |
| `EXCLUDE_TOOL_NAMES` | Tool names to drop entirely (test/junk), e.g. `"TEST"` |
| `EXCLUDE_ROWS` | Drop one **specific** line (tech + item + date) without filtering a whole tool name |
| `TOOL_ALIASES` | Fold spelling variants into one name (e.g. `jack hammer` → `Jackhammer`) |
| `MATCHING` | Fuzzy matching on/off and strictness (`THRESHOLD`, 0–1) |
| `BRAND` | Logo, company/product name, tagline |

## Connecting a sheet

CageTrack reads each tab as CSV by name:

```
https://docs.google.com/spreadsheets/d/<SHEET-ID>/gviz/tq?tqx=out:csv&sheet=<TabName>
```

1. The sheet must be readable — **Share → Anyone with the link → Viewer.**
2. Put the `<SHEET-ID>` (from the normal `/spreadsheets/d/<ID>/edit` URL) and the
   exact tab names into the two `GOOGLE_SHEET_..._CSV_URL` values in `config.js`.
3. Make sure each tab's header names match `CHECKOUT_COLUMNS` / `RETURN_COLUMNS`
   (currently `Name`, `Van #`, `Tool Name`, and `Date Checked Out` / `Date
   Returned`).

The dashboard fetches with cache-busting, so new form submissions appear within
the refresh interval.

## Cleaning up messy data

Form data is hand-typed, so CageTrack has a few knobs (all in `config.js`):

- **`EXCLUDE_TOOL_NAMES`** — drop junk by name (e.g. `TEST`).
- **`EXCLUDE_ROWS`** — drop one specific line (matches tech + item + date; use
  `date: ""` for an undated row) without touching other rows of that tool.
- **`TOOL_ALIASES`** — make `"Press jaw"` and `"Press Jaws"` the same tool.
- **`MATCHING.FUZZY`** — auto-catch typos when pairing check-outs to returns.
- **Needs Review → "Link"** — when the software can't match a return, open it and
  link it to the right check-out by hand (the link survives refreshes).

## Notes

- The dashboard reflects the sheet exactly. If the **Returns** data shows tools
  coming back the same day they went out, the dashboard will (correctly) show
  nothing outstanding — that's a data-entry pattern, not a bug.
- Manual links made in Needs Review are session-only conveniences; the durable
  fixes are cleaner names in the form/sheet (or an alias/exclude in `config.js`).
