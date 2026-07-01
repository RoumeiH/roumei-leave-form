// lib/firebase.js — Firebase Admin SDK 初始化(伺服器端用)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 只初始化一次(Vercel Serverless Functions 會重複載入)
if (!getApps().length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT || '{}'
  );
  initializeApp({
    credential: cert(serviceAccount),
    projectId: 'roumei-leave-form',
  });
}

export const db = getFirestore();

// 綁定集合的操作
export const bindings = db.collection('bindings');

// 依 LINE user ID 找員工
export async function findBindingByLineId(lineUserId) {
  const snap = await bindings.where('lineUserId', '==', lineUserId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// 依員工小名找綁定
export async function findBindingByEmpKey(empKey) {
  const snap = await bindings.where('empKey', '==', empKey).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// 新增/更新綁定
export async function upsertBinding(data) {
  const existing = await findBindingByLineId(data.lineUserId);
  if (existing) {
    await bindings.doc(existing.id).update({
      ...data,
      updatedAt: new Date(),
    });
    return existing.id;
  }
  const ref = await bindings.add({
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return ref.id;
}
