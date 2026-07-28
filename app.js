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
let FILE_LINKS = [];      // permanent links loaded from manual_links.json
let SHEET_LINKS = [];     // shared links loaded from the sheet's Links tab
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
  // Plain yyyy-mm-dd (how we write dates to the shared Links tab). These MUST
  // be built as a local date: `new Date("2026-07-20")` is parsed as UTC
  // midnight, which reads back as the 19th anywhere west of UTC — every saved
  // date would drift a day earlier on each round-trip through the sheet.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
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
  FILE_LINKS = await loadFileLinks();
  SHEET_LINKS = await loadSheetLinks();
  reconcileOutbox();          // anything now in the sheet is confirmed saved
  const matched = matchRecords(checkouts, returns);
  applyConfigLinks(matched, returns);
  applyMarkReturned(matched);
  applySavedMarks(matched);
  return matched;
}

/* Record ONE check-out as returned when no return form was ever filed:
   clear the check-out (out of "Currently Out") and synthesize a return event
   so it shows in Returns history — flagged _marked so it's never mistaken for
   a real filed return. Shared by config marks, saved marks, and the in-app
   "Mark returned" button. */
function markCheckoutReturned(c, returnDate, note) {
  if (!c || c._ret) return false;
  const rd = returnDate ? parseDate(returnDate) : null;
  c.returnTime = returnDate || "";
  c._ret = rd;
  c._matchType = "marked";
  c._matchNote = note || "";
  c.status = deriveStatus(c);
  const synth = {
    id: "MARK-" + (_idc++),
    technician: c.technician, nick: c.nick, branch: c.branch,
    item: c.item, checkoutTime: "", returnTime: returnDate || "",
    _out: null, _ret: rd, _used: true, _marked: true, _note: note || "",
    status: "Returned", _due: null,
  };
  RETURN_EVENTS.push(synth);
  RETURN_BY_ID[synth.id] = synth;
  return true;
}

/* Find the still-out check-out an entry refers to (tech + item + optional
   check-out date). `itemKey` lets config marks use `item` and saved marks
   use `checkoutItem`. */
function findOpenCheckout(checkouts, e, itemKey) {
  const item = e[itemKey];
  return checkouts.find((x) => !x._ret &&
    normTool(x.technician) === normTool(e.technician) &&
    normTool(x.item) === normTool(item) &&
    (!e.checkoutDate || (x._out && localISO(x._out) === e.checkoutDate)));
}

/* CONFIG.MARK_RETURNED — hand-listed in config.js (uses `item`). */
function applyMarkReturned(checkouts) {
  (CONFIG.MARK_RETURNED || []).forEach((M) => {
    const c = findOpenCheckout(checkouts, M, "item");
    if (c) markCheckoutReturned(c, M.returnDate, M.note);
  });
}

/* Marks saved from the in-app "Mark returned" button (uses `checkoutItem`),
   pulled from the same three stores as links. Already-returned check-outs are
   skipped, so a mark that also came from the sheet won't double-apply. */
function applySavedMarks(checkouts) {
  liveEntries().filter((e) => e.type === "marked").forEach((e) => {
    const c = findOpenCheckout(checkouts, e, "checkoutItem");
    if (c && markCheckoutReturned(c, e.returnDate, e.note)) c._savedUid = e.uid || "";
  });
}

/* Reviewed, permanent pairings (tech + item + date) from three sources:
   CONFIG.MANUAL_LINKS, manual_links.json (saved by the Link button), and
   the browser-local fallback. */
function applyConfigLinks(checkouts, returns) {
  liveEntries().filter((L) => L.type !== "marked").forEach((L) => {
    const c = checkouts.find((x) => !x._ret &&
      normTool(x.technician) === normTool(L.technician) &&
      normTool(x.item) === normTool(L.checkoutItem) &&
      (!L.checkoutDate || (x._out && localISO(x._out) === L.checkoutDate)));
    const ret = returns.find((x) => !x._used &&
      normTool(x.technician) === normTool(L.technician) &&
      normTool(x.item) === normTool(L.returnItem) &&
      (!L.returnDate || (x._ret && localISO(x._ret) === L.returnDate)));
    if (c && ret) { applyOneLink(c, ret); c._savedUid = L.uid || ""; }
  });
}

function applyOneLink(c, ret) {
  c.returnTime = ret.returnTime; c._ret = ret._ret;
  c._matchType = "manual"; c._matchedName = ret.item;
  c.status = deriveStatus(c); ret._used = true;
}

/* ---------- Permanent link storage ----------
   Links made in Needs Review are written to manual_links.json on disk via
   the dev server's POST /api/save-link. localStorage is the fallback if the
   file save isn't available (e.g. the app is hosted somewhere static). */
const LS_LINKS_KEY = "cagetrack.manualLinks";
/* The OUTBOX: every save lands here first and only leaves once it's been seen
   in the shared sheet (or written to disk). Nothing is ever lost to a failed
   network call — worst case it sits here and retries. */
function getLocalLinks() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_LINKS_KEY) || "[]");
    if (!Array.isArray(list)) return [];
    let changed = false;
    list.forEach((e) => { if (e && !e.uid) { e.uid = newUid(); changed = true; } });  // adopt pre-uid saves
    if (changed) setLocalLinks(list);
    return list;
  } catch (e) { return []; }
}
function setLocalLinks(a) { try { localStorage.setItem(LS_LINKS_KEY, JSON.stringify(a)); } catch (e) {} }
function dropFromOutbox(uid) {
  if (!uid) return;
  setLocalLinks(getLocalLinks().filter((e) => e.uid !== uid));
}
/* Short unique id so a save can be confirmed and later undone. */
function newUid() {
  return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Every saved resolution from all stores, with undone ones removed and
   duplicates collapsed. This is the single source of truth for what has been
   decided — config entries, the shared sheet, the disk file, and the outbox.

   Undo works by appending a `removed` tombstone pointing at the original's
   uid, because the shared sheet can only be appended to (never edited from
   the app). Applying the tombstone here is what makes undo work everywhere. */
function liveEntries() {
  const all = (CONFIG.MANUAL_LINKS || []).concat(SHEET_LINKS, FILE_LINKS, getLocalLinks())
    .filter(Boolean);
  const undone = new Set();
  all.forEach((e) => { if (e.type === "removed" && e.targetUid) undone.add(e.targetUid); });
  const seen = new Set();
  return all.filter((e) => {
    if (e.type === "removed") return false;
    if (!e.uid) return true;                       // config/legacy entries: always apply
    if (undone.has(e.uid) || seen.has(e.uid)) return false;
    seen.add(e.uid);
    return true;
  });
}

/* A save is "confirmed" once its uid shows up in the shared sheet. Drop those
   from the outbox; whatever is left is genuinely not saved for everyone yet. */
function reconcileOutbox() {
  const inSheet = new Set(SHEET_LINKS.map((e) => e.uid).filter(Boolean));
  if (!inSheet.size) return;
  const box = getLocalLinks();
  const left = box.filter((e) => !(e.uid && inSheet.has(e.uid)));
  if (left.length !== box.length) setLocalLinks(left);
}

async function loadFileLinks() {
  try {
    const res = await fetch("manual_links.json?_cb=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

/* Shared links from the sheet's Links tab (written by the Apps Script).
   Reads the same spreadsheet as the data, just a different tab. */
async function loadSheetLinks() {
  try {
    const tab = (CONFIG.LINKS && CONFIG.LINKS.TAB_NAME) || "Links";
    const base = CONFIG.GOOGLE_SHEET_CHECKOUTS_CSV_URL || "";
    if (!base.includes("sheet=")) return [];
    const url = base.replace(/sheet=[^&]+/, "sheet=" + encodeURIComponent(tab));
    const res = await fetch(url + "&_cb=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return [];
    const text = await res.text();
    if (text.slice(0, 200).includes("<html")) return [];   // tab doesn't exist yet
    const rows = parseCSV(text);
    if (rows.length < 2) return [];
    const h = rows[0].map((x) => normTool(x));
    const col = (name) => h.indexOf(normTool(name));
    const iT = col("Technician"), iCI = col("Checkout Item"), iCD = col("Checkout Date"),
          iRI = col("Return Item"), iRD = col("Return Date"),
          iTy = col("Type"), iN = col("Note"),
          iU = col("UID"), iTU = col("Target UID"), iSB = col("Saved By");
    if (iT < 0 || iCI < 0 || iRI < 0) return [];
    // normalize dates to yyyy-mm-dd regardless of how Sheets formatted them
    const nd = (v) => { const d = parseDate(v); return d ? localISO(d) : ""; };
    return rows.slice(1).map((c) => ({
      technician: c[iT] || "", checkoutItem: c[iCI] || "",
      checkoutDate: iCD > -1 ? nd(c[iCD]) : "",
      returnItem: c[iRI] || "", returnDate: iRD > -1 ? nd(c[iRD]) : "",
      type: iTy > -1 ? (c[iTy] || "") : "", note: iN > -1 ? (c[iN] || "") : "",
      uid: iU > -1 ? (c[iU] || "") : "", targetUid: iTU > -1 ? (c[iTU] || "") : "",
      savedBy: iSB > -1 ? (c[iSB] || "") : "",
    // "removed" tombstones carry no tech/item, so keep any row that has either
    // an identity to match on or a target to undo
    })).filter((l) => (l.technician && l.checkoutItem) || (l.type === "removed" && l.targetUid));
  } catch (e) { return []; }
}

async function linkReturn(coId, retId) {
  const c = RECORD_BY_ID[coId], ret = RETURN_BY_ID[retId];
  if (!c || !ret) return;
  const entry = {
    technician: c.technician,
    checkoutItem: c.item, checkoutDate: c._out ? localISO(c._out) : "",
    returnItem: ret.item, returnDate: ret._ret ? localISO(ret._ret) : "",
    linkedOn: localISO(new Date()),
  };
  applyOneLink(c, ret);
  closeModal();
  renderAll();

  const where = await persistEntry(entry);
  c._savedUid = entry.uid;      // so Undo shows immediately, not just after a refresh
  renderAll();
  if (where === "sheet") toast("✓ Link saved — syncing to the shared sheet", true);
  else if (where === "file") toast("✓ Link saved permanently (manual_links.json)", true);
  else toast("Link saved on this PC only — shared saving isn’t on yet", false);
}

/* Record a still-out check-out as returned when no return form was filed.
   Called by the in-app "Mark returned" button. Applies immediately, then
   saves through the same three stores as a link (tagged type:"marked"). */
async function markReturned(coId, returnDate) {
  const c = RECORD_BY_ID[coId];
  if (!c || c._ret) return;
  const rDate = returnDate || localISO(new Date());
  const note = "Marked returned in-app — no return form was filed";
  const entry = {
    type: "marked",
    technician: c.technician,
    checkoutItem: c.item, checkoutDate: c._out ? localISO(c._out) : "",
    returnItem: c.item, returnDate: rDate,   // returnItem = same tool keeps the sheet columns populated
    note, linkedOn: localISO(new Date()),
  };
  markCheckoutReturned(c, rDate, note);
  closeModal();
  renderAll();

  const where = await persistEntry(entry);
  c._savedUid = entry.uid;      // so Undo shows immediately, not just after a refresh
  renderAll();
  if (where === "sheet") toast("✓ Marked returned — syncing to the shared sheet", true);
  else if (where === "file") toast("✓ Marked returned — saved permanently", true);
  else toast("Marked returned — saved on this PC only, not shared yet", false);
}

/* Persist a resolution (link or mark) to the best available home and report
   which one took it: the shared Google Sheet, the local dev-server file, or
   this browser. Same pipeline for both features so they behave identically. */
async function persistEntry(entry) {
  if (!entry.uid) entry.uid = newUid();
  entry.savedBy = getSavedBy();

  // 0) Outbox FIRST — the save exists locally before any network call, so a
  //    dropped connection can never lose it. It leaves the outbox only once
  //    it's confirmed in the sheet (reconcileOutbox) or written to disk.
  const box = getLocalLinks(); box.push(entry); setLocalLinks(box);
  return sendEntry(entry);
}

/* Try to get one entry to a durable home. Does NOT touch the outbox on the way
   in, so it's safe to call again when retrying something already queued. */
async function sendEntry(entry) {
  // 1) shared Links tab via the Apps Script (everyone sees it; works hosted)
  const saveUrl = (CONFIG.LINKS && CONFIG.LINKS.SAVE_URL) || "";
  if (saveUrl) {
    try {
      // Apps Script can't answer a CORS preflight, so this is a "no-cors"
      // simple POST (text/plain) and the response is opaque — we can't read
      // whether it worked. So we DON'T claim success here: the entry stays in
      // the outbox until a later refresh actually finds its uid in the sheet.
      await fetch(saveUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(entry) });
      return "sheet";
    } catch (e) {}
  }
  // 2) manual_links.json via the local dev server (durable — leaves the outbox)
  try {
    const body = JSON.stringify(entry)
      .replace(/[^\x00-\x7f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
    const res = await fetch("api/save-link", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (res.ok) { FILE_LINKS.push(entry); dropFromOutbox(entry.uid); return "file"; }
  } catch (e) {}
  // 3) still in the outbox, waiting for sharing to be switched on
  return "local";
}

/* Who made this save — so a wrong one can be traced back and asked about.
   Set once per browser; blank until someone fills it in. */
const LS_WHO_KEY = "cagetrack.savedBy";
function getSavedBy() { try { return localStorage.getItem(LS_WHO_KEY) || ""; } catch (e) { return ""; } }
function setSavedBy(v) { try { localStorage.setItem(LS_WHO_KEY, v || ""); } catch (e) {} }

/* Undo a saved link or mark. The shared sheet is append-only from the app, so
   this appends a "removed" tombstone pointing at the original's uid; every
   copy of the dashboard then skips that entry. No sheet editing, no commit. */
async function undoSavedEntry(targetUid, label) {
  if (!targetUid) return;
  await persistEntry({
    type: "removed", targetUid,
    technician: "", checkoutItem: "", returnItem: "",
    note: "Undone in-app" + (label ? ` — was: ${label}` : ""),
    linkedOn: localISO(new Date()),
  });
  closeModal();
  await refresh();                     // rebuild everything from the stores
  toast("✓ Undone — the fix was removed for everyone", true);
}

/* ---------- Shared-saving status ----------
   A save that only lands in one browser is invisible to everyone else, so the
   header says plainly which mode you're in and how many saves are stranded. */
function sharedSavingOn() { return !!((CONFIG.LINKS && CONFIG.LINKS.SAVE_URL) || "").trim(); }

function renderSyncTag() {
  const tag = $("syncTag"), txt = $("syncText");
  if (!tag || !txt) return;
  const pending = getLocalLinks().length;
  tag.classList.remove("tag-sync-on", "tag-sync-off", "tag-sync-pending");
  if (sharedSavingOn()) {
    if (pending) {
      tag.classList.add("tag-sync-pending");
      txt.textContent = `Saving: shared · ${pending} syncing`;
      tag.title = `${pending} save(s) not confirmed in the sheet yet. Usually clears within a minute — click to retry.`;
    } else {
      tag.classList.add("tag-sync-on");
      txt.textContent = "Saving: shared";
      tag.title = "Links and marks save to the shared sheet — everyone sees them.";
    }
  } else {
    tag.classList.add("tag-sync-off");
    txt.textContent = pending ? `Saving: this PC only · ${pending}` : "Saving: this PC only";
    tag.title = "Shared saving isn't set up — saves stay in this browser. Click for setup steps.";
  }
}

/* Upload saves that were stranded in this browser before sharing was turned on,
   so nothing made in the meantime is lost. Only clears what actually uploaded. */
async function syncPendingLocal() {
  const pending = getLocalLinks();
  if (!pending.length) { toast("Nothing waiting — everything is saved", true); return; }
  let toSheet = 0, toFile = 0, stuck = 0;
  for (const entry of pending) {
    const where = await sendEntry(entry);          // retries in place, no duplicate queueing
    if (where === "sheet") toSheet++;              // stays queued until confirmed in the sheet
    else if (where === "file") toFile++;           // durable now, already left the outbox
    else stuck++;
  }
  renderSyncTag();
  if (toSheet) toast(`Re-sent ${toSheet} to the shared sheet — confirming shortly`, true);
  else if (toFile) toast(`✓ Saved ${toFile} item${toFile > 1 ? "s" : ""} to the file`, true);
  else if (stuck) toast("Nowhere to save yet — shared saving still needs setting up", false);
}

/* Undo affects everyone, so confirm before doing it. */
function openUndoConfirm(uid, label) {
  openModal("Undo this fix?", `
    <p class="sync-p">This removes the fix for <strong>${esc(label || "this item")}</strong> —
    for you and everyone else using CageTrack.</p>
    <p class="sync-p">The item goes back to how the sheet has it, and will show up in
    <strong>Needs Review</strong> again if it doesn't match. Nothing in the Checkouts or
    Returns tabs is changed.</p>
    <button class="btn btn-primary btn-sm" id="undoConfirmBtn"
      data-undo-uid="${esc(uid)}" data-undo-label="${esc(label || "")}">Yes, undo it</button>`);
}

function openSyncModal() {
  const pending = getLocalLinks().length;
  const on = sharedSavingOn();
  openModal(on ? "Shared saving is on" : "Turn on shared saving", on ? `
    <p class="sync-p">Links and “Mark returned” save to the <strong>Links</strong> tab of your
    Google Sheet, so you and anyone else using CageTrack see the same thing.</p>
    ${pending ? `<p class="sync-p"><strong>${pending}</strong> save(s) haven't been confirmed in
    the sheet yet. That's normal for up to a minute after saving. If the number sticks, retry:</p>
    <button class="btn btn-primary btn-sm" id="syncNowBtn">Retry ${pending} now</button>` :
    `<p class="sync-p">Every save is confirmed in the shared sheet — you're fully in sync.</p>`}` : `
    <p class="sync-p">Right now, anything you link or mark returned <strong>stays on this
    computer only</strong>. Ethan won't see it, and it's lost if this browser is cleared.</p>
    <p class="sync-p">Turning on sharing is a one-time setup in your Google Sheet — about two
    minutes. Full click-by-click steps are in <code>SETUP-SHARED-SAVING.md</code>. The short version:</p>
    <ol class="sync-steps">
      <li>Open the CageTrack Google Sheet → <strong>Extensions → Apps Script</strong></li>
      <li>Paste in the contents of <code>apps-script/Code.gs</code>, then Save</li>
      <li><strong>Deploy → New deployment → Web app</strong>; set <em>Execute as: Me</em> and
          <em>Who has access: Anyone</em>, then Deploy and approve</li>
      <li>Copy the <strong>Web app URL</strong> (it ends in <code>/exec</code>)</li>
      <li>Paste it into <code>config.js</code> at <code>LINKS.SAVE_URL</code></li>
    </ol>
    ${pending ? `<p class="sync-p"><strong>${pending}</strong> save(s) are waiting on this
    computer. Once the URL is in, come back here and upload them — they won't be lost.</p>` : ""}`);
}

/* small confirmation toast */
function toast(msg, ok) {
  const t = document.createElement("div");
  t.className = "toast" + (ok ? " ok" : " warn");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 350); }, 3500);
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
  resolution: { key: "resolution", l: "Resolution", f: (r) => `<span class="issue-chip issue-${r._issueType}">${esc(r._issueType === "linked" ? "Linked" : "Explained")}</span> <span class="res-note">${esc(r._issue)}</span>` +
            (r._savedUid ? ` <button class="undo-btn" data-undo="${esc(r._savedUid)}" data-undo-label="${esc(r.technician + " — " + r.item)}" title="Remove this fix for everyone">Undo</button>` : ""),
            plain: (r) => r._issue || "", sortVal: (r) => r._issueType || "" },
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
  reviewed: {
    title: "Reviewed",
    rows: () => buildReviewedRows(),
    cols: [COL.item, COL.tech, COL.van, COL.reviewDate, COL.resolution],
    empty: "Nothing has been reviewed yet.",
  },
};

/* Audit trail: exceptions a human already resolved (manual links) or
   reviewed and explained (REVIEWED_OK). Ignores filters. */
function buildReviewedRows() {
  const rows = [];
  ALL_RECORDS.filter((r) => r._matchType === "manual").forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: r._ret || r._out, _issue: `Linked to return “${r._matchedName}”`, _issueType: "linked",
    _savedUid: r._savedUid || "",
  }));
  // tools recorded as returned with no return form filed
  ALL_RECORDS.filter((r) => r._matchType === "marked").forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: r._ret || r._out, _issue: "Marked returned — no return form was filed",
    _issueType: "explained", _savedUid: r._savedUid || "",
  }));
  // fuzzy auto-matches a human has confirmed via REVIEWED_OK
  ALL_RECORDS.filter((r) => r._matchType === "fuzzy" && isReviewedOk(r)).forEach((r) => rows.push({
    id: r.id, item: r.item, technician: r.technician, branch: r.branch,
    _date: r._ret || r._out, _issue: `Auto-match to “${r._matchedName}” verified`, _issueType: "linked",
  }));
  RETURN_EVENTS.filter((r) => !r._used && isReviewedOk(r)).forEach((r) => {
    const e = (CONFIG.REVIEWED_OK || []).find((x) =>
      normTool(x.technician) === normTool(r.technician) && normTool(x.item) === normTool(r.item));
    rows.push({
      id: r.id, item: r.item, technician: r.technician, branch: r.branch,
      _date: r._ret, _issue: (e && e.note) || "Reviewed — cause confirmed", _issueType: "explained",
    });
  });
  return rows.sort((a, b) => (b._date || 0) - (a._date || 0));
}

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
  ALL_RECORDS.filter((r) => r._matchType === "fuzzy" && !isReviewedOk(r)).forEach((r) => rows.push({
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
     <div class="resolve-note">Linking is <strong>permanent</strong> — it's saved to <code>manual_links.json</code> next to the app. To undo a link, remove its entry from that file.</div>`);
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
    <div class="hist-list">${histHtml}</div>` +
    (r._ret ? "" : `
    <div class="mark-return">
      <div class="m-sub">Came back but no return was filed?</div>
      <div class="mark-row">
        <input type="date" id="markDate" class="mark-date" value="${localISO(new Date())}" max="${localISO(new Date())}" />
        <button class="btn btn-primary btn-sm" data-mark-co="${esc(r.id)}">Mark returned</button>
      </div>
      <div class="resolve-note">Records this tool as returned so it leaves “Currently Out” and shows in Returns — flagged as manually marked (no return form was filed). Saved for everyone, like a link.</div>
    </div>`));
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
  renderSyncTag();
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
  const rvd = document.querySelector('.tab[data-view="reviewed"]');
  if (rvd) {
    const n = buildReviewedRows().length;
    rvd.textContent = n ? `Reviewed (${n})` : "Reviewed";
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
    const undoBtn = e.target.closest("[data-undo]");
    if (undoBtn) { e.stopPropagation(); openUndoConfirm(undoBtn.dataset.undo, undoBtn.dataset.undoLabel); return; }
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

  // Shared-saving status chip
  $("syncTag").addEventListener("click", openSyncModal);

  // Error banner retry
  $("retryBtn").addEventListener("click", refresh);
  $("topTechList").addEventListener("click", (e) => { const row = e.target.closest(".toplist-row"); if (row) showTechModal(row.dataset.tech); });
  $("modalBody").addEventListener("click", (e) => {
    const linkBtn = e.target.closest("[data-link-co]");
    if (linkBtn) { linkReturn(linkBtn.dataset.linkCo, linkBtn.dataset.linkRet); return; }
    const markBtn = e.target.closest("[data-mark-co]");
    if (markBtn) {
      const d = document.getElementById("markDate");
      markReturned(markBtn.dataset.markCo, d && d.value ? d.value : "");
      return;
    }
    if (e.target.closest("#syncNowBtn")) { closeModal(); syncPendingLocal(); return; }
    const undoOk = e.target.closest("#undoConfirmBtn");
    if (undoOk) { undoSavedEntry(undoOk.dataset.undoUid, undoOk.dataset.undoLabel); return; }
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
