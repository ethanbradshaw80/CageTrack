# CageTrack — Functional Specification & Business Case

**Product:** CageTrack — Technician Tool Check-Out Tracker
**Owner:** Ethan Bradshaw, Peterman Brothers
**Status of this document:** Draft v1.0
**Date:** 2026-06-29
**Audience:** Software development / engineering team scoping a production build
**Reference implementation:** A working browser-based prototype exists
(private repo `ethanbradshaw80/CageTrack`). This document describes the
problem, the intended behavior, and — in depth — the data requirements, using
the prototype as a proof of concept rather than the final architecture.

---

## 1. Executive Summary

Peterman Brothers technicians check tools in and out of a central "cage" (tool
crib). Today this is captured through a Formstack form on a shop tablet, which
lands in a spreadsheet. The spreadsheet records *events* but answers none of the
questions operations actually has: **What's out right now? Who has it? What's
overdue? Where has this tool been?**

CageTrack is a reporting layer on top of that data. It reads the check-out and
return logs, pairs each check-out with its return, and presents a live
operational dashboard: outstanding tools, overdue items, per-technician
activity, and per-tool history. The prototype is functional and connected to
live data; this spec defines what a production-grade version should do, with
particular emphasis on the data contract.

---

## 2. Business Case

### 2.1 Current state
- Tool check-outs and returns are logged via a **Formstack form** (tablet in the
  shop) → a **Microsoft Excel workbook in SharePoint** → mirrored to a **Google
  Sheet** with two tabs (`Checkouts`, `Returns`).
- The spreadsheet is an **append-only event log**. It is not queried or
  aggregated; staff read raw rows.

### 2.2 The problem (see §3 for detail)
- There is **no single view of what is currently checked out**. Determining it
  requires manually cross-referencing the check-out and return logs by eye.
- **Overdue / lost tools go unnoticed.** Tools represent real capital; a missing
  $1,200 press-jaw set or recovery machine is a direct loss and a job delay.
- **No accountability trail** per technician or per tool without manual
  spreadsheet work.
- Data is **hand-typed and inconsistent**, so even manual analysis is unreliable.

### 2.3 Proposed solution
A lightweight, read-only dashboard that:
- Joins the check-out and return logs to compute **current status** per tool.
- Surfaces **outstanding** and **overdue** items at a glance.
- Provides **drill-down** by technician and by tool (full history).
- **Auto-refreshes** so it reflects the form in near real time.

### 2.4 Value / benefits
- **Loss reduction:** overdue/unreturned tools become visible and actionable.
- **Time savings:** eliminates manual spreadsheet cross-referencing.
- **Accountability:** clear record of who has what and for how long.
- **Operational visibility:** a manager-facing snapshot of cage activity.
- **Low cost:** no backend in the prototype; runs as a static web app against a
  spreadsheet the company already maintains.

### 2.5 Suggested success metrics
- Reduction in tools flagged overdue / never returned per month.
- Reduction in time spent locating tools or reconciling the log.
- Adoption: dashboard opened/used by cage staff and supervisors.
- Data-quality improvement (fewer "Needs Review" exceptions over time).

---

## 3. Problem Statement (the issue this solves)

The underlying data is a **two-stream event log with no link between the
streams**. A check-out row and its corresponding return row are *separate
records* in *separate tabs*, with **no shared identifier**. Consequently:

1. **"What's currently out" is not stored anywhere** — it must be *derived* by
   matching each check-out to a later return and reporting the unmatched ones.
2. **Matching is non-trivial** because the only join keys are technician name +
   tool name + date, all of which are **free-text and inconsistently entered**
   (typos, plural/singular, embedded notes, character-encoding artifacts).
3. **Overdue status doesn't exist in the data** — it must be computed from the
   check-out date and a configurable allowed-duration policy.

CageTrack exists to perform this derivation reliably and present the result.

---

## 4. Scope

### 4.1 In scope
- Read-only ingestion of the check-out and return logs.
- Derivation of tool status (out / overdue / returned).
- Dashboard UI: KPIs, filterable tables, drill-downs, data-quality review.
- Near-real-time refresh.

### 4.2 Out of scope (current phase)
- Writing back to the form/sheet (no edits to source data from the dashboard).
- Authentication / per-user accounts / role-based access.
- Inventory master data (tool catalog, asset tags, purchase value).
- Notifications/alerts (email/SMS for overdue) — see §11 Future.

---

## 5. Users

| Persona | Needs |
|---------|-------|
| **Cage / inventory staff** | See what's out and overdue; find a specific tool's whereabouts. |
| **Field/operations supervisor (e.g., manager)** | Glanceable accountability; who has what; recurring offenders. |
| **Technicians (indirect)** | Subjects of the data; not direct users in this phase. |

---

## 6. Functional Requirements — UI

> The prototype implements all of the below; production may refine styling and
> layout but should preserve the behavior.

### 6.1 Global layout
- **FR-UI-1** Single-page dashboard, desktop-first, responsive down to tablet.
- **FR-UI-2** Branded header: company logo, product name, a live clock/date, a
  data-source indicator ("Live" vs "Mock"), last-updated timestamp, and a manual
  **Refresh** control.
- **FR-UI-3** Clicking the logo resets all filters and the active view.

### 6.2 KPI cards (top row)
- **FR-UI-4** Six at-a-glance metrics (definitions in §8.4): Check-outs Today,
  Returns Today, Currently Out, Overdue, Average Time Out, Most Active
  Technician Today.
- **FR-UI-5** KPI cards are clickable shortcuts that switch the table to the
  relevant view. The **Overdue** card visually emphasizes (color) **only when the
  overdue count is greater than zero**.
- **FR-UI-6** The "Most Active Technician" card opens that technician's profile.

### 6.3 Primary table with view tabs
- **FR-UI-7** A single results table driven by tabs: **Currently Out · Overdue ·
  Recent Returns · All Check-Outs · Needs Review**. Exactly one tab is "active"
  and visually indicated.
- **FR-UI-8** Column sets adapt per view (see §8.5).
- **FR-UI-9** Rows are clickable (open transaction + tool-history detail);
  technician names within rows are independently clickable (open technician
  profile) without triggering the row click.
- **FR-UI-10** The **Needs Review** tab shows a count badge and draws attention
  when exceptions exist.

### 6.4 Filters
- **FR-UI-11** Filters: **date range (from/to), technician, tool, van #**.
  Filters compose with the active tab. A **Clear** action resets them.
- **FR-UI-12** Filter option lists are populated dynamically from the data.

### 6.5 Sidebar
- **FR-UI-13** "Most Active Today" list ranking technicians by today's
  check-outs, each clickable to the technician profile, tagged with their van.

### 6.6 Drill-down: Technician profile (modal)
- **FR-UI-14** Header tags: van(s) used and nickname (from the source name).
- **FR-UI-15** Summary stats: currently out, overdue, returns logged, average
  time out.
- **FR-UI-16** Sub-tabbed lists: **Holding** (current), **Returns**, **All
  history** — switchable without closing the modal.

### 6.7 Drill-down: Transaction + tool history (modal)
- **FR-UI-17** Selected transaction details: tool, status, technician, van,
  checked-out date, returned date, time out.
- **FR-UI-18** **Tool history timeline:** every check-out and return of that tool
  across all technicians, in chronological order, visually distinguishing
  check-out vs. return events.

### 6.8 Data quality (Needs Review)
- **FR-UI-19** Lists exceptions: unmatched returns, unreadable/missing dates, and
  fuzzy auto-matches awaiting confirmation (see §8.6).
- **FR-UI-20** **Resolve action:** for an unmatched return, present the closest
  open check-outs for the same technician (ranked by name similarity) and allow
  a **manual link**. The link persists across refreshes within a session.

### 6.9 Refresh & export
- **FR-UI-21** Auto-refresh on a configurable interval (default 60s) without
  disrupting an open modal.
- **FR-UI-22** Print-optimized layout for save-to-PDF.

### 6.10 Non-functional (UI)
- Modern evergreen browsers; mouse + touch; no console errors; graceful
  degradation if a data source is briefly unavailable.

---

## 7. Status & Matching Logic (business rules)

### 7.1 Status derivation (per check-out record)
| Condition | Status |
|-----------|--------|
| Check-out date present, **no** matched return | **Checked Out** |
| Check-out date present, no return, **and** `now > checkout + RETURN_WINDOW` | **Overdue** |
| A matched return exists | **Returned** |
| No usable check-out date | **Unknown** (excluded from "currently out") |

`RETURN_WINDOW` is a configurable policy (prototype default: **7 days**).

### 7.2 Matching check-outs to returns
No shared key exists, so matching is heuristic, in passes:
1. **Exact (normalized) match** — same technician + same tool (case/space/
   punctuation-insensitive), earliest unused return dated **on or after** the
   check-out. First-in-first-out.
2. **Fuzzy fallback** — for still-unmatched check-outs: same technician, return
   on/after the check-out, and tool-name **similarity ≥ threshold** (prototype:
   Levenshtein ratio ≥ 0.82). Tuned so `Press jaw`≈`Press Jaws` matches but
   `Hammer`≠`MC Hammer`.
3. **Configured aliases** — declared spelling variants are folded to one
   canonical name before matching.
4. **Manual links** — exceptions resolved by a human in Needs Review.

> ⚠️ This heuristic matching is a direct consequence of the source data lacking
> identifiers (see §9.5). The single highest-value data change for a production
> build is to introduce a shared key.

---

## 8. DATA REQUIREMENTS (inputs & outputs) — primary section

### 8.1 Source systems / ingestion
| Layer | Detail |
|-------|--------|
| **Capture** | Formstack form on a shop tablet. Single form with a check-in/out selection plus fields below. |
| **System of record** | Microsoft Excel workbook in SharePoint Online (org-locked; not web-readable). |
| **Accessible feed** | A Google Sheet mirror with two tabs, `Checkouts` and `Returns`, published/readable as CSV. |
| **Ingestion method (prototype)** | Client-side fetch of each tab as CSV by tab name (Google `gviz` CSV endpoint), with cache-busting; default poll 60s. Read-only. |

**Production note:** the dev team should not assume the prototype's
publish-to-CSV approach is the final integration. Preferred options: the
**Formstack API / webhook**, the **Google Sheets API**, or **Microsoft Graph**
against the source Excel — each provides authenticated, reliable, schema-stable
access. The CSV approach was chosen to avoid backend/auth in the prototype.

### 8.2 Input entities

**Entity A — Check-Out Event** (one row per tool taken out)
**Entity B — Return Event** (one row per tool brought back)

Both share the same physical columns today (only the date field's meaning
differs). There is **no primary key, no foreign key, and no submission
timestamp** in the mapped columns.

### 8.3 Input data dictionary (per row)

| Field (as labeled) | Type | Example | Notes / known data-quality issues |
|--------------------|------|---------|-----------------------------------|
| `Name` | Text | `Cole, Mart (John)` | Format `"Last, First (Nickname)"`. Nickname optional. Must be parsed; same person should normalize consistently. |
| `Van #` | Text/Number | `1234`, `608` | Vehicle/route identifier per event. **Not stable per technician** (a tech may use multiple vans). Occasionally junk (`sdrg`). |
| `Tool Name` | Free text | `Jackhammer`, `1” mega press jaws`, `Shop vac ( check Monday)` | **Most problematic field.** Typos, singular/plural, embedded notes/parentheticals, and character-encoding artifacts (e.g., a corrupted inch mark rendering as `�`). No controlled vocabulary. |
| `Date Checked Out` *(Checkouts tab)* | Date (text) | `29-Jun-26` | Format `d-MMM-yy`, **date only (no time)**. Can be **blank**. |
| `Date Returned` *(Returns tab)* | Date (text) | `29-Jun-26` | Same format/constraints as above. |

> There is **no** Tool ID, Asset Tag, Transaction ID, Employee ID, submission
> timestamp, or quantity field in the current data. (Formstack captures a
> submission timestamp internally; it is **not** in the mapped columns and should
> be exposed in a production feed.)

### 8.4 Output: KPI definitions (calculations)

| KPI | Definition |
|-----|------------|
| **Check-outs Today** | Count of Check-Out events whose check-out date equals the current local date. |
| **Returns Today** | Count of Return events whose return date equals the current local date. |
| **Currently Out** | Count of Check-Out events with status `Checked Out` **or** `Overdue` (i.e., unmatched, dated check-outs). |
| **Overdue** | Count of Check-Out events with status `Overdue`. |
| **Average Time Out** | Mean of (return date − check-out date) across **matched/returned** records. |
| **Most Active Technician Today** | Technician with the greatest number of Check-Out events dated today (ties → first encountered). |

### 8.5 Output: table views & columns

| View | Population rule | Columns |
|------|-----------------|---------|
| **Currently Out** | status ∈ {Checked Out, Overdue}, oldest first | Tool, Technician, Van #, Checked Out, Days Out, Status |
| **Overdue** | status = Overdue | Tool, Technician, Van #, Checked Out, Overdue By, Status |
| **Recent Returns** | all Return events, newest first | Tool, Technician, Van #, Returned |
| **All Check-Outs** | all Check-Out events, newest first | Tool, Technician, Van #, Checked Out, Returned, Status |
| **Needs Review** | data exceptions (see §8.6) | Tool, Technician, Van #, Date, Issue |

### 8.6 Output: exception/"Needs Review" rules
A record surfaces for review when:
- A **Return event has no matching check-out** ("unmatched return").
- A record has a **missing/unreadable date**.
- A pairing was made by the **fuzzy** pass (flagged for human confirmation).

The data-health readout aggregates counts of auto-matched and unmatched returns.

### 8.7 Output: drill-down data
- **Technician profile:** all events for one technician → derived stats
  (currently out, overdue, returns logged, average time out), distinct vans, and
  three filtered lists (holding / returns / all).
- **Tool history:** all events (check-outs + returns) for one tool name, merged
  and sorted chronologically, each tagged as check-out or return with date,
  technician, and van.

### 8.8 Data transformations (required before output)
1. **Name normalization:** parse `"Last, First (Nick)"` → display `"First Last"`
   + nickname; normalize for grouping/matching.
2. **Tool-name cleansing:** replace encoding artifacts, collapse whitespace, trim
   embedded noise where configured; apply alias canonicalization.
3. **Date parsing:** accept `d-MMM-yy` and ISO; treat unparseable/blank as null.
4. **Exclusions:** drop configured **junk tool names** (e.g., `TEST`) and
   **specific rows** (matched on technician + tool + date, supporting blank-date
   targeting) — without nuking valid rows of the same tool.
5. **Matching & status derivation:** per §7.

### 8.9 Data quality, edge cases & assumptions the dev team must handle
- **No identifiers** → matching is heuristic and imperfect; expect false
  "still out" when names don't align. Plan for an exception/triage surface.
- **Free-text everything** → typos, plurals, embedded notes, encoding.
- **Date-only granularity** → cannot order or pair multiple same-day events
  precisely; "same day" return ambiguity exists.
- **Blank dates** → must be tolerated and surfaced, not crashed on.
- **Test/junk rows** appear in production data.
- **Mirror/seed artifacts:** the returns log may be seeded such that returns
  mirror check-outs (e.g., same-day), making everything read as returned. The
  tool reflects the data faithfully; this is a source-data concern.
- **Multiple vans per technician** is normal.
- **Latency:** CSV/publish feeds can cache for minutes; the feed choice affects
  freshness (mitigated with cache-busting in the prototype).

### 8.10 Strongly recommended source-data improvements (for production)
These dramatically reduce complexity and error:
1. **Add a shared Transaction/Tool key.** A unique **Tool ID / asset tag** on
   both the check-out and return submissions makes matching deterministic and
   eliminates the entire fuzzy-matching subsystem.
2. **Use the Formstack submission timestamp (date+time).** Removes blank/typo
   dates and enables precise event ordering and accurate "time out."
3. **Constrain form inputs.** Dropdowns (or a synced master list) for
   **Technician**, **Tool**, and **Van #** eliminate free-text variance at the
   source — the single biggest data-quality win.
4. **Consider a single combined event log** with a `Direction` (Out/In) field and
   one timestamp, instead of two parallel tabs — simpler to ingest and reason
   about.
5. **Optional master data:** a tool catalog (name, category/trade, asset value)
   enables value-at-risk reporting and trade tagging.

### 8.11 Security & privacy (data handling)
- Data contains **employee names** and **vehicle identifiers** → treat as
  internal. Keep repositories/hosting **private/authenticated** for a production
  build.
- The prototype is **read-only** and stores nothing server-side; any production
  caching/storage must respect the above.
- Avoid placing the data on public endpoints; if a public CSV feed is used,
  understand it is world-readable.

---

## 9. Non-Functional Requirements
- **Performance:** dataset is small (hundreds–low-thousands of rows); sub-second
  render. Should scale to tens of thousands client-side or move aggregation
  server-side beyond that.
- **Availability:** degrade gracefully if the feed is briefly unreachable.
- **Browser support:** current Chrome/Edge/Firefox/Safari.
- **Maintainability:** business rules (window, exclusions, aliases, thresholds,
  column mappings) are configuration, not code.
- **Auditability:** prefer feed methods that preserve a stable schema.

---

## 10. Assumptions, Constraints, Risks
- **Assumption:** the Google Sheet (or chosen feed) remains the accessible mirror
  of the Formstack data and keeps stable column headers.
- **Constraint:** SharePoint "publish to web" is disabled org-wide; direct,
  unauthenticated reads of the source Excel are not possible.
- **Risk:** heuristic matching accuracy depends on data-entry consistency;
  mitigated by aliases, fuzzy thresholds, and human review — best solved by §8.10.
- **Risk:** public CSV feeds expose internal data; prefer authenticated APIs.

---

## 11. Future Enhancements
- Overdue **notifications** (email/SMS/Teams) to technician or supervisor.
- **Tool master data** → value-at-risk, trade/category tagging, utilization.
- **Write-back / check-in from the dashboard** (would require auth).
- **Historical trends** (checkouts over time, overdue rate, per-tech reliability).
- **Authentication & roles** for multi-site rollout.

---

## 12. Glossary
- **Cage / tool crib:** central storage technicians draw tools from.
- **Check-out / Return event:** a single logged transaction in the respective log.
- **Currently out / Outstanding:** a check-out with no matched return.
- **Overdue:** outstanding beyond the allowed return window.
- **Matching:** the process of pairing a check-out to its return.
- **Needs Review:** the exception queue for un-derivable or low-confidence records.
