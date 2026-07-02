// api/bindings.js
// 綁定管理 API - 給管理者後台使用
// GET  /api/bindings          → 列出所有綁定 + 未綁定的員工
// POST /api/bindings/confirm  → 確認一筆綁定
// POST /api/bindings/delete   → 刪除一筆綁定

import { db, bindings } from '../lib/firebase.js';
import { pushMessage } from '../lib/line.js';

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

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action } = req.query || {};

    // ---------- GET: 列出所有綁定 + 未綁定的員工 ----------
    if (req.method === 'GET') {
      const snap = await bindings.orderBy('createdAt', 'desc').get();
      const bindingList = [];
      snap.forEach(doc => {
        const data = doc.data();
        bindingList.push({
          id: doc.id,
          ...data,
          // 把 Firestore Timestamp 轉成好讀的字串
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
          boundAt: data.boundAt?.toDate?.()?.toISOString() || null,
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
        });
      });

      // 找出還沒綁定的員工(名單裡有但 bindings 沒對應紀錄)
      const boundKeys = new Set(bindingList.filter(b => b.confirmed).map(b => b.empKey));
      const unbound = Object.entries(ROSTER)
        .filter(([key]) => !boundKeys.has(key))
        .map(([key, val]) => ({
          empKey: key,
          fullName: val.full,
          dept: val.dept,
        }));

      return res.status(200).json({
        bindings: bindingList,
        unbound,
        rosterTotal: Object.keys(ROSTER).length,
      });
    }

    // ---------- POST: 確認 / 刪除 ----------
    if (req.method === 'POST') {
      const body = req.body || {};
      const bindingId = body.id;
      if (!bindingId) {
        return res.status(400).json({ error: '缺少 id' });
      }

      // 確認綁定
      if (action === 'confirm') {
        const ref = bindings.doc(bindingId);
        const doc = await ref.get();
        if (!doc.exists) {
          return res.status(404).json({ error: '找不到這筆綁定' });
        }
        const data = doc.data();

        // 檢查同一位員工是否已有其他 confirmed 的綁定(避免一人綁多帳號)
        const dupSnap = await bindings
          .where('empKey', '==', data.empKey)
          .where('confirmed', '==', true)
          .get();
        for (const d of dupSnap.docs) {
          if (d.id !== bindingId) {
            return res.status(409).json({
              error: `${data.fullName} 已有其他綁定,請先刪除舊的`,
            });
          }
        }

        await ref.update({
          confirmed: true,
          confirmedAt: new Date(),
          updatedAt: new Date(),
        });

        // 通知員工「已完成綁定」
        try {
          await pushMessage(data.lineUserId, {
            type: 'text',
            text: `✅ 您的員工身分「${data.fullName}(${data.dept})」已通過管理者確認。\n\n以後有假單需要簽名時,系統會透過 LINE 通知您。`,
          });
        } catch (e) {
          console.warn('推播通知失敗(不影響確認):', e.message);
        }

        return res.status(200).json({ ok: true, msg: '已確認並通知員工' });
      }

      // 刪除綁定
      if (action === 'delete') {
        const ref = bindings.doc(bindingId);
        const doc = await ref.get();
        if (!doc.exists) {
          return res.status(404).json({ error: '找不到這筆綁定' });
        }
        const data = doc.data();

        await ref.delete();

        // 通知員工「綁定已解除,請重新綁定」
        try {
          await pushMessage(data.lineUserId, {
            type: 'text',
            text: `⚠️ 您的身分綁定已由管理者解除。\n\n請重新加入本官方帳號好友,或點選以下連結重新綁定:\n${process.env.PUBLIC_BASE_URL || 'https://roumei-leave-form.vercel.app'}/bind.html?token=${data.lineUserId}`,
          });
        } catch (e) {
          console.warn('推播通知失敗(不影響刪除):', e.message);
        }

        return res.status(200).json({ ok: true, msg: '已刪除並通知員工' });
      }

      return res.status(400).json({ error: '未知的 action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[bindings] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
