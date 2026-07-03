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
  GOOGLE_SHEET_CHECKOUTS_CSV_URL: "https://docs.google.com/spreadsheets/d/1WG5gbEw9hqFzsdke-jibR9x7qwi3DD70GNkaycfX5Uk/gviz/tq?tqx=out:csv&sheet=Checkouts",
  GOOGLE_SHEET_RETURNS_CSV_URL:   "https://docs.google.com/spreadsheets/d/1WG5gbEw9hqFzsdke-jibR9x7qwi3DD70GNkaycfX5Uk/gviz/tq?tqx=out:csv&sheet=Returns",

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
  EXCLUDE_TOOL_NAMES: ["TEST", "drill 2", "sdg"],

  // Remove SPECIFIC junk/test lines without filtering a whole tool name.
  // Matches on technician + item + date together (use date:"" for a blank/undated row),
  // so it removes just that one row and leaves other rows of the same tool alone.
  EXCLUDE_ROWS: [
    { technician: "Mart Cole", item: "MC Hammer", date: "" },  // undated duplicate (test line)
  ],

  // ----- MANUAL LINKS -----
  // Permanently pair one specific return with one specific check-out when the
  // names are too different for automatic matching. Dates are yyyy-mm-dd.
  // These are reviewed human decisions — safer than a global alias when the
  // wording only applies to a single transaction.
  MANUAL_LINKS: [
    { technician: "Jeff Myers", checkoutItem: "Post hole digger and jackhammer", checkoutDate: "2026-06-30",
      returnItem: "Posthole digger", returnDate: "2026-07-01" },
    { technician: "Tyler Nappe", checkoutItem: "Water main key qty 2", checkoutDate: "2026-06-30",
      returnItem: "water key", returnDate: "2026-06-30" },
  ],

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
