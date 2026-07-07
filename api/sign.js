// api/sign.js
// GET  /api/sign?id=xxx       取得單張假單內容
// GET  /api/sign?emp=xxx      取得某員工所有未簽假單
// POST /api/sign?action=submit          單張簽名
// POST /api/sign?action=submitBatch     批次簽名(一次蓋多張)

import { db } from '../lib/firebase.js';

const forms = db.collection('forms');
const bindings = db.collection('bindings');

// 是否為需檢附診斷書的病假(單段或多段任一段)
function docIsSick(d) {
  if (d.type === 'leave') return d.reason === '病假';
  if (d.type === 'multiLeave' && Array.isArray(d.segments)) return d.segments.some(s => s.reason === '病假');
  return false;
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
      const { formIds, signature, certs } = body;
      if (!Array.isArray(formIds) || formIds.length === 0 || !signature) {
        return res.status(400).json({ error: '缺少 formIds 或簽名' });
      }
      if (signature.length > 700 * 1024) {
        return res.status(413).json({ error: '簽名檔案過大,請重新簽' });
      }
      // 診斷書大小檢查(單張上限 1MB)
      if (certs && typeof certs === 'object') {
        for (const k of Object.keys(certs)) {
          if (certs[k] && certs[k].length > 1024 * 1024) {
            return res.status(413).json({ error: '診斷書照片過大,請重拍或選較小的圖' });
          }
        }
      }

      // 檢查每張假單都是 pending 狀態
      const docs = await Promise.all(formIds.map(fid => forms.doc(fid).get()));
      for (const doc of docs) {
        if (!doc.exists) {
          return res.status(404).json({ error: `找不到假單: ${doc.id}` });
        }
        const dd = doc.data();
        if (dd.status !== 'pending_employee') {
          return res.status(409).json({ error: '有假單已簽名,請重新整理' });
        }
        // 病假必填診斷書:未附則擋下(伺服器端保險)
        if (docIsSick(dd) && !(certs && certs[doc.id])) {
          return res.status(400).json({ error: '病假必須檢附診斷書才能送出,請先上傳診斷書' });
        }
      }

      // 批次更新
      const batch = db.batch();
      const now = new Date();
      formIds.forEach(fid => {
        const upd = {
          status: 'employee_signed',
          employeeSignatureData: signature,
          employeeSignedAt: now,
          updatedAt: now,
        };
        if (certs && certs[fid]) { upd.medicalCertData = certs[fid]; upd.medicalCertAt = now; }
        batch.update(forms.doc(fid), upd);
      });
      await batch.commit();

      // (主管通知改為「每月定時排程 + 後台手動推」,不在員工簽名當下推,避免洗版)

      return res.status(200).json({
        ok: true,
        signedCount: formIds.length,
        msg: `已完成 ${formIds.length} 張假單簽名`,
      });
    }

    // ---------- POST: 單張簽名(相容舊版) ----------
    if (req.method === 'POST' && action === 'submit') {
      const body = req.body || {};
      const { id: formId, signature, cert } = body;
      if (!formId || !signature) {
        return res.status(400).json({ error: '缺少 id 或簽名' });
      }
      if (signature.length > 700 * 1024) {
        return res.status(413).json({ error: '簽名檔案過大,請重新簽' });
      }
      if (cert && cert.length > 1024 * 1024) {
        return res.status(413).json({ error: '診斷書照片過大,請重拍或選較小的圖' });
      }

      const doc = await forms.doc(formId).get();
      if (!doc.exists) return res.status(404).json({ error: '找不到此假單' });
      const d = doc.data();
      if (d.status !== 'pending_employee') {
        return res.status(409).json({ error: '此假單已簽名或狀態異常' });
      }
      // 病假必填診斷書(伺服器端保險)
      if (docIsSick(d) && !cert) {
        return res.status(400).json({ error: '病假必須檢附診斷書才能送出,請先上傳診斷書' });
      }

      const upd = {
        status: 'employee_signed',
        employeeSignatureData: signature,
        employeeSignedAt: new Date(),
        updatedAt: new Date(),
      };
      if (cert) { upd.medicalCertData = cert; upd.medicalCertAt = new Date(); }
      await forms.doc(formId).update(upd);

      // (主管通知改為「每月定時排程 + 後台手動推」,不在員工簽名當下推,避免洗版)

      return res.status(200).json({ ok: true, msg: '簽名已送出' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[sign] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
