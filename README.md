# CageTrack — Tool Check-Out Tracker

An internal dashboard for tracking technician tool check-outs, returns, overdue
items, and per-tool history. It reads a Google Sheet (fed by the Formstack
check-out/return form) and updates itself automatically.

**Live at:** https://ethanbradshaw80.github.io/CageTrack/
**Status:** In daily use. Reads the team's Google Sheet, auto-refreshes every 60s.

> Internal Peterman Brothers tool.

---

## What it does

- **KPI cards:** Check-outs today, returns today, currently out, overdue,
  average time out, and the most active technician today.
- **One focused table with tabs:** *Currently Out · Overdue · Recent Returns ·
  All Check-Outs · Needs Review · Reviewed.*
- **Click-through drill-downs:**
  - Click a **technician** → their profile (vans, nickname, and a Holding /
    Returns / All-history sub-tabbed list).
  - Click a **row** → that transaction's details **plus the tool's full
    history** — every check-out and return of that tool, across all techs, as a
    timeline.
- **Filters:** date range, technician, tool, and van #.
- **Fix data problems in the app** (see *Resolving exceptions* below) — links,
  marking something returned, and undo, all saved for every user.
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
Review** for a human to resolve.

The matching is deliberately conservative. Loosening it would empty Needs Review
but start silently pairing the wrong tools — uncertain cases are meant to reach
a person.

## Resolving exceptions (Needs Review → Reviewed)

Three actions, all saved for **every** user and reversible:

| Action | Use when | Where |
|---|---|---|
| **Link** | The check-out and return are the same tool, worded differently | Needs Review → open the row |
| **Mark returned** | The tool is physically back but no return form was filed | Open any still-out tool |
| **Undo** | Someone resolved something incorrectly | Reviewed tab |

Resolved items move to the **Reviewed** tab with the reason, so there's a record
of what was decided and why. Nothing is deleted from the underlying sheet —
dismissed returns still count in Returns and tool history.

## Shared saving

Resolutions are written to a **`Links` tab** in the same Google Sheet by a small
Google Apps Script web app, so every user sees the same fixes from any computer.
**This is already set up and running** — see `SETUP-SHARED-SAVING.md` if it ever
needs redeploying or troubleshooting.

Two things worth understanding:

- **The log is append-only.** Undo doesn't delete a row; it appends a `removed`
  row pointing at the original's `UID`, and every dashboard skips it. That's why
  the Links tab grows rows that look like duplicates — intended. Don't hand-edit
  that tab; use **Undo** in the app.
- **Saves are queued before they're sent.** A save lands in a local outbox first
  and only leaves once its `UID` is confirmed in the sheet, so a dropped
  connection can't lose one. The header chip shows the state:
  *Saving: shared* (all good) · *N syncing* (unconfirmed, click to retry) ·
  *this PC only* (shared saving not configured).

## Running it locally

The app loads several files and (in live mode) fetches the Google Sheet, so it
needs to be **served** — opening `index.html` straight from disk won't work.

- **Easiest (Windows):** double-click **`Start-CageTrack.bat`** (or run
  `dev-server.ps1`), then open **http://localhost:5522**.
- **VS Code:** open the folder and use the **Live Server** extension.
- **Any static host** also works (the app is plain HTML/CSS/JS — no build step).

The local dev server also accepts `POST /api/save-link`, which writes to
`manual_links.json`. That's a fallback for offline/local work; the shared sheet
is the real store.

## Files

| File | Purpose |
|------|---------|
| `index.html`     | Page layout (header, KPI cards, tabs, table, sidebar, modal) |
| `styles.css`     | All styling, brand theme, and the print/PDF layout |
| `app.js`         | Data loading, matching, resolutions, rendering, drill-downs |
| `config.js`      | **The only file you normally edit.** Sheet URLs, columns, cleanup rules |
| `mockData.js`    | Built-in sample data for `DATA_SOURCE: "mock"` (offline demo) |
| `dev-server.ps1` | Tiny local server for previewing (no Python/Node needed) |
| `apps-script/`   | The Google Apps Script that writes resolutions to the sheet |
| `fonts/`         | Self-hosted Zilla Slab (brand font) |
| `assets/`        | Logo |
| `docs/`          | Functional spec / business case |
| `robots.txt`     | Keeps the hosted page out of search engines |

## Configuration (`config.js`)

| Setting | What it controls |
|---------|------------------|
| `DATA_SOURCE` | `"live"` (Google Sheet) or `"mock"` (built-in sample data) |
| `GOOGLE_SHEET_CHECKOUTS_CSV_URL` / `..._RETURNS_CSV_URL` | The two tab feeds (see below) |
| `LINKS.SAVE_URL` / `LINKS.TAB_NAME` | Apps Script web-app URL and the tab it writes to |
| `AUTO_REFRESH_SECONDS` | How often to re-pull the sheet (`0` = manual only) |
| `RETURN_WINDOW_HOURS` | How long a tool can be out before it's **Overdue** (default 7 days) |
| `CHECKOUT_COLUMNS` / `RETURN_COLUMNS` | Maps the sheet's header names to the fields CageTrack expects |
| `EXCLUDE_TOOL_NAMES` | Tool names to drop entirely (test/junk), e.g. `"TEST"` |
| `EXCLUDE_ROWS` | Drop one **specific** line (tech + item + date); `sheet:` scopes it to one tab |
| `MANUAL_LINKS` | Permanent hand-written return↔check-out pairings |
| `REVIEWED_OK` | Returns with no possible check-out, reviewed and explained (with a note) |
| `MARK_RETURNED` | Tools known to be back where no return was ever filed |
| `TOOL_ALIASES` | Fold spelling variants into one name (e.g. `jack hammer` → `Jackhammer`) |
| `MATCHING` | Fuzzy matching on/off and strictness (`THRESHOLD`, 0–1) |
| `BRAND` | Logo, company/product name, tagline |

Entries in `MANUAL_LINKS`, `REVIEWED_OK` and `MARK_RETURNED` are hand-edits and
**can't be undone from the app** (they carry no `UID`) — that's deliberate, they
are the maintainer's decisions. Resolutions made with the in-app buttons can.

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
the refresh interval. Requests time out after 6s and retry — if Google stalls,
the dashboard keeps the last loaded data on screen and shows a banner rather
than spinning indefinitely.

## Cleaning up messy data

Form data is hand-typed, so CageTrack has a few knobs (all in `config.js`):

- **`EXCLUDE_TOOL_NAMES`** — drop junk by name (e.g. `TEST`).
- **`EXCLUDE_ROWS`** — drop one specific line (matches tech + item + date; use
  `date: ""` for an undated row) without touching other rows of that tool.
- **`TOOL_ALIASES`** — make `"Press jaw"` and `"Press Jaws"` the same tool.
- **`MATCHING.FUZZY`** — auto-catch typos when pairing check-outs to returns.
- **In-app Link / Mark returned** — resolve a one-off without editing anything.

## Notes

- The dashboard reflects the sheet exactly. If the **Returns** data shows tools
  coming back the same day they went out, the dashboard will (correctly) show
  nothing outstanding — that's a data-entry pattern, not a bug.
- Dates written to the Links tab are plain `yyyy-mm-dd` and are parsed as
  **local** dates on the way back in. Parsing them with `new Date("2026-07-20")`
  reads as UTC midnight and lands a day earlier in US time zones — that bug has
  been fixed once already; don't reintroduce it.
- The brand colours and Zilla Slab come from the Peterman Brothers Brand Guide.
  The font is self-hosted so the dashboard doesn't depend on Google Fonts.
