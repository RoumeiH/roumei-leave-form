// lib/line.js — LINE Bot SDK 初始化與工具函式
import * as lineSDK from '@line/bot-sdk';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 建立 LINE client
export const lineClient = new lineSDK.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// 驗證 webhook 簽章的中介函式(讓 LINE SDK 幫我們做)
export const lineMiddleware = lineSDK.middleware(config);

// 推播訊息給某個 LINE user
export async function pushMessage(userId, messages) {
  return lineClient.pushMessage({
    to: userId,
    messages: Array.isArray(messages) ? messages : [messages],
  });
}

// 回覆某則訊息(給 replyToken 用)
export async function replyMessage(replyToken, messages) {
  return lineClient.replyMessage({
    replyToken,
    messages: Array.isArray(messages) ? messages : [messages],
  });
}

// 從 user ID 取得 LINE 使用者資料(名字、頭像)
export async function getUserProfile(userId) {
  return lineClient.getProfile(userId);
}
