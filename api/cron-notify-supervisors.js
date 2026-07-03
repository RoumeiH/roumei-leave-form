// api/cron-notify-supervisors.js
// 由 Vercel Cron 每天中午 12:00(台灣時間)觸發。
// 只有在「每月 10 號、20 號、當月最後一天」才實際推播給主管;其餘日子略過。
// 也保留後台手動「📤 推給主管簽核」(走 /api/forms?action=notifySupervisors)。

import { db } from '../lib/firebase.js';
import { pushMessage } from '../lib/line.js';

const forms = db.collection('forms');
const bindings = db.collection('bindings');
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://roumei-leave-form.vercel.app';

// 取「台灣時間」的今天 { y, m, day, lastDay }
function taiwanToday() {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);   // UTC+8
  const y = tw.getUTCFullYear();
  const m = tw.getUTCMonth() + 1;          // 1~12
  const day = tw.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();   // 當月最後一天(自動處理大小月/閏年)
  return { y, m, day, lastDay };
}

export default async function handler(req, res) {
  // 若有設定 CRON_SECRET,驗證 Vercel Cron 帶的授權標頭(沒設定則放行)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const { y, m, day, lastDay } = taiwanToday();
  const isPushDay = (day === 10 || day === 20 || day === lastDay);

  if (!isPushDay) {
    return res.status(200).json({ ok: true, pushed: false, reason: 'not_a_push_day', tw: `${y}-${m}-${day}` });
  }

  try {
    // 找已確認主管
    const supSnap = await bindings
      .where('role', '==', 'supervisor')
      .where('confirmed', '==', true)
      .get();
    if (supSnap.empty) {
      return res.status(200).json({ ok: true, pushed: false, reason: 'no_supervisor' });
    }

    // 目前待主管簽核(員工已簽)的張數
    const pendSnap = await forms.where('status', '==', 'employee_signed').get();
    const count = pendSnap.size;
    if (count === 0) {
      return res.status(200).json({ ok: true, pushed: false, reason: 'no_pending' });
    }

    const label = (day === lastDay && day !== 10 && day !== 20) ? '月底' : `${day} 號`;
    let okCount = 0;
    const results = [];
    for (const doc of supSnap.docs) {
      const sup = doc.data();
      const url = `${BASE_URL}/sup-sign.html?sup=${encodeURIComponent(sup.lineUserId)}`;
      try {
        await pushMessage(sup.lineUserId, [
          {
            type: 'text',
            text: `👔 ${sup.fullName}您好\n\n【${m}/${day} ${label}定期提醒】\n目前有 ${count} 張假單待您簽核。\n請點下方按鈕查看並一次簽核。`,
          },
          {
            type: 'template',
            altText: `有 ${count} 張假單待您簽核`,
            template: {
              type: 'buttons',
              title: '主管簽核(定期提醒)',
              text: `共 ${count} 張待簽核`,
              actions: [{ type: 'uri', label: '查看並簽核', uri: url }],
            },
          },
        ]);
        okCount++;
        results.push({ name: sup.fullName, ok: true });
      } catch (e) {
        console.warn('推播主管失敗:', e.message);
        results.push({ name: sup.fullName, ok: false, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, pushed: true, count, supCount: okCount, results });
  } catch (err) {
    console.error('[cron-notify-supervisors] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
