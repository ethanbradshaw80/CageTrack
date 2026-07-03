/* ============================================================
   CageTrack — APP LOGIC
   Reads a Check-Outs sheet + a Returns sheet, matches them,
   derives status, computes KPIs, renders a tabbed table +
   sidebar, and powers click drill-downs.
   ============================================================ */

let ALL_RECORDS = [];     // check-out records (each may be matched to a return)
let RETURN_EVENTS = [];   // every row from the Returns sheet
let RECORD_BY_ID = {};    // id -> check-out record
let RETURN_BY_ID = {};    // id -> return record
let SESSION_LINKS = [];   // manual links made in the Needs Review screen
let CURRENT_VIEW = "out";
let _idc = 0;
let _autoTimer = null;
let SEARCH_TERM = "";                    // free-text search within the current table view
let SORT = { key: null, dir: 1 };        // active column sort (null = view's default order)
let LAST_DATA = { checkouts: [], returns: [] };  // last filtered data, for cheap re-render on search/sort
let CURRENT_ROWS = [];                   // rows currently shown (for CSV export)
let CURRENT_COLS = [];                   // columns currently shown (for CSV export)

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

// Parses ISO dates AND the sheet's "29-May-26" / "9-Jun-26" day-month-year format.
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    if (mo != null) return new Date(yr, mo, parseInt(m[1], 10));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Date-only values show as "May 29"; values with a time show "Jun 26, 9:36 AM".
function fmt(d) {
  if (!d) return "—";
  let s = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (d.getHours() || d.getMinutes()) {
    s += ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return s;
}

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function hoursBetween(a, b) { return (b.getTime() - a.getTime()) / 3600000; }

// Day-friendly duration (this data is date-level).
function humanDuration(hrs) {
  if (hrs == null || isNaN(hrs)) return "—";
  if (hrs <= 0) return "same day";
  const days = hrs / 24;
  if (days < 1) return Math.round(hrs) + "h";
  return Math.round(days) + (Math.round(days) === 1 ? " day" : " days");
}

// Local-timezone yyyy-mm-dd (for <input type="date"> values)
function localISO(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// "Cole, Mart (John)" -> { display: "Mart Cole", nick: "John" }
function cleanTech(raw) {
  raw = String(raw || "").trim();
  let nick = "";
  const m = raw.match(/\(([^)]*)\)/);
  if (m) { nick = m[1].trim(); raw = raw.replace(/\([^)]*\)/, "").trim(); }
  let display = raw;
  if (raw.includes(",")) {
    const p = raw.split(",");
    const last = p[0].trim();
    const first = (p[1] || "").trim();
    display = (first ? first + " " : "") + last;
  }
  return { display: display || raw, nick };
}

/* ---------- Tool name cleanup ---------- */
const normTool = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Replace the corrupted inch-mark character with "x", collapse spaces, trim.
function cleanItem(raw) {
  return String(raw || "").replace(/�/g, "x").replace(/\s+/g, " ").trim();
}

// Build a lookup of {normalized variant -> canonical display name} once.
let ALIAS_LOOKUP = null;
function aliasLookup() {
  if (ALIAS_LOOKUP) return ALIAS_LOOKUP;
  ALIAS_LOOKUP = {};
  const al = CONFIG.TOOL_ALIASES || {};
  for (const canon in al) {
    ALIAS_LOOKUP[normTool(canon)] = canon;
    (al[canon] || []).forEach((v) => { ALIAS_LOOKUP[normTool(v)] = canon; });
  }
  return ALIAS_LOOKUP;
}
function canonicalTool(raw) {
  const cleaned = cleanItem(raw);
  return aliasLookup()[normTool(cleaned)] || cleaned;
}
// Should this row be dropped by tool name (test/junk)?
function isExcludedTool(item) {
  const ex = (CONFIG.EXCLUDE_TOOL_NAMES || []).map(normTool);
  return ex.includes(normTool(item));
}

// Should this SPECIFIC row be dropped (matched on tech + item + date)?
// An entry may set sheet: "checkouts" or "returns" to target only one side
// (e.g. remove a fabricated return without touching the same-named check-out).
function isExcludedRow(rec, side) {
  const rows = CONFIG.EXCLUDE_ROWS || [];
  const recDate = String(rec.checkoutTime || rec.returnTime || "").trim();
  return rows.some((e) =>
    (e.sheet == null || e.sheet === side) &&
    (e.technician == null || normTool(e.technician) === normTool(rec.technician)) &&
    (e.item == null || normTool(e.item) === normTool(rec.item)) &&
    (e.date == null || String(e.date).trim() === recDate)
  );
}

/* ---------- Status logic ---------- */
function deriveStatus(rec) {
  const out = rec._out, ret = rec._ret;
  const now = new Date();
  if (out && ret) return "Returned";
  if (out && !ret) {
    const dueAt = new Date(out.getTime() + CONFIG.RETURN_WINDOW_HOURS * 3600000);
    return now > dueAt ? "Overdue" : "Checked Out";
  }
  if (!out && ret) return "Returned";
  return "Unknown";
}
function dueDate(rec) {
  if (!rec._out) return null;
  return new Date(rec._out.getTime() + CONFIG.RETURN_WINDOW_HOURS * 3600000);
}

function enrich(raw) {
  const t = cleanTech(raw.technician);
  const rec = {
    id: "ROW-" + (_idc++),
    technician: t.display,
    nick: t.nick,
    branch: String(raw.van || raw.branch || "").trim(),   // "branch" internally = Van #
    item: canonicalTool(raw.item),                        // clean + consolidate variants
    checkoutTime: raw.checkoutTime || "",
    returnTime: raw.returnTime || "",
  };
  rec._out = parseDate(rec.checkoutTime);
  rec._ret = parseDate(rec.returnTime);
  rec.status = deriveStatus(rec);
  rec._due = dueDate(rec);
  return rec;
}

/* Name similarity 0..1 (Levenshtein ratio on normalized tool names). */
function similar(a, b) {
  a = normTool(a); b = normTool(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/* Match check-outs to returns: exact pass first, then a conservative fuzzy
   pass (same technician, return on/after check-out, high similarity). */
function matchRecords(checkouts, returns) {
  const cfg = CONFIG.MATCHING || {};
  const fuzzyOn = cfg.FUZZY !== false;
  const threshold = cfg.THRESHOLD != null ? cfg.THRESHOLD : 0.82;

  const byKey = {};   // exact: tech|tool -> returns
  const byTech = {};  // fuzzy pool: tech -> returns
  returns.forEach((r) => {
    const tk = normTool(r.technician);
    (byTech[tk] = byTech[tk] || []).push(r);
    const k = tk + "|" + normTool(r.item);
    (byKey[k] = byKey[k] || []).push(r);
  });
  for (const k in byKey) byKey[k].sort((a, b) => (a._ret || 0) - (b._ret || 0));

  const cos = checkouts.slice().sort((a, b) => (a._out || 0) - (b._out || 0));

  // Pass 1 — exact normalized name match
  cos.forEach((c) => {
    if (!c._out) return;
    const q = byKey[normTool(c.technician) + "|" + normTool(c.item)];
    if (!q) return;
    const m = q.find((r) => !r._used && r._ret && r._ret >= c._out);
    if (m) {
      m._used = true;
      c.returnTime = m.returnTime; c._ret = m._ret; c._matchType = "exact";
      c.status = deriveStatus(c);
    }
  });

  // Pass 2 — fuzzy fallback (same technician only)
  if (fuzzyOn) {
    cos.forEach((c) => {
      if (!c._out || c._ret) return;
      const pool = byTech[normTool(c.technician)] || [];
      let best = null, bestScore = 0;
      pool.forEach((r) => {
        if (r._used || !r._ret || r._ret < c._out) return;
        const s = similar(c.item, r.item);
        if (s > bestScore) { bestScore = s; best = r; }
      });
      if (best && bestScore >= threshold) {
        best._used = true;
        c.returnTime = best.returnTime; c._ret = best._ret;
        c._matchType = "fuzzy"; c._matchedName = best.item; c._matchScore = bestScore;
        c.status = deriveStatus(c);
      }
    });
  }
  return cos;
}

/* ============================================================
   DATA LOADING
   ============================================================ */
async function loadData() {
  _idc = 0;
  if (CONFIG.DATA_SOURCE === "live") return loadLive();
  // mock: single source already carries return times
  const recs = (MOCK_DATA || []).map((r) => enrich(r));
  RETURN_EVENTS = recs.filter((r) => r._ret);
  return recs;
}

async function loadLive() {
  const checkouts = await loadSheet(CONFIG.GOOGLE_SHEET_CHECKOUTS_CSV_URL, CONFIG.CHECKOUT_COLUMNS);
  let returns = [];
  const retUrl = CONFIG.GOOGLE_SHEET_RETURNS_CSV_URL;
  if (retUrl && !retUrl.includes("PASTE")) {
    returns = await loadSheet(retUrl, CONFIG.RETURN_COLUMNS);
  }
  RETURN_EVENTS = returns.filter((r) => r._ret);
  const matched = matchRecords(checkouts, returns);
  applyConfigLinks(matched, returns);
  applySessionLinks(matched, returns);
  return matched;
}

/* Reviewed, permanent pairings from CONFIG.MANUAL_LINKS (tech + item + date). */
function applyConfigLinks(checkouts, returns) {
  (CONFIG.MANUAL_LINKS || []).forEach((L) => {
    const c = checkouts.find((x) => !x._ret &&
      normTool(x.technician) === normTool(L.technician) &&
      normTool(x.item) === normTool(L.checkoutItem) &&
      (!L.checkoutDate || (x._out && localISO(x._out) === L.checkoutDate)));
    const ret = returns.find((x) => !x._used &&
      normTool(x.technician) === normTool(L.technician) &&
      normTool(x.item) === normTool(L.returnItem) &&
      (!L.returnDate || (x._ret && localISO(x._ret) === L.returnDate)));
    if (c && ret) applyOneLink(c, ret);
  });
}

/* Manual links survive a refresh by matching on content, not row id. */
function linkSig(r, dateKey) {
  return normTool(r.technician) + "|" + normTool(r.item) + "|" + ((r[dateKey] && r[dateKey].getTime()) || 0);
}
function applyOneLink(c, ret) {
  c.returnTime = ret.returnTime; c._ret = ret._ret;
  c._matchType = "manual"; c._matchedName = ret.item;
  c.status = deriveStatus(c); ret._used = true;
}
function applySessionLinks(checkouts, returns) {
  SESSION_LINKS.forEach((L) => {
    const c = checkouts.find((x) => !x._ret && linkSig(x, "_out") === L.co);
    const ret = returns.find((x) => !x._used && linkSig(x, "_ret") === L.ret);
    if (c && ret) applyOneLink(c, ret);
  });
}
function linkReturn(coId, retId) {
  const c = RECORD_BY_ID[coId], ret = RETURN_BY_ID[retId];
  if (!c || !ret) return;
  SESSION_LINKS.push({ co: linkSig(c, "_out"), ret: linkSig(ret, "_ret") });
  applyOneLink(c, ret);
  closeModal();
  renderAll();
}

/* Fetch with automatic retries — absorbs transient network/Google blips
   at the request level so they never surface to the user. */
async function fetchWithRetry(url, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(url + sep + "_cb=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw new Error("Failed to fetch sheet after " + tries + " tries: " + (lastErr && lastErr.message));
}

async function loadSheet(url, colmap) {
  if (!url || url.includes("PASTE")) return [];
  const side = ("returnTime" in colmap) ? "returns" : "checkouts";
  const res = await fetchWithRetry(url, 3);
  const rows = parseCSV(await res.text());
  if (!rows.length) return [];
  const headers = rows[0];
  const idx = {};
  for (const key in colmap) idx[key] = headers.indexOf(colmap[key]);
  return rows.slice(1).map((cells) => {
    const raw = {};
    for (const key in colmap) raw[key] = idx[key] > -1 ? cells[idx[key]] : "";
    return enrich(raw);
  }).filter((r) => (r.technician || r.item) && !isExcludedTool(r.item) && !isExcludedRow(r, side));
}

/* CSV parser that handles quoted fields + commas inside quotes */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c && c.trim() !== ""));
}

/* ============================================================
   FILTERS
   ============================================================ */
function getFilters() {
  return {
    from: parseDate($("fromDate").value),
    to: parseDate($("toDate").value),
    tech: $("fTech").value,
    item: $("fItem").value,
    branch: $("fBranch").value,
  };
}

function applyFilters(records, dateKey) {
  const f = getFilters();
  dateKey = dateKey || "_out";
  return records.filter((r) => {
    const d = r[dateKey] || r._out || r._ret;
    if (f.from && d && d < f.from) return false;
    if (f.to) { const end = new Date(f.to.getTime() + 864e5 - 1); if (d && d > end) return false; }
    if (f.tech && r.technician !== f.tech) return false;
    if (f.item && r.item !== f.item) return false;
    if (f.branch && r.branch !== f.branch) return false;
    return true;
  });
}

function populateFilterOptions(records) {
  fillSelect("fTech", uniq(records.map((r) => r.technician)));
  fillSelect("fItem", uniq(records.map((r) => r.item)));
  fillSelect("fBranch", uniq(records.map((r) => r.branch)));
}
function uniq(arr) { return [...new Set(arr.filter(Boolean))].sort(); }
function fillSelect(id, values) {
  const sel = $(id);
  const current = sel.value;
  const placeholder = sel.options.length ? sel.options[0].textContent : "All";
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  sel.value = current;
}

/* ============================================================
   KPIs
   ============================================================ */
function renderKPIs(checkouts, returns) {
  const now = new Date();
  const checkoutsToday = checkouts.filter((r) => isSameDay(r._out, now)).length;
  const returnsToday = returns.filter((r) => isSameDay(r._ret, now)).length;
  const outstanding = checkouts.filter((r) => r.status === "Checked Out" || r.status === "Overdue").length;
  const overdue = checkouts.filter((r) => r.status === "Overdue").length;

  const matched = checkouts.filter((r) => r.status === "Returned" && r._out && r._ret);
  const avg = matched.length
    ? matched.reduce((s, r) => s + hoursBetween(r._out, r._ret), 0) / matched.length : null;

  const counts = {};
  checkouts.filter((r) => isSameDay(r._out, now)).forEach((r) => { counts[r.technician] = (counts[r.technician] || 0) + 1; });
  let topTech = "—", topN = 0;
  for (const t in counts) if (counts[t] > topN) { topN = counts[t]; topTech = t; }

  $("kpiCheckouts").textContent = checkoutsToday;
  $("kpiReturns").textContent = returnsToday;
  $("kpiOutstanding").textContent = outstanding;
  $("kpiOverdue").textContent = overdue;
  // only show the red "danger" styling when something is actually overdue
  const odCard = $("kpiOverdue").closest(".kpi-card");
  if (odCard) odCard.classList.toggle("kpi-danger", overdue > 0);
  // surface the overdue count in the browser tab title
  document.title = (overdue > 0 ? `(${overdue}) ` : "") + "CageTrack — Peterman Brothers";
  $("kpiAvgReturn").textContent = humanDuration(avg);
  $("kpiTopTech").textContent = topN ? `${topTech} (${topN})` : "—";
  $("kpiTopTechCard").dataset.tech = topN ? topTech : "";
}

/* ============================================================
   TABLE VIEWS
   ============================================================ */
function statusPill(status) {
  const map = { "Checked Out": "pill-out", "Overdue": "pill-overdue", "Returned": "pill-returned", "Unknown": "pill-unknown" };
  return `<span class="pill ${map[status] || ""}">${esc(status)}</span>`;
}

// Heat tier for how long something has been out, relative to the overdue window.
function heatClass(hrs) {
  const w = CONFIG.RETURN_WINDOW_HOURS || 168;
  if (hrs >= w) return "heat-hot";        // overdue
  if (hrs >= w * 0.5) return "heat-warn"; // getting there
  return "heat-ok";                        // fresh
}

// Each column: l=label, f=cell HTML, plain=text (for CSV/search), sortVal=comparable value
const COL = {
  item:   { key: "item", l: "Tool", cls: "col-item", f: (r) => esc(r.item) || "—",
            plain: (r) => r.item || "", sortVal: (r) => (r.item || "").toLowerCase() },
  tech:   { key: "tech", l: "Technician", f: (r) => `<button class="tech-link" data-tech="${esc(r.technician)}">${esc(r.technician)}</button>`,
            plain: (r) => r.technician || "", sortVal: (r) => (r.technician || "").toLowerCase() },
  van:    { key: "van", l: "Van #", f: (r) => esc(r.branch) || "—",
            plain: (r) => r.branch || "", sortVal: (r) => r.branch || "" },
  out:    { key: "out", l: "Checked Out", f: (r) => fmt(r._out),
            plain: (r) => fmt(r._out), sortVal: (r) => (r._out ? r._out.getTime() : 0) },
  ret:    { key: "ret", l: "Returned", f: (r) => fmt(r._ret),
            plain: (r) => fmt(r._ret), sortVal: (r) => (r._ret ? r._ret.getTime() : 0) },
  daysOut:{ key: "daysOut", l: "Days Out", f: (r) => (r._out ? `<span class="heat ${heatClass(hoursBetween(r._out, new Date()))}">${humanDuration(hoursBetween(r._out, new Date()))}</span>` : "—"),
            plain: (r) => (r._out ? humanDuration(hoursBetween(r._out, new Date())) : ""), sortVal: (r) => (r._out ? hoursBetween(r._out, new Date()) : -1) },
  over:   { key: "over", l: "Overdue By", f: (r) => `<span class="overdue-by">${r._due ? humanDuration(hoursBetween(r._due, new Date())) : "—"}</span>`,
            plain: (r) => (r._due ? humanDuration(hoursBetween(r._due, new Date())) : ""), sortVal: (r) => (r._due ? hoursBetween(r._due, new Date()) : -1) },
  status: { key: "status", l: "Status", f: (r) => statusPill(r.status) + autoMark(r),
            plain: (r) => r.status || "", sortVal: (r) => r.status || "" },
  reviewDate: { key: "reviewDate", l: "Date", f: (r) => fmt(r._date),
            plain: (r) => fmt(r._date), sortVal: (r) => (r._date ? r._date.getTime() : 0) },
  issue: { key: "issue", l: "Needs Review", f: (r) => `<span class="issue-chip issue-${r._issueType}">${esc(r._issue)}</span>`,
            plain: (r) => r._issue || "", sortVal: (r) => r._issue || "" },
};

// Compare helper: numbers numerically, everything else with natural (numeric-aware) collation.
function cmpVals(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
// Concatenated searchable text for a row.
function rowSearchText(r) {
  return [r.item, r.technician, r.branch, fmt(r._out), fmt(r._ret), fmt(r._date), r.status, r._issue]
    .filter(Boolean).join(" ").toLowerCase();
}

function autoMark(r) {
  if (r._matchType === "fuzzy") return ` <span class="auto-dot" title="Auto-matched to return “${esc(r._matchedName)}”">~</span>`;
  if (r._matchType === "manual") return ` <span class="auto-dot ok" title="Manually linked to “${esc(r._matchedName)}”">✓</span>`;
  return "";
}

const VIEWS = {
  out: {
    title: "Currently Out",
    rows: (d) => d.checkouts.filter((r) => r.status === "Checked Out" || r.status === "Overdue")
                  .sort((a, b) => (a._out || 0) - (b._out || 0)),
    cols: [COL.item, COL.tech, COL.van, COL.out, COL.daysOut, COL.status],
    empty: "Nothing is checked out right now.",
  },
  overdue: {
    title: "Overdue",
    rows: (d) => d.checkouts.filter((r) => r.status === "Overdue").sort((a, b) => (a._out || 0) - (b._out || 0)),
    cols: [COL.item, COL.tech, COL.van, COL.out, COL.over, COL.status],
    empty: "No overdue tools. 🎉",
  },
  returns: {
    title: "Recent Returns",
    rows: (d) => d.returns.slice().sort((a, b) => (b._ret || 0) - (a._ret || 0)).slice(0, 200),
    cols: [COL.item, COL.tech, COL.van, COL.ret],
    empty: "No returns in this range.",
  },
  all: {
    title: "All Check-Outs",
    rows: (d) => d.checkouts.slice().sort((a, b) => (b._out || 0) - (a._out || 0)).slice(0, 400),
    cols: [COL.item, COL.tech, COL.van, COL.out, COL.ret, COL.status],
    empty: "No check-outs in this range.",
  },
  review: {
    title: "Needs Review",
    rows: () => buildReviewRows(),
    cols: [COL.item, COL.tech, COL.van, COL.reviewDate, COL.issue],
    empty: "Nothing needs review — all clean! 🎉",
  },
};

/* Has a human reviewed this orphan return and confirmed the cause?
   (Entries live in CONFIG.REVIEWED_OK; matched on tech + item + date.) */
function isReviewedOk(rec) {
  return (CONFIG.REVIEWED_OK || []).some((e) =>
    normTool(e.technician) === normTool(rec.technician) &&
    normTool(e.item) === normTool(rec.item) &&
    (!e.date || (rec._ret && localISO(rec._ret) === e.date) || (rec._out && localISO(rec._out) === e.date)));
}

/* Data-quality rows: unmatched returns, unreadable dates, and fuzzy
   auto-matches that a human should confirm. Ignores filters (it's a fix-it list). */
function buildReviewRows() {
  const rows = [];
  RETURN_EVENTS.filter((r) => !r._used && !isReviewedOk(r)).forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: r._ret, _issue: "Return with no matching check-out", _issueType: "unmatched",
  }));
  ALL_RECORDS.filter((r) => !r._out).forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: null, _issue: "Check-out has no readable date", _issueType: "nodate",
  }));
  RETURN_EVENTS.filter((r) => !r._ret).forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: null, _issue: "Return has no readable date", _issueType: "nodate",
  }));
  ALL_RECORDS.filter((r) => r._matchType === "fuzzy").forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: r._out, _issue: `Auto-matched to “${r._matchedName}” — verify`, _issueType: "fuzzy",
  }));
  return rows;
}

function renderMain(data) {
  const v = VIEWS[CURRENT_VIEW] || VIEWS.out;
  let rows = v.rows(data);

  // free-text search within the current view
  const term = SEARCH_TERM.trim().toLowerCase();
  if (term) rows = rows.filter((r) => rowSearchText(r).includes(term));

  // column sort (overrides the view's default order)
  if (SORT.key) {
    const col = v.cols.find((c) => c.key === SORT.key);
    if (col && col.sortVal) rows = rows.slice().sort((a, b) => SORT.dir * cmpVals(col.sortVal(a), col.sortVal(b)));
  }

  $("mainTitle").textContent = v.title;
  $("mainCount").textContent = rows.length;
  CURRENT_ROWS = rows;
  CURRENT_COLS = v.cols;

  const thead = $("tblMain").querySelector("thead");
  const tbody = $("tblMain").querySelector("tbody");
  thead.innerHTML = "<tr>" + v.cols.map((c) => {
    const arrow = SORT.key === c.key ? (SORT.dir === 1 ? " ▲" : " ▼") : "";
    return c.sortVal
      ? `<th class="sortable" data-sortkey="${c.key}">${c.l}${arrow}</th>`
      : `<th>${c.l}</th>`;
  }).join("") + "</tr>";

  if (!rows.length) {
    const msg = term ? `No matches for “${esc(SEARCH_TERM.trim())}”.` : v.empty;
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${v.cols.length}">${msg}</td></tr>`;
  } else {
    tbody.innerHTML = rows.map((r) =>
      `<tr data-txid="${esc(r.id)}"${r.status === "Overdue" ? ' class="row-overdue"' : ""}>` +
      v.cols.map((c) => `<td class="${c.cls || ""}">${c.f(r)}</td>`).join("") + "</tr>"
    ).join("");
  }
  // Only the tabs show the active view. (KPI cards are shortcuts — highlighting
  // them caused confusion since several map to the same view.)
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === CURRENT_VIEW));
}

/* Download the current view (after search/sort) as CSV. */
function exportCurrentView() {
  const cols = CURRENT_COLS, rows = CURRENT_ROWS;
  if (!cols || !cols.length) return;
  const cell = (s) => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.map((c) => cell(c.l)).join(",")]
    .concat(rows.map((r) => cols.map((c) => cell(c.plain ? c.plain(r) : "")).join(",")))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const name = ((VIEWS[CURRENT_VIEW] || {}).title || "view").replace(/\s+/g, "-").toLowerCase();
  const a = document.createElement("a");
  a.href = url;
  a.download = `cagetrack-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   SIDEBAR — Most Active Today
   ============================================================ */
function renderTopTechList(checkouts) {
  const el = $("topTechList");
  const now = new Date();
  const counts = {};
  checkouts.filter((r) => isSameDay(r._out, now)).forEach((r) => { counts[r.technician] = (counts[r.technician] || 0) + 1; });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) { el.innerHTML = `<div class="toplist-empty">No check-outs recorded today.</div>`; return; }
  const max = ranked[0][1];
  el.innerHTML = ranked.map(([name, n], i) => {
    const van = getTechProfile(name).van;
    return `<div class="toplist-row ${i === 0 ? "top" : ""}" data-tech="${esc(name)}">
      <span class="toplist-name">${esc(name)} ${vanMini(van)}</span>
      <span class="toplist-count">${n}</span>
      <span class="toplist-bar"><span style="width:${Math.round((n / max) * 100)}%"></span></span>
    </div>`;
  }).join("");
}

// Overdue tools grouped by technician — shown only when there are overdue items.
function renderOverdueByTech(checkouts) {
  const panel = $("overduePanel"), el = $("overdueByTech");
  if (!panel || !el) return;
  const counts = {};
  checkouts.filter((r) => r.status === "Overdue").forEach((r) => { counts[r.technician] = (counts[r.technician] || 0) + 1; });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) { panel.hidden = true; el.innerHTML = ""; return; }
  panel.hidden = false;
  el.innerHTML = ranked.map(([name, n]) =>
    `<div class="toplist-row od" data-tech="${esc(name)}">
      <span class="toplist-name">${esc(name)} ${vanMini(getTechProfile(name).van)}</span>
      <span class="toplist-count od-count">${n}</span>
    </div>`).join("");
}

// Most checked-out tools in the current range — demand signal for procurement.
function renderTopTools(checkouts) {
  const el = $("topToolsList");
  if (!el) return;
  const counts = {};
  checkouts.forEach((r) => { if (r.item && r._out) counts[r.item] = (counts[r.item] || 0) + 1; });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!ranked.length) { el.innerHTML = `<div class="toplist-empty">No check-outs in this range.</div>`; return; }
  const max = ranked[0][1];
  el.innerHTML = ranked.map(([name, n], i) =>
    `<div class="toplist-row ${i === 0 ? "top" : ""}" data-tool="${esc(name)}">
      <span class="toplist-name">${esc(name)}</span>
      <span class="toplist-count">${n}</span>
      <span class="toplist-bar"><span style="width:${Math.round((n / max) * 100)}%"></span></span>
    </div>`).join("");
}

/* ---------- Saved searches (persisted in the browser) ---------- */
const SS_KEY = "cagetrack.savedSearches";
function getSavedSearches() { try { return JSON.parse(localStorage.getItem(SS_KEY) || "[]"); } catch (e) { return []; } }
function setSavedSearches(arr) { try { localStorage.setItem(SS_KEY, JSON.stringify(arr)); } catch (e) {} }
function renderSavedSearches() {
  const el = $("savedSearches"); if (!el) return;
  const arr = getSavedSearches();
  el.innerHTML = arr.length
    ? `<span class="ss-label">Saved:</span>` + arr.map((s) =>
        `<span class="ss-chip" data-search="${esc(s)}">${esc(s)}<button class="ss-x" data-remove="${esc(s)}" title="Remove" aria-label="Remove">×</button></span>`).join("")
    : "";
}
function saveCurrentSearch() {
  const term = SEARCH_TERM.trim(); if (!term) return;
  const arr = getSavedSearches();
  if (!arr.includes(term)) { arr.push(term); setSavedSearches(arr); renderSavedSearches(); }
}
function applySavedSearch(term) {
  SEARCH_TERM = term;
  if ($("tableSearch")) $("tableSearch").value = term;
  renderMain(LAST_DATA);
}
function removeSavedSearch(term) {
  setSavedSearches(getSavedSearches().filter((s) => s !== term));
  renderSavedSearches();
}

/* ============================================================
   TECH PROFILE (van tags — derived from the sheet)
   ============================================================ */
function getTechProfile(name) {
  const counts = {};
  ALL_RECORDS.filter((r) => r.technician === name).forEach((r) => { if (r.branch) counts[r.branch] = (counts[r.branch] || 0) + 1; });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { van: ranked[0] ? ranked[0][0] : "", vans: ranked.map((e) => e[0]) };
}
function vanPill(v) { return v ? `<span class="tag-pill tag-branch"><span class="tp-dot"></span><span class="tp-label">Van ${esc(v)}</span></span>` : ""; }
function vanMini(v) { return v ? `<span class="trade-mini van-mini">Van ${esc(v)}</span>` : ""; }

/* ============================================================
   MODALS
   ============================================================ */
function openModal(title, html) { $("modalTitle").textContent = title; $("modalBody").innerHTML = html; $("modal").hidden = false; }
function closeModal() { $("modal").hidden = true; }

let TECH_GROUPS = { holding: [], returns: [], all: [] };
const TECH_EMPTY = { holding: "Nothing checked out right now.", returns: "No returns on record.", all: "No activity on record." };

function techItemHtml(r) {
  let tail;
  if (r.status === "Overdue") tail = `<span class="overdue-by">${r._due ? humanDuration(hoursBetween(r._due, new Date())) : "—"} over</span>`;
  else if (r.status === "Returned" || r._ret) tail = r._out ? `out ${humanDuration(hoursBetween(r._out, r._ret))}` : "";
  else tail = r._out ? `out ${humanDuration(hoursBetween(r._out, new Date()))}` : "no date";
  const when = (r.status === "Returned" || r._ret) && !r._out ? `returned ${fmt(r._ret)}`
    : r._ret ? `returned ${fmt(r._ret)}` : `since ${fmt(r._out)}`;
  return `<div class="m-item"><div><div class="mi-name">${esc(r.item) || "—"}</div>
    <div class="mi-meta">Van ${esc(r.branch) || "—"} · ${when}</div></div>
    <div style="text-align:right">${statusPill(r.status)}<div class="mi-meta">${tail}</div></div></div>`;
}
function renderTechSubList(key) {
  const list = TECH_GROUPS[key] || [];
  const el = $("mTechList");
  if (!el) return;
  el.innerHTML = list.length ? list.map(techItemHtml).join("") : `<div class="m-empty">${TECH_EMPTY[key]}</div>`;
  document.querySelectorAll(".mtab").forEach((t) => t.classList.toggle("active", t.dataset.mtab === key));
}

function showTechModal(name) {
  const recs = ALL_RECORDS.filter((r) => r.technician === name);
  const retEvents = RETURN_EVENTS.filter((r) => r.technician === name);
  if (!recs.length && !retEvents.length) return;

  const holding = recs.filter((r) => r.status === "Checked Out" || r.status === "Overdue").sort((a, b) => (a._out || 0) - (b._out || 0));
  const overdue = recs.filter((r) => r.status === "Overdue");
  const matched = recs.filter((r) => r.status === "Returned" && r._out && r._ret);
  const avg = matched.length ? humanDuration(matched.reduce((s, r) => s + hoursBetween(r._out, r._ret), 0) / matched.length) : "—";
  const prof = getTechProfile(name);
  const nick = recs.find((r) => r.nick)?.nick || retEvents.find((r) => r.nick)?.nick || "";

  TECH_GROUPS = {
    holding,
    returns: retEvents.slice().sort((a, b) => (b._ret || 0) - (a._ret || 0)),
    all: recs.slice().sort((a, b) => ((b._ret || b._out || 0) - (a._ret || a._out || 0))),
  };

  const tags = `<div class="tags-row">${prof.vans.map(vanPill).join("")}${nick ? `<span class="tag-pill tag-nick"><span class="tp-label">“${esc(nick)}”</span></span>` : ""}</div>`;
  const stats = tags + `
    <div class="m-stats">
      <div class="m-stat"><div class="l">Currently Out</div><div class="v">${holding.length}</div></div>
      <div class="m-stat ${overdue.length ? "danger" : ""}"><div class="l">Overdue</div><div class="v">${overdue.length}</div></div>
      <div class="m-stat"><div class="l">Returns Logged</div><div class="v">${retEvents.length}</div></div>
      <div class="m-stat"><div class="l">Avg Time Out</div><div class="v">${avg}</div></div>
    </div>`;
  const tabbar = `
    <div class="m-tabs">
      <button class="mtab active" data-mtab="holding">Holding (${TECH_GROUPS.holding.length})</button>
      <button class="mtab" data-mtab="returns">Returns (${TECH_GROUPS.returns.length})</button>
      <button class="mtab" data-mtab="all">All Check-Outs (${TECH_GROUPS.all.length})</button>
    </div>
    <div class="m-list" id="mTechList"></div>`;

  openModal(name, stats + tabbar);
  renderTechSubList("holding");
}

function openResolveModal(retId) {
  const ret = RETURN_BY_ID[retId];
  if (!ret) return;
  const cands = ALL_RECORDS
    .filter((c) => c.technician === ret.technician && !c._ret && (!ret._ret || !c._out || c._out <= ret._ret))
    .map((c) => ({ c, score: similar(c.item, ret.item) }))
    .sort((a, b) => (b.score - a.score) || ((b.c._out || 0) - (a.c._out || 0)))
    .slice(0, 8);

  const head = `<div class="m-sub" style="margin-top:0">Unmatched return</div>
    <div class="m-item"><div><div class="mi-name">${esc(ret.item)}</div>
      <div class="mi-meta">${esc(ret.technician)} · Van ${esc(ret.branch) || "—"} · returned ${fmt(ret._ret)}</div></div></div>`;

  const list = cands.length ? cands.map(({ c, score }) => {
    const held = c._out ? humanDuration(hoursBetween(c._out, ret._ret || new Date())) : "—";
    return `<div class="cand">
      <div><div class="mi-name">${esc(c.item)}</div>
        <div class="mi-meta">out ${fmt(c._out)} · ${held} held · <strong>${Math.round(score * 100)}% name match</strong></div></div>
      <button class="btn btn-primary btn-sm" data-link-co="${esc(c.id)}" data-link-ret="${esc(retId)}">Link</button>
    </div>`;
  }).join("") : `<div class="m-empty">No open check-outs for ${esc(ret.technician)} to link this to.</div>`;

  openModal("Resolve return", head +
    `<div class="m-sub">Closest open check-outs</div><div class="cand-list">${list}</div>
     <div class="resolve-note">Linking fixes it here for this session (it survives refreshes). To make it permanent, fix the names in the sheet/form or add a tool alias in <code>config.js</code>.</div>`);
}

function showTxModal(id) {
  const r = RECORD_BY_ID[id];
  if (!r) return;
  const tail = r._ret ? `out ${humanDuration(hoursBetween(r._out, r._ret))}`
    : (r.status === "Overdue" ? `<span class="overdue-by">${r._due ? humanDuration(hoursBetween(r._due, new Date())) : "—"} overdue</span>` : "still out");

  // Full history for this tool — every check-out and return across all techs
  const key = normTool(r.item);
  const events = [];
  ALL_RECORDS.forEach((x) => { if (x._out && normTool(x.item) === key) events.push({ t: "out", d: x._out, tech: x.technician, van: x.branch }); });
  RETURN_EVENTS.forEach((x) => { if (x._ret && normTool(x.item) === key) events.push({ t: "in", d: x._ret, tech: x.technician, van: x.branch }); });
  events.sort((a, b) => (a.d - b.d));
  const histHtml = events.length ? events.map((e) =>
    `<div class="hist-row"><span class="hist-dot hist-${e.t}"></span>` +
    `<span class="hist-when">${fmt(e.d)}</span>` +
    `<span class="hist-act">${e.t === "out" ? "Checked out" : "Returned"}</span>` +
    `<span class="hist-who">${esc(e.tech)}${e.van ? " · Van " + esc(e.van) : ""}</span></div>`).join("")
    : `<div class="m-empty">No history on record.</div>`;

  openModal(r.item || "Tool", `
    <div style="margin-bottom:16px">${statusPill(r.status)}</div>
    <dl class="m-def">
      <dt>Technician</dt><dd><button class="tech-link" data-tech="${esc(r.technician)}">${esc(r.technician)}</button>${r.nick ? ` (“${esc(r.nick)}”)` : ""}</dd>
      <dt>Van #</dt><dd>${esc(r.branch) || "—"}</dd>
      <dt>Checked Out</dt><dd>${fmt(r._out)}</dd>
      <dt>Returned</dt><dd>${r._ret ? fmt(r._ret) + (r._matchType === "fuzzy" ? ` <span class="auto-badge" title="The check-out and return names didn’t match exactly">~ auto-matched “${esc(r._matchedName)}”</span>` : "") : "—"}</dd>
      <dt>Time Out</dt><dd>${tail}</dd>
    </dl>
    <div class="m-sub">Tool history (${events.length})</div>
    <div class="hist-list">${histHtml}</div>`);
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */
function renderAll() {
  const checkouts = applyFilters(ALL_RECORDS, "_out");
  const returns = applyFilters(RETURN_EVENTS, "_ret");
  LAST_DATA = { checkouts, returns };
  renderKPIs(checkouts, returns);
  renderMain(LAST_DATA);
  renderTopTechList(checkouts);
  renderOverdueByTech(checkouts);
  renderTopTools(checkouts);
  $("rowCount").textContent = `${checkouts.length} check-outs · ${returns.length} returns`;

  // Freshness: the newest entry across both sheets (global, not filtered)
  const stamps = ALL_RECORDS.map((r) => r._out).concat(RETURN_EVENTS.map((r) => r._ret))
    .filter(Boolean).map((d) => d.getTime());
  $("dataFreshness").textContent = stamps.length
    ? "Latest entry: " + fmt(new Date(Math.max.apply(null, stamps))) : "";

  // Data-health readout (global, not filtered)
  const fuzzy = ALL_RECORDS.filter((r) => r._matchType === "fuzzy").length;
  const unmatched = RETURN_EVENTS.filter((r) => !r._used && !isReviewedOk(r)).length;
  const bits = [];
  if (fuzzy) bits.push(`~${fuzzy} auto-matched`);
  if (unmatched) bits.push(`${unmatched} unmatched return${unmatched === 1 ? "" : "s"}`);
  $("dataHealth").textContent = bits.length ? "⚠ " + bits.join(" · ") : "";

  // Needs Review tab count + attention styling
  const reviewCount = buildReviewRows().length;
  const rt = document.querySelector('.tab[data-view="review"]');
  if (rt) {
    rt.textContent = reviewCount ? `Needs Review (${reviewCount})` : "Needs Review";
    rt.classList.toggle("has-issues", reviewCount > 0);
  }
}
function setView(view) { if (VIEWS[view]) { CURRENT_VIEW = view; SORT = { key: null, dir: 1 }; renderAll(); } }
function resetAll() {
  ["fromDate", "toDate", "fTech", "fItem", "fBranch"].forEach((id) => ($(id).value = ""));
  CURRENT_VIEW = "out"; SEARCH_TERM = ""; SORT = { key: null, dir: 1 };
  if ($("tableSearch")) $("tableSearch").value = "";
  closeModal(); renderAll();
}

/* ---------- Escape HTML ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Brand ---------- */
function renderBrand() {
  const b = CONFIG.BRAND || {};
  const company = b.companyName || "Peterman Brothers";
  const product = b.productName || "CageTrack";
  const tagline = b.tagline || "Tool Check-Out Tracker";
  const productHtml = esc(product).replace("Track", '<span class="accent">Track</span>');
  if (b.logoUrl) {
    $("brandSlot").innerHTML = `
      <img class="brand-logo" src="${esc(b.logoUrl)}" alt="${esc(company)} logo"
        onerror="this.outerHTML='<div class=&quot;brand-mark&quot;>P</div>'" />
      <span class="brand-divider"></span>
      <div class="brand-text"><div class="brand-product">${productHtml}</div>
        <div class="brand-tagline">${esc(tagline)}</div></div>`;
  } else {
    $("brandSlot").innerHTML = `
      <div class="brand-mark">P</div>
      <div class="brand-text"><div class="brand-company">${esc(company)}</div>
        <div class="brand-product">${productHtml}</div><div class="brand-tagline">${esc(tagline)}</div></div>`;
  }
}

/* ---------- Theme (light / dark) ---------- */
function applyTheme(t) {
  const root = document.documentElement;
  root.classList.add("theme-switching");     // freeze transitions so var()-based backgrounds swap instantly
  root.dataset.theme = t;
  void root.offsetWidth;                       // commit the new colors with transitions off
  requestAnimationFrame(() => root.classList.remove("theme-switching"));
  const btn = $("themeToggle");
  if (btn) { btn.setAttribute("aria-checked", String(t === "dark")); btn.title = t === "dark" ? "Switch to light mode" : "Switch to dark mode"; }
  try { localStorage.setItem("cagetrack.theme", t); } catch (e) {}
}
function initTheme() {
  let t = document.documentElement.dataset.theme;
  if (!t) { try { t = localStorage.getItem("cagetrack.theme"); } catch (e) {} }
  applyTheme(t || "light");
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

/* ---------- Clock ---------- */
function startClock() {
  const tick = () => {
    const now = new Date();
    $("clockTime").textContent = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    $("clockDate").textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };
  tick(); setInterval(tick, 30000);
}

/* ============================================================
   INIT
   ============================================================ */
let _refreshing = false;
let _failCount = 0;   // consecutive fetch failures
async function refresh() {
  if (_refreshing) return;              // don't let the 60s timer race a slow fetch
  _refreshing = true;
  const rb = $("refreshBtn");
  if (rb) { rb.classList.add("busy"); rb.disabled = true; }
  try {
    ALL_RECORDS = await loadData();
    RECORD_BY_ID = {}; RETURN_BY_ID = {};
    ALL_RECORDS.forEach((r) => { RECORD_BY_ID[r.id] = r; });
    RETURN_EVENTS.forEach((r) => { RETURN_BY_ID[r.id] = r; });
    populateFilterOptions(ALL_RECORDS.concat(RETURN_EVENTS));
    renderAll();
    const auto = CONFIG.AUTO_REFRESH_SECONDS > 0 ? ` · auto ${CONFIG.AUTO_REFRESH_SECONDS}s` : "";
    $("lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString() + auto;
    _failCount = 0;
    $("errorBanner").hidden = true;     // back online — clear any warning
  } catch (err) {
    // Never block with alert() — keep the last good data and stay calm about
    // single blips: only surface the banner after 2+ consecutive failures.
    console.error(err);
    _failCount++;
    const hasData = ALL_RECORDS.length > 0 || RETURN_EVENTS.length > 0;
    if (!hasData || _failCount >= 2) {
      $("errorText").textContent = hasData
        ? "Couldn't reach the sheet — showing the last loaded data. Will keep retrying automatically."
        : "Couldn't load data: " + err.message;
      $("errorBanner").hidden = false;
    }
    // after a first failure, retry quickly instead of waiting the full interval
    if (_failCount === 1) setTimeout(() => { if ($("modal").hidden) refresh(); }, 8000);
  } finally {
    _refreshing = false;
    if (rb) { rb.classList.remove("busy"); rb.disabled = false; }
  }
}

function startAutoRefresh() {
  if (_autoTimer) clearInterval(_autoTimer);
  const s = CONFIG.AUTO_REFRESH_SECONDS || 0;
  if (s > 0) {
    _autoTimer = setInterval(() => {
      if ($("modal").hidden) refresh();   // don't yank the page out from under an open modal
    }, s * 1000);
  }
}

function init() {
  initTheme();
  renderBrand();
  startClock();
  $("themeToggle").addEventListener("click", toggleTheme);
  const tag = $("dataSourceTag");
  if (CONFIG.DATA_SOURCE === "live") { $("dataSourceText").textContent = "Live sheets"; tag.className = "tag tag-live"; }
  else { $("dataSourceText").textContent = "Mock data"; tag.className = "tag tag-mock"; }

  ["fromDate", "toDate", "fTech", "fItem", "fBranch"].forEach((id) =>
    $(id).addEventListener("change", renderAll));
  $("clearFilters").addEventListener("click", resetAll);
  $("refreshBtn").addEventListener("click", refresh);
  $("brandSlot").addEventListener("click", resetAll);

  $("tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) setView(t.dataset.view); });

  document.querySelector(".kpi-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".kpi-card");
    if (!card) return;
    if (card.id === "kpiTopTechCard") { if (card.dataset.tech) showTechModal(card.dataset.tech); return; }
    if (card.dataset.view) setView(card.dataset.view);
  });

  $("tblMain").addEventListener("click", (e) => {
    const techBtn = e.target.closest(".tech-link");
    if (techBtn) { e.stopPropagation(); showTechModal(techBtn.dataset.tech); return; }
    const row = e.target.closest("tr[data-txid]");
    if (!row) return;
    const id = row.dataset.txid;
    if (CURRENT_VIEW === "review" && RETURN_BY_ID[id] && !RECORD_BY_ID[id]) openResolveModal(id);
    else showTxModal(id);
  });

  // Click a column header to sort (toggle direction on repeat click)
  $("tblMain").querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sortkey;
    if (SORT.key === key) SORT.dir = -SORT.dir; else { SORT.key = key; SORT.dir = 1; }
    renderMain(LAST_DATA);
  });

  // Search box — filters the current view live
  $("tableSearch").addEventListener("input", (e) => { SEARCH_TERM = e.target.value; renderMain(LAST_DATA); });

  // Export current view to CSV
  $("exportBtn").addEventListener("click", exportCurrentView);

  // Saved searches
  renderSavedSearches();
  $("saveSearchBtn").addEventListener("click", saveCurrentSearch);
  $("savedSearches").addEventListener("click", (e) => {
    const x = e.target.closest(".ss-x");
    if (x) { removeSavedSearch(x.dataset.remove); return; }
    const chip = e.target.closest(".ss-chip");
    if (chip) applySavedSearch(chip.dataset.search);
  });

  // Overdue-by-technician list → open that tech's profile
  $("overdueByTech").addEventListener("click", (e) => {
    const row = e.target.closest(".toplist-row"); if (row) showTechModal(row.dataset.tech);
  });

  // Date-range presets (Today / 7D / 30D / All)
  $("datePresets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]"); if (!b) return;
    if (b.dataset.days === "all") { $("fromDate").value = ""; $("toDate").value = ""; }
    else {
      const n = parseInt(b.dataset.days, 10);
      const to = new Date(); const from = new Date();
      from.setDate(to.getDate() - (n - 1));
      $("fromDate").value = localISO(from); $("toDate").value = localISO(to);
    }
    renderAll();
  });

  // Most-checked-out tools → open that tool's history
  $("topToolsList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-tool]"); if (!row) return;
    const rec = ALL_RECORDS.slice().sort((a, b) => (b._out || 0) - (a._out || 0))
      .find((r) => r.item === row.dataset.tool);
    if (rec) showTxModal(rec.id);
  });

  // Error banner retry
  $("retryBtn").addEventListener("click", refresh);
  $("topTechList").addEventListener("click", (e) => { const row = e.target.closest(".toplist-row"); if (row) showTechModal(row.dataset.tech); });
  $("modalBody").addEventListener("click", (e) => {
    const linkBtn = e.target.closest("[data-link-co]");
    if (linkBtn) { linkReturn(linkBtn.dataset.linkCo, linkBtn.dataset.linkRet); return; }
    const mtab = e.target.closest(".mtab");
    if (mtab) { renderTechSubList(mtab.dataset.mtab); return; }
    const techBtn = e.target.closest(".tech-link");
    if (techBtn) showTechModal(techBtn.dataset.tech);
  });
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  refresh().then(startAutoRefresh);
}

document.addEventListener("DOMContentLoaded", init);
