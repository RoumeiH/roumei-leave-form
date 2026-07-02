// api/sign.js
// 員工簽名相關 API
// GET  /api/sign?id=xxx           取得假單內容(供簽名頁載入)
// POST /api/sign?action=submit    員工送出簽名

import { db } from '../lib/firebase.js';
import { pushMessage } from '../lib/line.js';

const forms = db.collection('forms');

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { id, action } = req.query || {};

    // ---------- GET: 取得假單內容 ----------
    if (req.method === 'GET') {
      if (!id) return res.status(400).json({ error: '缺少假單 id' });
      const doc = await forms.doc(id).get();
      if (!doc.exists) return res.status(404).json({ error: '找不到此假單' });
      const d = doc.data();
      return res.status(200).json({
        id: doc.id,
        empKey: d.empKey,
        fullName: d.fullName,
        dept: d.dept,
        type: d.type,
        mon: d.mon,
        day: d.day,
        endMon: d.endMon || null,
        endDay: d.endDay || null,
        mergedCount: d.mergedCount || null,
        segments: d.segments || null,
        shift: d.shift || null,
        reason: d.reason || null,
        comp: d.comp || null,
        rocYear: d.rocYear || 115,
        status: d.status,
        alreadySigned: d.status !== 'pending_employee',
        employeeSignedAt: d.employeeSignedAt?.toDate?.()?.toISOString() || null,
      });
    }

    // ---------- POST: 送出簽名 ----------
    if (req.method === 'POST' && action === 'submit') {
      const body = req.body || {};
      const { id: formId, signature } = body;
      if (!formId || !signature) {
        return res.status(400).json({ error: '缺少 id 或簽名' });
      }
      // 檢查簽名大小(base64 約需 < 500KB,避免 Firestore 文件過大)
      if (signature.length > 700 * 1024) {
        return res.status(413).json({ error: '簽名檔案過大,請重新簽' });
      }

      const doc = await forms.doc(formId).get();
      if (!doc.exists) return res.status(404).json({ error: '找不到此假單' });
      const d = doc.data();

      if (d.status !== 'pending_employee') {
        return res.status(409).json({ error: '此假單已簽名或狀態異常' });
      }

      await forms.doc(formId).update({
        status: 'employee_signed',
        employeeSignatureData: signature,
        employeeSignedAt: new Date(),
        updatedAt: new Date(),
      });

      return res.status(200).json({ ok: true, msg: '簽名已送出,感謝!' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[sign] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
