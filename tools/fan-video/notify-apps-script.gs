/**
 * A Soft Focus — fan video notifications (Google Apps Script web app)
 *
 * Receives a small JSON message from asoftfocus.com each time a fan video finishes
 * uploading, emails bookings@asoftfocus.com, and (optionally) adds a row to a
 * "Fan videos log" Google Sheet. Free: runs on our existing Google account.
 *
 * Setup (5 minutes, signed in as the bookings@ / admin Google account):
 *  1. Go to https://script.google.com → New project → paste this file → Save.
 *  2. Project Settings → Script properties → add:
 *       NOTIFY_WEBHOOK_SECRET = <the same random string Dharma sets in Cloudflare>
 *       LOG_SHEET_ID          = <optional: ID of a Google Sheet for the running log>
 *  3. Deploy → New deployment → type "Web app":
 *       Execute as: Me      Who has access: Anyone
 *     Authorise when asked. Copy the Web app URL (ends in /exec) and send it to Dharma.
 *     (The URL only accepts messages that carry the secret, so it's safe to be "Anyone".)
 */

const NOTIFY_TO = 'bookings@asoftfocus.com';

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('NOTIFY_WEBHOOK_SECRET');
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'bad json' });
  }
  if (!secret || body.secret !== secret) return reply_({ ok: false, error: 'forbidden' });

  MailApp.sendEmail({
    to: NOTIFY_TO,
    subject: String(body.subject || 'New fan video').slice(0, 200),
    body: String(body.text || '').slice(0, 5000),
    name: 'asoftfocus.com',
  });

  const sheetId = props.getProperty('LOG_SHEET_ID');
  const s = body.submission || {};
  if (sheetId) {
    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Received (UTC)', 'Gig', 'Name', 'Instagram', 'Facebook', 'Email', 'Size (MB)', 'Consent version', 'Storage key', 'Mode', 'Used in edit?', 'Notes']);
    }
    sheet.appendRow([
      s.completedAt || new Date().toISOString(),
      s.gigLabel || s.gigFolder || '',
      s.name || '',
      s.instagram ? '@' + s.instagram : '',
      s.facebook || '',
      s.email || '',
      s.file && s.file.size ? Math.round(s.file.size / 1048576) : '',
      s.consentVersion || '',
      s.key || '',
      s.mode || '',
      '',
      '',
    ]);
  }
  return reply_({ ok: true });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
