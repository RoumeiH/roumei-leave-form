// api/line-webhook.js
// 接收 LINE 傳來的所有事件(加好友、訊息、Postback 等)

import crypto from 'node:crypto';
import * as lineSDK from '@line/bot-sdk';
import { pushMessage, replyMessage, getUserProfile } from '../lib/line.js';
import { findBindingByLineId } from '../lib/firebase.js';

// Vercel 要接收 raw body 才能驗證簽章(必要設定)
export const config = {
  api: { bodyParser: false },
};

// 讀取 raw body
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 驗證 LINE 簽章
function verifySignature(rawBody, signature, secret) {
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return hash === signature;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, msg: 'LINE webhook endpoint' });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['x-line-signature'];

    // 驗證是否真的來自 LINE
    if (!verifySignature(rawBody, signature, process.env.LINE_CHANNEL_SECRET)) {
      console.error('[webhook] 簽章驗證失敗');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(rawBody);
    const events = body.events || [];

    // 處理每個事件
    await Promise.all(events.map(handleEvent));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook] 錯誤:', err);
    return res.status(500).json({ error: err.message });
  }
}

// LIFF 綁定頁的網址(部署後填自己的)
const BIND_URL = process.env.PUBLIC_BASE_URL
  ? `${process.env.PUBLIC_BASE_URL}/bind.html`
  : 'https://roumei-leave-form.vercel.app/bind.html';

// 處理單一事件
async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  switch (event.type) {
    case 'follow':
      // 有人加好友 → 檢查是否已綁定
      await handleFollow(event, userId);
      break;

    case 'message':
      // 收到訊息 → 若含關鍵字「我是」開頭,提示改用綁定連結
      if (event.message.type === 'text') {
        await handleTextMessage(event, userId);
      }
      break;

    case 'postback':
      // 未來簽核用得到
      break;

    default:
      // 其他事件先忽略
      break;
  }
}

async function handleFollow(event, userId) {
  // 檢查此 user 是否已經綁定
  const existing = await findBindingByLineId(userId);

  if (existing?.confirmed) {
    // 已綁定 → 打招呼
    await replyMessage(event.replyToken, {
      type: 'text',
      text: `${existing.fullName}您好,歡迎再次加入柔美飯店假單系統 🌸\n有新假單時系統會通知您。`,
    });
    return;
  }

  // 未綁定 → 引導綁定
  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: '您好,歡迎加入柔美飯店假單簽核系統 🌸\n\n請先綁定身分,以便日後接收假單通知。\n\n・員工:選自己的姓名\n・主管:請點名單最下方的「我是主管」',
    },
    {
      type: 'template',
      altText: '請點選按鈕綁定身分',
      template: {
        type: 'buttons',
        title: '身分綁定',
        text: '員工選姓名 · 主管點最下方「我是主管」',
        actions: [
          {
            type: 'uri',
            label: '開始綁定',
            uri: `${BIND_URL}?token=${userId}`,
          },
        ],
      },
    },
  ]);
}

async function handleTextMessage(event, userId) {
  const text = event.message.text.trim();

  // 查此人是否已完成綁定
  const existing = await findBindingByLineId(userId);
  const notBound = !existing || !existing.confirmed;
  const wantsBind = text.startsWith('我是') || text.includes('綁定');

  // 尚未綁定的人 → 不管傳什麼都回綁定連結;已綁定者只在關鍵字時回(避免像 chatbot)
  if (notBound || wantsBind) {
    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: notBound
          ? '請點下方按鈕完成身分綁定 🌸\n\n・員工:選自己的姓名\n・主管:請點名單最下方的「我是主管」'
          : '若要重新綁定,請點下方按鈕。',
      },
      {
        type: 'template',
        altText: '請點按鈕綁定身分',
        template: {
          type: 'buttons',
          title: '身分綁定',
          text: '員工選姓名 · 主管點最下方「我是主管」',
          actions: [
            { type: 'uri', label: '開始綁定', uri: `${BIND_URL}?token=${userId}` },
          ],
        },
      },
    ]);
    return;
  }

  // 已綁定且非關鍵字訊息 → 不回覆
}
