/**
 * ربط نظام مدرسة ذكور سنجل الأساسية العليا مع جوجل شيت
 * الخطوات:
 * 1) افتح جوجل شيت جديد > الإضافات (Extensions) > Apps Script
 * 2) الصق هذا الكود كاملا واحفظ
 * 3) نشر (Deploy) > نشر جديد > النوع: تطبيق ويب
 *    - تنفيذ باسم: أنا
 *    - من لديه صلاحية الوصول: أي شخص
 * 4) انسخ رابط تطبيق الويب (ينتهي بـ /exec) والصقه في الإعدادات داخل البرنامج
 */

const LEVEL_COLORS = ['#cfeee9', '#fdf0b8', '#fcd5a8', '#f6b2ac', '#d9788a', '#b58bc2'];
const CHUNK = 40000;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'sync') {
      saveAll_(body.data);
      return out_({ ok: true, time: new Date().toISOString() });
    }
    return out_({ ok: false, error: 'طلب غير معروف' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'pull') return out_({ ok: true, data: loadRaw_() });
  return out_({ ok: true, msg: 'نظام مدرسة سنجل جاهز' });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.setRightToLeft(true);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#14382f').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

function put_(sh, rows) {
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function saveAll_(d) {
  // الطلاب
  let sh = sheet_('الطلاب', ['الصف', 'اسم الطالب', 'ولي الأمر', 'هاتف ولي الأمر', 'ملاحظة']);
  put_(sh, d.students.map(s => [s.cls, s.name, s.parent, "'" + s.phone, s.note]));

  // الحضور
  sh = sheet_('الحضور', ['التاريخ', 'الصف', 'اسم الطالب', 'ولي الأمر', 'الهاتف', 'الحالة']);
  const att = d.attendance.map(a => [a.date, a.cls, a.name, a.parent, "'" + a.phone, a.status]);
  put_(sh, att);
  if (att.length) {
    const bg = att.map(r => Array(6).fill(r[5] === 'غائب' ? '#fbe3e0' : '#dcf2e7'));
    sh.getRange(2, 1, att.length, 6).setBackgrounds(bg);
  }

  // المخالفات (لون الصف حسب درجة المخالفة)
  sh = sheet_('المخالفات', ['التاريخ', 'الصف', 'اسم الطالب', 'نوع المخالفة', 'ملاحظة', 'رقم المخالفة', 'الإجراء', 'ولي الأمر', 'الهاتف']);
  const vio = d.violations.map(v => [v.date, v.cls, v.name, v.type, v.note, v.level, v.levelName, v.parent, "'" + v.phone]);
  put_(sh, vio);
  if (vio.length) {
    const bg = d.violations.map(v => Array(9).fill(LEVEL_COLORS[Math.min(6, v.level) - 1]));
    sh.getRange(2, 1, vio.length, 9).setBackgrounds(bg);
  }

  // الرسائل
  sh = sheet_('الرسائل', ['الوقت', 'الصف', 'الطالب', 'النوع', 'الطريقة', 'تم']);
  put_(sh, d.messages.map(m => [m.time, m.cls, m.name, m.kind, m.mode, m.ok]));

  // نسخة كاملة للاسترجاع (مقسمة لأن الخلية لها حد للحجم)
  const raw = JSON.stringify(d.raw);
  const store = sheet_('_data', ['نسخة البرنامج الكاملة، لا تعدّل']);
  const parts = [];
  for (let i = 0; i < raw.length; i += CHUNK) parts.push([raw.substring(i, i + CHUNK)]);
  if (parts.length) store.getRange(2, 1, parts.length, 1).setValues(parts);
  store.hideSheet();
}

function loadRaw_() {
  const store = SpreadsheetApp.getActive().getSheetByName('_data');
  if (!store || store.getLastRow() < 2) return null;
  const vals = store.getRange(2, 1, store.getLastRow() - 1, 1).getValues();
  return JSON.parse(vals.map(r => r[0]).join(''));
}

/**
 * تقرير يومي تلقائي بالبريد: عدد الغائبين والمخالفات لهذا اليوم.
 * التفعيل: Apps Script > المشغلات (Triggers) > إضافة مشغل > sendDailyReport > حسب الوقت > يومي
 * يُرسل إلى بريد صاحب الشيت، أو إلى REPORT_EMAIL إن حددته في Project Settings > Script properties.
 */
function sendDailyReport() {
  const ss = SpreadsheetApp.getActive();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const count = (name, col, test) => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
      .filter(r => Utilities.formatDate(new Date(r[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd') === today && test(r));
  };
  const absent = count('الحضور', 0, r => r[5] === 'غائب');
  const vio = count('المخالفات', 0, () => true);
  const lines = [
    'تقرير ' + today + ' - مدرسة ذكور سنجل الأساسية العليا',
    '',
    'الغائبون (' + absent.length + '):',
    ...absent.map(r => '- ' + r[2] + ' (' + r[1] + ')'),
    '',
    'المخالفات (' + vio.length + '):',
    ...vio.map(r => '- ' + r[2] + ' (' + r[1] + '): ' + r[3] + ' - ' + r[6])
  ];
  const to = PropertiesService.getScriptProperties().getProperty('REPORT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, 'تقرير الحضور والسلوك ' + today, lines.join('\n'));
}
