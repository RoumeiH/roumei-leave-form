// api/forms.js
// 假單 API - 建立、查詢、推播給員工簽名
// POST /api/forms?action=create    建立單筆假單(存資料庫,不推播)
// POST /api/forms?action=batch     批次建立(不推播)
// POST /api/forms?action=push      推播「某員工」的所有未簽假單(合成一則訊息)
// POST /api/forms?action=pushAll   把所有已建立、未簽的推給對應員工(逐人一則訊息)
// POST /api/forms?action=repush    重新推播單一員工(手動提醒)
// GET  /api/forms                  查詢假單清單
// GET  /api/forms?byEmp=X          查詢單一員工的未簽假單

import { db } from '../lib/firebase.js';
import { pushMessage } from '../lib/line.js';

const forms = db.collection('forms');
const bindings = db.collection('bindings');

const ROSTER = {
  '緯宸': { full: '蔡緯宸', dept: '泊車' },
  '順正': { full: '蔡順正', dept: '泊車' },
  '小涵': { full: '鍾秀珠', dept: '房務' },
  '淑雲': { full: '陳淑雲', dept: '房務' },
  '婉茹': { full: '黃婉茹', dept: '房務' },
  '玉美': { full: '黃玉美', dept: '房務' },
  '玉樺': { full: '陳玉樺', dept: '房務' },
  '俊傑': { full: '林秉德', dept: '房務' },
  '東志': { full: '鍾東志', dept: '房務' },
  '敏智': { full: '廖敏智', dept: '房務' },
  '莉莉': { full: '張莉莉', dept: '房務' },
  '俐均': { full: '賴俐均', dept: '倉管' },
};

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://roumei-leave-form.vercel.app';

async function findLineUserId(empKey) {
  const snap = await bindings
    .where('empKey', '==', empKey)
    .where('confirmed', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data().lineUserId;
}

function formatFormText(form) {
  const emp = ROSTER[form.empKey];
  const name = emp?.full || form.empKey;
  const kind = form.type === 'ot' ? '加班單'
             : form.type === 'miss' ? '未刷卡證明單'
             : form.type === 'wrong' ? '休假誤刷證明'
             : form.type === 'multiLeave' ? '請假單(多段)'
             : '請假單';

  let dateStr;
  if (form.type === 'multiLeave' && form.segments) {
    const segs = form.segments.map(s => {
      if (s.startMon === s.endMon && s.startDay === s.endDay) return `${s.startMon}/${s.startDay}`;
      return `${s.startMon}/${s.startDay}–${s.endDay}`;
    }).join('、');
    dateStr = segs;
  } else if (form.endMon && form.mergedCount > 1) {
    dateStr = `${form.mon}/${form.day}–${form.endDay}`;
  } else {
    dateStr = `${form.mon}/${form.day}`;
  }

  return { name, kind, dateStr };
}

async function createForm(formData) {
  const lineUserId = await findLineUserId(formData.empKey);
  if (!lineUserId) throw new Error(`${formData.empKey} 尚未綁定 LINE`);
  const docRef = await forms.add({
    ...formData,
    lineUserId,
    status: 'pending_employee',
    createdAt: new Date(),
    updatedAt: new Date(),
    employeeSignedAt: null,
    employeeSignatureData: null,
  });
  return docRef.id;
}

async function pushEmployeeForms(empKey) {
  const lineUserId = await findLineUserId(empKey);
  if (!lineUserId) throw new Error(`${empKey} 尚未綁定 LINE`);

  const snap = await forms
    .where('lineUserId', '==', lineUserId)
    .where('status', '==', 'pending_employee')
    .get();

  if (snap.empty) throw new Error(`${empKey} 沒有待簽假單`);

  const pending = [];
  snap.forEach(d => pending.push({ id: d.id, ...d.data() }));

  const emp = ROSTER[empKey];
  const name = emp?.full || empKey;
  const count = pending.length;

  const summary = pending.slice(0, 5).map(f => {
    const { kind, dateStr } = formatFormText(f);
    return `• ${kind} · ${dateStr}`;
  }).join('\n');
  const overflow = pending.length > 5 ? `\n...等共 ${count} 張` : '';

  const signUrl = `${BASE_URL}/sign.html?emp=${encodeURIComponent(empKey)}`;

  await pushMessage(lineUserId, [
    {
      type: 'text',
      text: `📋 ${name}您好\n\n您有 ${count} 張假單需要簽名確認:\n\n${summary}${overflow}\n\n請於方便時點選下方按鈕查看並簽名。`,
    },
    {
      type: 'template',
      altText: `您有 ${count} 張假單需要簽名`,
      template: {
        type: 'buttons',
        title: '假單簽名',
        text: `共 ${count} 張假單`,
        actions: [
          { type: 'uri', label: '查看並簽名', uri: signUrl },
        ],
      },
    },
  ]);

  const batch = db.batch();
  pending.forEach(f => {
    batch.update(forms.doc(f.id), {
      lastPushAt: new Date(),
      updatedAt: new Date(),
    });
  });
  await batch.commit();

  return { count, formIds: pending.map(f => f.id) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, status, byEmp } = req.query || {};

    if (req.method === 'GET') {
      if (byEmp) {
        const lineUserId = await findLineUserId(byEmp);
        if (!lineUserId) return res.status(200).json({ forms: [] });
        const snap = await forms
          .where('lineUserId', '==', lineUserId)
          .where('status', '==', 'pending_employee')
          .get();
        const list = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({
            id: d.id,
            ...data,
            createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
            updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
            employeeSignatureData: null,
          });
        });
        list.sort((a, b) => (a.mon * 100 + a.day) - (b.mon * 100 + b.day));
        return res.status(200).json({ forms: list });
      }

      let q = forms;
      if (status) q = q.where('status', '==', status);
      const snap = await q.orderBy('createdAt', 'desc').limit(500).get();
      const list = [];
      snap.forEach(doc => {
        const d = doc.data();
        list.push({
          id: doc.id,
          ...d,
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
          employeeSignedAt: d.employeeSignedAt?.toDate?.()?.toISOString() || null,
          lastPushAt: d.lastPushAt?.toDate?.()?.toISOString() || null,
          employeeSignatureData: d.employeeSignatureData ? '<has-signature>' : null,
        });
      });
      return res.status(200).json({ forms: list });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (action === 'create') {
        const formId = await createForm(body);
        return res.status(200).json({ ok: true, formId });
      }

      if (action === 'batch') {
        const list = body.forms || [];
        if (!Array.isArray(list) || list.length === 0) {
          return res.status(400).json({ error: '缺少 forms 陣列' });
        }
        const results = [];
        for (const f of list) {
          try {
            const formId = await createForm(f);
            results.push({ ok: true, formId, empKey: f.empKey });
          } catch (err) {
            results.push({ ok: false, empKey: f.empKey, error: err.message });
          }
        }
        return res.status(200).json({
          ok: true,
          total: results.length,
          okCount: results.filter(r => r.ok).length,
          failCount: results.filter(r => !r.ok).length,
          results,
        });
      }

      if (action === 'push' || action === 'repush') {
        const { empKey } = body;
        if (!empKey) return res.status(400).json({ error: '缺少 empKey' });
        const result = await pushEmployeeForms(empKey);
        return res.status(200).json({ ok: true, ...result });
      }

      if (action === 'pushAll') {
        const snap = await forms.where('status', '==', 'pending_employee').get();
        const byUser = {};
        snap.forEach(d => {
          const data = d.data();
          if (!byUser[data.empKey]) byUser[data.empKey] = [];
          byUser[data.empKey].push({ id: d.id, ...data });
        });

        const empKeys = Object.keys(byUser);
        const results = [];
        for (const empKey of empKeys) {
          try {
            const r = await pushEmployeeForms(empKey);
            results.push({ ok: true, empKey, ...r });
          } catch (err) {
            results.push({ ok: false, empKey, error: err.message });
          }
        }
        return res.status(200).json({
          ok: true,
          totalEmployees: empKeys.length,
          okCount: results.filter(r => r.ok).length,
          failCount: results.filter(r => !r.ok).length,
          results,
        });
      }

      return res.status(400).json({ error: '未知的 action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[forms] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
