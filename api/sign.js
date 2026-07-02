// api/sign.js
// GET  /api/sign?id=xxx       取得單張假單內容
// GET  /api/sign?emp=xxx      取得某員工所有未簽假單
// POST /api/sign?action=submit          單張簽名
// POST /api/sign?action=submitBatch     批次簽名(一次蓋多張)

import { db } from '../lib/firebase.js';
import { pushMessage } from '../lib/line.js';

const forms = db.collection('forms');
const bindings = db.collection('bindings');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://roumei-leave-form.vercel.app';

// 員工簽完後,推播通知所有「已確認主管」有待簽核假單
async function notifySupervisors() {
  try {
    const supSnap = await bindings
      .where('role', '==', 'supervisor')
      .where('confirmed', '==', true)
      .get();
    if (supSnap.empty) return;

    // 目前待主管簽核的張數(員工已簽、尚未完成)
    const pendSnap = await forms.where('status', '==', 'employee_signed').get();
    const count = pendSnap.size;
    if (count === 0) return;

    for (const doc of supSnap.docs) {
      const sup = doc.data();
      const url = `${BASE_URL}/sup-sign.html?sup=${encodeURIComponent(sup.lineUserId)}`;
      try {
        await pushMessage(sup.lineUserId, [
          {
            type: 'text',
            text: `👔 ${sup.fullName}您好\n\n目前有 ${count} 張假單已由員工簽名,待您簽核。\n請點下方按鈕查看並簽核。`,
          },
          {
            type: 'template',
            altText: `有 ${count} 張假單待您簽核`,
            template: {
              type: 'buttons',
              title: '主管簽核',
              text: `共 ${count} 張待簽核`,
              actions: [{ type: 'uri', label: '查看並簽核', uri: url }],
            },
          },
        ]);
      } catch (e) {
        console.warn('推播主管失敗:', e.message);
      }
    }
  } catch (e) {
    console.warn('notifySupervisors 失敗(不影響員工簽名):', e.message);
  }
}

async function findLineUserId(empKey) {
  const snap = await bindings
    .where('empKey', '==', empKey)
    .where('confirmed', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data().lineUserId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { id, emp, action } = req.query || {};

    // ---------- GET: 取得員工所有未簽 ----------
    if (req.method === 'GET' && emp) {
      const lineUserId = await findLineUserId(emp);
      if (!lineUserId) return res.status(200).json({ forms: [], empKey: emp });
      const snap = await forms
        .where('lineUserId', '==', lineUserId)
        .where('status', '==', 'pending_employee')
        .get();
      const list = [];
      snap.forEach(d => {
        const data = d.data();
        list.push({
          id: d.id,
          empKey: data.empKey,
          fullName: data.fullName,
          dept: data.dept,
          type: data.type,
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
        });
      });
      // 按日期排序
      list.sort((a, b) => (a.mon * 100 + a.day) - (b.mon * 100 + b.day));
      return res.status(200).json({ forms: list, empKey: emp, count: list.length });
    }

    // ---------- GET: 取得單張假單內容(相容舊版) ----------
    if (req.method === 'GET' && id) {
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

    // ---------- POST: 批次簽名(一次蓋多張) ----------
    if (req.method === 'POST' && action === 'submitBatch') {
      const body = req.body || {};
      const { formIds, signature } = body;
      if (!Array.isArray(formIds) || formIds.length === 0 || !signature) {
        return res.status(400).json({ error: '缺少 formIds 或簽名' });
      }
      if (signature.length > 700 * 1024) {
        return res.status(413).json({ error: '簽名檔案過大,請重新簽' });
      }

      // 檢查每張假單都是 pending 狀態
      const docs = await Promise.all(formIds.map(fid => forms.doc(fid).get()));
      for (const doc of docs) {
        if (!doc.exists) {
          return res.status(404).json({ error: `找不到假單: ${doc.id}` });
        }
        if (doc.data().status !== 'pending_employee') {
          return res.status(409).json({ error: '有假單已簽名,請重新整理' });
        }
      }

      // 批次更新
      const batch = db.batch();
      const now = new Date();
      formIds.forEach(fid => {
        batch.update(forms.doc(fid), {
          status: 'employee_signed',
          employeeSignatureData: signature,
          employeeSignedAt: now,
          updatedAt: now,
        });
      });
      await batch.commit();

      // 員工簽完 → 通知主管有待簽核(best-effort,不影響簽名結果)
      await notifySupervisors();

      return res.status(200).json({
        ok: true,
        signedCount: formIds.length,
        msg: `已完成 ${formIds.length} 張假單簽名`,
      });
    }

    // ---------- POST: 單張簽名(相容舊版) ----------
    if (req.method === 'POST' && action === 'submit') {
      const body = req.body || {};
      const { id: formId, signature } = body;
      if (!formId || !signature) {
        return res.status(400).json({ error: '缺少 id 或簽名' });
      }
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

      // 員工簽完 → 通知主管有待簽核
      await notifySupervisors();

      return res.status(200).json({ ok: true, msg: '簽名已送出' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[sign] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
