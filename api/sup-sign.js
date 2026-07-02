// api/sup-sign.js
// 主管簽核 API
// GET  /api/sup-sign?sup=<lineUserId>        取得待主管簽核的假單清單(含員工簽名)
// POST /api/sup-sign?action=approve          批次通過(一個主管簽名蓋多張)→ 完成
// POST /api/sup-sign?action=reject           駁回單張(填原因)→ 退回管理者

import { db } from '../lib/firebase.js';

const forms = db.collection('forms');
const bindings = db.collection('bindings');

const KIND_LABEL = {
  leave: '請假單', ot: '加班單', miss: '未刷卡證明單',
  wrong: '休假誤刷證明', multiLeave: '請假單(多段)',
};

// 確認此 lineUserId 是已綁定的主管,回傳其資料
async function getSupervisor(lineUserId) {
  if (!lineUserId) return null;
  const snap = await bindings
    .where('lineUserId', '==', lineUserId)
    .where('role', '==', 'supervisor')
    .where('confirmed', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { sup, action } = req.query || {};

    // ---------- GET: 取得待簽核清單(含員工簽名) ----------
    if (req.method === 'GET') {
      const supervisor = await getSupervisor(sup);
      if (!supervisor) {
        return res.status(403).json({ error: '您不是已確認的主管,或連結有誤。', forms: [] });
      }

      const snap = await forms.where('status', '==', 'employee_signed').get();
      const list = [];
      snap.forEach(d => {
        const data = d.data();
        list.push({
          id: d.id,
          empKey: data.empKey,
          fullName: data.fullName,
          dept: data.dept,
          type: data.type,
          kind: KIND_LABEL[data.type] || '假單',
          mon: data.mon,
          day: data.day,
          endMon: data.endMon || null,
          endDay: data.endDay || null,
          mergedCount: data.mergedCount || null,
          segments: data.segments || null,
          shift: data.shift || null,
          reason: data.reason || null,
          comp: data.comp || null,
          rocYear: data.rocYear || 115,
          employeeSignatureData: data.employeeSignatureData || null,   // 給主管核對
          employeeSignedAt: data.employeeSignedAt?.toDate?.()?.toISOString() || null,
        });
      });
      list.sort((a, b) => (a.mon * 100 + a.day) - (b.mon * 100 + b.day));

      return res.status(200).json({
        forms: list,
        count: list.length,
        supervisorName: supervisor.fullName,
      });
    }

    // ---------- POST ----------
    if (req.method === 'POST') {
      const body = req.body || {};
      const supervisor = await getSupervisor(body.sup);
      if (!supervisor) {
        return res.status(403).json({ error: '您不是已確認的主管,或連結有誤。' });
      }

      // ===== 批次通過(一個主管簽名蓋多張)=====
      if (action === 'approve') {
        const { formIds, signature } = body;
        if (!Array.isArray(formIds) || formIds.length === 0 || !signature) {
          return res.status(400).json({ error: '缺少 formIds 或簽名' });
        }
        if (signature.length > 700 * 1024) {
          return res.status(413).json({ error: '簽名檔案過大,請重新簽' });
        }

        // 檢查每張都還是 employee_signed(避免別的主管已先簽/已駁回)
        const docs = await Promise.all(formIds.map(fid => forms.doc(fid).get()));
        for (const doc of docs) {
          if (!doc.exists) return res.status(404).json({ error: '找不到假單,請重新整理' });
          if (doc.data().status !== 'employee_signed') {
            return res.status(409).json({ error: '有假單已被其他主管處理,請重新整理' });
          }
        }

        const batch = db.batch();
        const now = new Date();
        formIds.forEach(fid => {
          batch.update(forms.doc(fid), {
            status: 'completed',
            supervisorSignatureData: signature,
            supervisorSignedAt: now,
            supervisorName: supervisor.fullName,
            supervisorLineUserId: supervisor.lineUserId,
            updatedAt: now,
          });
        });
        await batch.commit();

        return res.status(200).json({
          ok: true,
          completedCount: formIds.length,
          msg: `已完成 ${formIds.length} 張假單簽核`,
        });
      }

      // ===== 駁回單張(退回管理者)=====
      if (action === 'reject') {
        const { formId, reason } = body;
        if (!formId) return res.status(400).json({ error: '缺少 formId' });
        const r = (reason || '').trim();
        if (!r) return res.status(400).json({ error: '請填寫駁回原因' });

        const doc = await forms.doc(formId).get();
        if (!doc.exists) return res.status(404).json({ error: '找不到此假單' });
        if (doc.data().status !== 'employee_signed') {
          return res.status(409).json({ error: '此假單已被處理,請重新整理' });
        }

        await forms.doc(formId).update({
          status: 'rejected',
          rejectReason: r,
          rejectedByName: supervisor.fullName,
          rejectedByLineUserId: supervisor.lineUserId,
          rejectedAt: new Date(),
          updatedAt: new Date(),
        });

        return res.status(200).json({ ok: true, msg: '已駁回,將退回管理者處理' });
      }

      return res.status(400).json({ error: '未知的 action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[sup-sign] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
