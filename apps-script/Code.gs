/**
 * Assistant Coach → Google Sheet receiver.
 * Set up with scripts/setup-sheet.sh (creates the sheet, deploys, prints a
 * one-tap connect link). Manual route: paste into Extensions → Apps Script,
 * Deploy → Web app (Execute as: Me, Who has access: Anyone), and put the
 * /exec URL with ?key=<SYNC_KEY> in the app's Settings.
 * SYNC_KEY lives in Secret.gs (not committed); see Secret.gs.example.
 */
const MINUTES_SHEET = 'Minutes';
const TOTALS_SHEET = 'Season Totals';
const HEADER = ['Date', 'Opponent', 'Game ID', 'Player', 'Minutes', 'Goalie Minutes', 'Goalie Quarters', 'Shifts', 'Quarter Length', 'On Field', 'Players Present', 'Received', 'Fair Share Minutes'];

// Connection test from the app's Settings: confirms the key and names the sheet.
function doGet(e) {
  if (typeof SYNC_KEY !== 'undefined' && e.parameter.key !== SYNC_KEY) return json_({ ok: false, error: 'bad key' });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return json_({ ok: true, name: ss.getName() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (typeof SYNC_KEY !== 'undefined' && e.parameter.key !== SYNC_KEY) return json_({ ok: false, error: 'bad key' });
    const data = JSON.parse(e.postData.contents);
    const sheet = ensureSheets_();
    // Each game is stored once, even if the phone retries.
    const ids = sheet.getLastRow() > 1 ? sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat() : [];
    if (ids.includes(data.gameId)) return json_({ ok: true, duplicate: true });
    const received = new Date();
    const rows = data.players.map(p => [
      data.date, data.opponent, data.gameId, p.name, p.minutes, p.goalieMinutes, p.goalieQuarters, p.shifts,
      data.quarterMin, data.onField, data.present, received, p.fairShareMinutes ?? '',
    ]);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER.length).setValues(rows);
    return json_({ ok: true, rows: rows.length });
  } finally {
    lock.releaseLock();
  }
}

function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MINUTES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MINUTES_SHEET);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < HEADER.length) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold'); // added columns
  }
  if (!ss.getSheetByName(TOTALS_SHEET)) {
    const t = ss.insertSheet(TOTALS_SHEET);
    t.getRange('A1').setFormula(
      `=QUERY(${MINUTES_SHEET}!A:H, "select D, count(C), sum(E), avg(E), sum(G) where D is not null group by D order by sum(E) desc ` +
      `label count(C) 'Games', sum(E) 'Total Minutes', avg(E) 'Avg / Game', sum(G) 'Goalie Quarters'", 1)`
    );
  }
  return sheet;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor to create the tabs and authorize the script.
function setup() { ensureSheets_(); }
