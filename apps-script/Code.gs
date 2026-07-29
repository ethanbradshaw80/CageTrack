/* ============================================================
   CageTrack — shared resolution saver (Google Apps Script)

   STATUS: deployed and live since 2026-07-28. The dashboard points at
   it via LINKS.SAVE_URL in config.js. This file is the source of truth
   for what's running — if you edit it here, redeploy (see below).

   This is the tiny free "server" that lets everyone using the dashboard
   (hosted or local) save to the same Google Sheet, so all users see the
   same fixes. It appends each one as a row in a "Links" tab of the SAME
   spreadsheet the dashboard already reads.

   The log is APPEND-ONLY. An undo doesn't delete the original row — the
   dashboard sends a row with type "removed" and targetUid set to the
   original's UID, and every dashboard then skips that entry. So rows
   that look like duplicates are expected; don't prune them by hand.

   ---- REDEPLOYING AFTER AN EDIT ----
   Changes do NOT go live on save. Deploy > "Manage deployments" >
   pencil icon > Version: "New version" > Deploy. That keeps the same
   URL, so config.js needs no change.

   ---- DEPLOYING FROM SCRATCH ----
   Full click-by-click steps (including the "Google hasn't verified this
   app" prompt) are in SETUP-SHARED-SAVING.md at the repo root. Short
   version: Extensions > Apps Script, paste this file, Deploy > New
   deployment > Web app, Execute as "Me", Who has access "Anyone", then
   put the /exec URL into config.js -> LINKS.SAVE_URL.
   ============================================================ */

var TAB_NAME = 'Links';
var HEADERS = ['Technician', 'Checkout Item', 'Checkout Date', 'Return Item', 'Return Date',
               'Type', 'Note', 'UID', 'Target UID', 'Saved By', 'Linked On'];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getOrCreateTab_();
    sheet.appendRow([
      data.technician  || '',
      data.checkoutItem || '',
      data.checkoutDate || '',
      data.returnItem  || '',
      data.returnDate  || '',
      data.type        || 'link',   // 'link' (paired to a real return), 'marked' (no return form filed), or 'removed' (an undo)
      data.note        || '',
      data.uid         || '',       // id of THIS save
      data.targetUid   || '',       // for an undo: the id of the save being removed
      data.savedBy     || '',
      data.linkedOn    || new Date().toISOString().slice(0, 10)
    ]);
    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

// A plain GET just confirms the web app is alive (open the /exec URL in a browser).
function doGet() {
  return jsonOut_({ ok: true, service: 'CageTrack link saver', tab: TAB_NAME });
}

function getOrCreateTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
    sheet.appendRow(HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
