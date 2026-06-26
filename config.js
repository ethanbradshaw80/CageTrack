/* ============================================================
   CageTrack — CONFIGURATION
   This is the main file you edit. It now reads TWO sheets:
   a "Check Outs" tab and a "Returns" tab, and matches them up.
   ============================================================ */

const CONFIG = {
  // ----- BRANDING -----
  BRAND: {
    logoUrl: "assets/peterman-logo.avif",   // Peterman logo (swap for a URL/base64 anytime)
    companyName: "Peterman Brothers",
    productName: "CageTrack",
    tagline: "Tool Check-Out Tracker",
  },

  // "mock" = built-in sample data (mockData.js)
  // "live" = read the two published CSVs below
  DATA_SOURCE: "live",

  // Days a tool can be out before it counts as OVERDUE.
  // (Tools, not daily cage items — adjust to your real policy.)
  RETURN_WINDOW_HOURS: 7 * 24,   // 7 days

  // ----- LIVE GOOGLE SHEET SETTINGS -----
  // Publish EACH tab separately as CSV:
  //   File > Share > Publish to web > (pick the tab) > CSV > Publish
  // Then paste each tab's link below.
  GOOGLE_SHEET_CHECKOUTS_CSV_URL: "tool_checkout_log.csv",
  GOOGLE_SHEET_RETURNS_CSV_URL:   "tool_returns_log.csv",

  // Auto-pull new form submissions on a timer (seconds). 0 = manual only.
  // When you paste the two published Google Sheet URLs above, this makes the
  // dashboard update itself as techs submit the form — no Refresh click needed.
  AUTO_REFRESH_SECONDS: 60,

  // Column headers in the CHECK-OUTS tab (exact text).
  CHECKOUT_COLUMNS: {
    technician:   "Name",
    van:          "Van #",
    item:         "Tool Name",
    checkoutTime: "Date Checked Out",
  },

  // Column headers in the RETURNS tab (exact text).
  RETURN_COLUMNS: {
    technician: "Name",
    van:        "Van #",
    item:       "Tool Name",
    returnTime: "Date Returned",
  },

  // ----- DATA CLEANUP -----
  // Tool names listed here are dropped entirely (test/junk rows). Case-insensitive.
  EXCLUDE_TOOL_NAMES: ["TEST", "drill 2"],

  // Consolidate spelling variants into one name. Key = the name to KEEP;
  // values = the variants to fold into it. Matching ignores case/spaces/punctuation,
  // so "jack hammer", "Jackhammer", and "JACK-HAMMER" all collapse together.
  // Add more lines as you spot duplicates (e.g. "Press Jaws": ["press jaw"]).
  TOOL_ALIASES: {
    "Jackhammer": ["jack hammer", "jackhammer"],
    "Press Jaws": ["press jaw", "press jaws"],
  },

  // Auto-catch typos/spelling variants when matching check-outs to returns.
  // The fuzzy pass only considers the SAME technician and a return dated on/after
  // the check-out, then requires a high name-similarity score — so "Press jaw" and
  // "Press Jaws" match, but "Hammer" and "MC Hammer" do not.
  MATCHING: {
    FUZZY: true,        // set false to require exact (normalized) names only
    THRESHOLD: 0.82,    // 0–1, higher = stricter. 0.82 is a safe default.
  },

};
