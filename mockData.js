/* ============================================================
   CageTrack — MOCK DATA
   Realistic sample rows so the dashboard works before you
   connect the live Google Sheet. Delete this file once live.
   Timestamps are generated relative to "now" so today's KPIs
   always show activity.
   ============================================================ */

const MOCK_DATA = (function buildMock() {
  const now = new Date();
  const h = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600 * 1000).toISOString();

  // technician, item, branch, checkout(hrs ago), return(hrs ago or null)
  const rows = [
    ["Marcus Lee",    "Impact Wrench",       "North",  3,   null],
    ["Marcus Lee",    "Torque Set",          "North",  1,   null],
    ["Priya Shah",    "Pipe Threader",       "South",  5,   2],
    ["Priya Shah",    "Drain Camera",        "South",  2,   null],
    ["Dwayne Cole",   "Multimeter",          "East",   70,  null],   // overdue (>48h)
    ["Dwayne Cole",   "Ladder 24ft",         "East",   4,   null],
    ["Sara Nguyen",   "Recovery Machine",    "West",   6,   1],
    ["Sara Nguyen",   "Vacuum Pump",         "West",   3,   null],
    ["Tom Becker",    "Core Drill",          "North",  96,  null],   // overdue
    ["Tom Becker",    "Hammer Drill",        "North",  8,   5],
    ["Marcus Lee",    "Inspection Mirror",   "North",  26,  null],
    ["Priya Shah",    "Hole Saw Kit",        "South",  30,  null],
    ["Dwayne Cole",   "Manifold Gauge",      "East",   2,   0.5],
    ["Sara Nguyen",   "Reciprocating Saw",   "West",   52,  null],   // overdue
    ["Tom Becker",    "Wet/Dry Vac",         "North",  1,   null],
    ["Jorge Ramos",   "Press Tool",          "South",  7,   3],
    ["Jorge Ramos",   "Tubing Cutter",       "South",  1,   null],
    ["Amy Foster",    "Thermal Camera",      "West",   3,   null],
    ["Amy Foster",    "Borescope",           "West",   22,  18],
    ["Dwayne Cole",   "Auger 50ft",          "East",   0.5, null],
  ];

  return rows.map((r, i) => ({
    id: "TX-" + String(1000 + i),
    technician: r[0],
    item: r[1],
    branch: r[2],
    checkoutTime: h(r[3]),
    returnTime: r[4] === null ? "" : h(r[4]),
  }));
})();
