/* ============================================================
   CageTrack — shared link saver (Google Apps Script)

   This is the tiny free "server" that lets EVERYONE who uses the
   dashboard (hosted or local) save a Needs-Review link to the same
   Google Sheet, so all users see the same links.

   It writes each saved link as a new row in a "Links" tab of the
   SAME spreadsheet the dashboard already reads.

   ---- ONE-TIME SETUP (about 3 minutes) ----
   1. Open your CageTrack Google Sheet.
   2. Menu: Extensions > Apps Script.
   3. Delete whatever is in the editor, paste ALL of this file, Save.
   4. Click "Deploy" (top right) > "New deployment".
   5. Gear icon > choose type: "Web app".
   6. Settings:
        - Description:  CageTrack link saver
        - Execute as:   Me (your Google account)
        - Who has access: Anyone
   7. Click "Deploy". Approve the permissions when Google asks
      (it's your own script writing to your own sheet).
   8. Copy the "Web app URL" it shows (ends in /exec).
   9. Paste that URL into config.js  ->  LINKS.SAVE_URL  between the quotes.
  10. Done. Test by linking an item in Needs Review; a new row should
      appear in the "Links" tab within a few seconds.

   NOTE: if you ever change this script, you must Deploy > "Manage
   deployments" > edit > "New version" for the change to take effect.
   ============================================================ */

var TAB_NAME = 'Links';
var HEADERS = ['Technician', 'Checkout Item', 'Checkout Date', 'Return Item', 'Return Date', 'Type', 'Note', 'Linked On'];

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
      data.type        || 'link',   // 'link' (paired to a real return) or 'marked' (no return form filed)
      data.note        || '',
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
