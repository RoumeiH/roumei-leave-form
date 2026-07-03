// api/bind.js
// 員工在綁定頁點「我是 XXX」時,呼叫此 API 儲存
// GET: 讀取員工名單(給綁定頁使用)
// POST: 儲存綁定

import { upsertBinding, findBindingByEmpKey, findBindingByLineId } from '../lib/firebase.js';
import { getUserProfile } from '../lib/line.js';

// 排班系統(讀名冊用;規則開放,可直接讀)
const SHIFT_PROJECT = 'hotel-shift-8fc12';
const SHIFT_API_KEY = 'AIzaSyB9LgyqQCGjcAiWr4AZjarD8U-Um9lm9Hg';

// 讀不到排班名冊時的備援名單
const FALLBACK_ROSTER = {
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

// 解析 Firestore REST 的值格式
function fsDecode(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = fsDecode(f[k]); return o; }
  if ('arrayValue' in v) { return (v.arrayValue.values || []).map(fsDecode); }
  return null;
}

// 從排班系統讀員工名冊 → { 暱稱: { full:中文名, dept:職稱 } }
async function fetchShiftRoster() {
  const url = `https://firestore.googleapis.com/v1/projects/${SHIFT_PROJECT}/databases/(default)/documents/config/main?key=${SHIFT_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('讀排班名冊 HTTP ' + r.status);
  const doc = await r.json();
  const fields = doc.fields || {};
  const employees = fsDecode(fields.employees) || [];
  const depts = fsDecode(fields.depts) || [];
  const positions = fsDecode(fields.positions) || [];
  const deptName = {}; depts.forEach(d => { if (d && d.id) deptName[d.id] = d.name; });
  const posName = {}; positions.forEach(p => { if (p && p.id) posName[p.id] = p.name; });
  const roster = {};
  employees.forEach(e => {
    if (!e || e.active === false) return;
    const nick = e.name; if (!nick) return;
    const dName = deptName[e.deptId] || '';
    roster[nick] = { full: e.cnName || nick, dept: posName[e.positionId] || dName || '房務' };
  });
  if (Object.keys(roster).length === 0) throw new Error('排班名冊為空');
  if (!roster['俐均']) roster['俐均'] = { full: '賴俐均', dept: '倉管' };   // 特例:倉管
  return roster;
}

// 取名冊(優先排班系統,失敗用備援)
async function getRoster() {
  try { return await fetchShiftRoster(); }
  catch (e) { console.warn('讀排班名冊失敗,改用備援:', e.message); return FALLBACK_ROSTER; }
}

export default async function handler(req, res) {
  // CORS(讓靜態網頁能呼叫這個 API)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // 回傳員工名單 + 已被綁定的員工(讓 UI 顯示已被其他人占用)
      const ROSTER = await getRoster();
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
      const { lineUserId, empKey, role, supName } = req.body || {};
      if (!lineUserId) {
        return res.status(400).json({ error: '缺少 lineUserId' });
      }

      // 取得 LINE 使用者資料(名字、頭像)- 員工/主管共用
      let profile = {};
      try {
        profile = await getUserProfile(lineUserId);
      } catch (e) {
        console.warn('取不到 LINE 使用者資料:', e.message);
      }

      // ===== 主管綁定(不在員工名單,自己輸入姓名)=====
      if (role === 'supervisor') {
        const name = (supName || '').trim();
        if (!name) {
          return res.status(400).json({ error: '請輸入姓名' });
        }
        await upsertBinding({
          lineUserId,
          empKey: 'sup:' + lineUserId,   // 主管專用 key(每人唯一,不與員工衝突)
          role: 'supervisor',
          fullName: name,
          dept: '主管',
          lineName: profile.displayName || null,
          pictureUrl: profile.pictureUrl || null,
          confirmed: false,              // 需管理者確認
          boundAt: new Date(),
        });
        return res.status(200).json({
          ok: true,
          msg: `已提交主管綁定申請,等待管理者確認。姓名: ${name}`,
          needConfirm: true,
        });
      }

      // ===== 員工綁定(原邏輯)=====
      if (!empKey) {
        return res.status(400).json({ error: '缺少 empKey' });
      }
      const ROSTER = await getRoster();
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

      await upsertBinding({
        lineUserId,
        empKey,
        role: 'employee',
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
