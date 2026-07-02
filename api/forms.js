// api/forms.js
// 假單 API - 建立、查詢、推播給員工簽名
// POST /api/forms?action=create   建立單筆假單並推播
// POST /api/forms?action=batch    批次建立(一鍵全推)
// GET  /api/forms?status=xxx      查詢假單清單
// POST /api/forms?action=repush   重新推播(單張)

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

// 依員工 empKey 找 LINE user ID
async function findLineUserId(empKey) {
  const snap = await bindings
    .where('empKey', '==', empKey)
    .where('confirmed', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data().lineUserId;
}

// 產生假單描述文字(推播用)
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

// 建立單筆假單 + 推播
async function createAndPush(formData) {
  const lineUserId = await findLineUserId(formData.empKey);
  if (!lineUserId) {
    throw new Error(`${formData.empKey} 尚未綁定 LINE,無法推播`);
  }

  // 寫入 Firestore
  const docRef = await forms.add({
    ...formData,
    lineUserId,
    status: 'pending_employee', // 等待員工簽名
    createdAt: new Date(),
    updatedAt: new Date(),
    employeeSignedAt: null,
    employeeSignatureData: null, // base64 圖片
  });
  const formId = docRef.id;

  // 推播 LINE
  const { name, kind, dateStr } = formatFormText(formData);
  const signUrl = `${BASE_URL}/sign.html?id=${formId}`;

  await pushMessage(lineUserId, [
    {
      type: 'text',
      text: `📋 ${name}您好\n\n您有一張假單需要簽名確認:\n\n📅 ${kind} · ${dateStr}\n\n請於方便時點選下方按鈕查看並簽名。`,
    },
    {
      type: 'template',
      altText: '點此查看假單',
      template: {
        type: 'buttons',
        title: '假單簽名',
        text: `${kind} · ${dateStr}`,
        actions: [
          {
            type: 'uri',
            label: '查看並簽名',
            uri: signUrl,
          },
        ],
      },
    },
  ]);

  return formId;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, status } = req.query || {};

    // ---------- GET: 列出假單 ----------
    if (req.method === 'GET') {
      let q = forms;
      if (status) q = q.where('status', '==', status);
      const snap = await q.orderBy('createdAt', 'desc').limit(200).get();
      const list = [];
      snap.forEach(doc => {
        const d = doc.data();
        list.push({
          id: doc.id,
          ...d,
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
          employeeSignedAt: d.employeeSignedAt?.toDate?.()?.toISOString() || null,
          // 不回傳簽名圖(太大),要看細節另外抓
          employeeSignatureData: d.employeeSignatureData ? '<has-signature>' : null,
        });
      });
      return res.status(200).json({ forms: list });
    }

    // ---------- POST: 建立/批次/重推 ----------
    if (req.method === 'POST') {
      const body = req.body || {};

      // 單筆建立並推播
      if (action === 'create') {
        const formId = await createAndPush(body);
        return res.status(200).json({ ok: true, formId, msg: '已推播給員工' });
      }

      // 批次建立(一鍵全推)
      if (action === 'batch') {
        const list = body.forms || [];
        if (!Array.isArray(list) || list.length === 0) {
          return res.status(400).json({ error: '缺少 forms 陣列' });
        }
        const results = [];
        for (const f of list) {
          try {
            const formId = await createAndPush(f);
            results.push({ ok: true, formId, empKey: f.empKey });
          } catch (err) {
            results.push({ ok: false, empKey: f.empKey, error: err.message });
          }
        }
        const okCount = results.filter(r => r.ok).length;
        const failCount = results.length - okCount;
        return res.status(200).json({
          ok: true,
          total: results.length,
          okCount,
          failCount,
          results,
        });
      }

      // 重新推播(單張,for 未簽的)
      if (action === 'repush') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: '缺少 id' });
        const doc = await forms.doc(id).get();
        if (!doc.exists) return res.status(404).json({ error: '找不到假單' });
        const f = doc.data();
        if (f.status === 'employee_signed') {
          return res.status(409).json({ error: '員工已簽名,不必重推' });
        }
        const { name, kind, dateStr } = formatFormText(f);
        const signUrl = `${BASE_URL}/sign.html?id=${id}`;
        await pushMessage(f.lineUserId, [
          {
            type: 'text',
            text: `🔔 ${name}您好,提醒您有一張假單尚未簽名:\n\n📅 ${kind} · ${dateStr}\n\n請點選下方按鈕完成簽名。`,
          },
          {
            type: 'template',
            altText: '點此查看假單',
            template: {
              type: 'buttons',
              title: '假單簽名(提醒)',
              text: `${kind} · ${dateStr}`,
              actions: [
                { type: 'uri', label: '查看並簽名', uri: signUrl },
              ],
            },
          },
        ]);
        await forms.doc(id).update({ updatedAt: new Date(), lastRepushAt: new Date() });
        return res.status(200).json({ ok: true, msg: '已重新推播' });
      }

      return res.status(400).json({ error: '未知的 action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[forms] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
