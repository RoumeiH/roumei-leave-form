// api/bind.js
// 員工在綁定頁點「我是 XXX」時,呼叫此 API 儲存
// GET: 讀取員工名單(給綁定頁使用)
// POST: 儲存綁定

import { upsertBinding, findBindingByEmpKey, findBindingByLineId } from '../lib/firebase.js';
import { getUserProfile } from '../lib/line.js';

// 員工名單(與前端 ROSTER 保持一致)
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
  // CORS(讓靜態網頁能呼叫這個 API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // 回傳員工名單 + 已被綁定的員工(讓 UI 顯示已被其他人占用)
      const roster = Object.entries(ROSTER).map(([key, val]) => ({
        empKey: key,
        fullName: val.full,
        dept: val.dept,
      }));
      // 檢查每個員工是否已被綁定
      const withStatus = await Promise.all(
        roster.map(async r => {
          const binding = await findBindingByEmpKey(r.empKey);
          return {
            ...r,
            takenBy: binding ? { confirmed: binding.confirmed, lineUserId: binding.lineUserId } : null,
          };
        })
      );
      return res.status(200).json({ roster: withStatus });
    }

    if (req.method === 'POST') {
      const { lineUserId, empKey } = req.body || {};
      if (!lineUserId || !empKey) {
        return res.status(400).json({ error: '缺少 lineUserId 或 empKey' });
      }
      const emp = ROSTER[empKey];
      if (!emp) {
        return res.status(400).json({ error: '員工不存在' });
      }

      // 檢查此員工是否已被別人綁定(且已確認)
      const existing = await findBindingByEmpKey(empKey);
      if (existing && existing.confirmed && existing.lineUserId !== lineUserId) {
        return res.status(409).json({
          error: `${emp.full} 已被綁定,如有錯誤請聯絡管理者`,
        });
      }

      // 取得 LINE 使用者資料(名字、頭像)
      let profile = {};
      try {
        profile = await getUserProfile(lineUserId);
      } catch (e) {
        console.warn('取不到 LINE 使用者資料:', e.message);
      }

      await upsertBinding({
        lineUserId,
        empKey,
        fullName: emp.full,
        dept: emp.dept,
        lineName: profile.displayName || null,
        pictureUrl: profile.pictureUrl || null,
        confirmed: false,  // 需管理者確認才生效
        boundAt: new Date(),
      });

      return res.status(200).json({
        ok: true,
        msg: `已提交綁定申請,等待管理者確認。您綁定為: ${emp.full}(${emp.dept})`,
        needConfirm: true,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[bind] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}
