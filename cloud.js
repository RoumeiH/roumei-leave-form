/* =========================================================
   柔美飯店假單系統 · Firebase 雲端模組
   ---------------------------------------------------------
   功能：
   - Firebase 初始化(Auth + Firestore)
   - 使用者登入 / 登出 / 狀態監聽
   - 雲端讀寫：settings(系統設定)、drafts(草稿)、forms(歷史)
   - 對外提供簡單的 API 供 app.js 呼叫
   ========================================================= */

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, getDocs, query, where, orderBy,
  deleteDoc, onSnapshot, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ---------- Firebase 專案設定 ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyBpeik6Re2lAIZEkWsiH0j2cT7W01IuvhU",
  authDomain: "roumei-leave-form.firebaseapp.com",
  projectId: "roumei-leave-form",
  storageBucket: "roumei-leave-form.firebasestorage.app",
  messagingSenderId: "24059754928",
  appId: "1:24059754928:web:3bf2ba13b72e7b8afebe75"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 使用「本機儲存」永久保持登入狀態(關掉瀏覽器再打開也不用重登)
setPersistence(auth, browserLocalPersistence);

/* =========================================================
   認證(Authentication)
   ========================================================= */

// 監聽登入狀態變化
export function watchAuth(callback){
  return onAuthStateChanged(auth, user => {
    callback(user);
  });
}

// 目前使用者
export function currentUser(){ return auth.currentUser; }

// 登入
export async function login(email, password){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// 登出
export async function logout(){
  await signOut(auth);
}

/* =========================================================
   系統設定(settings/main)
   ---------------------------------------------------------
   全站共用的設定:班表 URL、當前月份、名單等
   ========================================================= */

const SETTINGS_DOC = doc(db, "settings", "main");

// 讀取系統設定(找不到就回傳預設值)
export async function loadSettings(){
  const snap = await getDoc(SETTINGS_DOC);
  if(snap.exists()) return snap.data();
  return {
    scheduleUrl: "",
    currentRocYear: 115,
    currentMonth: null,
    lastUpdated: null
  };
}

// 儲存系統設定(部分更新)
export async function saveSettings(patch){
  await setDoc(SETTINGS_DOC, {
    ...patch,
    lastUpdated: serverTimestamp()
  }, { merge: true });
}

/* =========================================================
   草稿(drafts/)- 未列印的假單
   ---------------------------------------------------------
   A 電腦加的草稿,B 電腦打開就看到
   ========================================================= */

const DRAFTS_COL = collection(db, "drafts");

// 新增一筆草稿
export async function addDraft(draft){
  const ref = await addDoc(DRAFTS_COL, {
    ...draft,
    status: "draft",
    createdAt: serverTimestamp(),
    createdBy: auth.currentUser?.email || "unknown"
  });
  return ref.id;
}

// 更新草稿
export async function updateDraft(id, patch){
  await updateDoc(doc(db, "drafts", id), patch);
}

// 刪除草稿
export async function deleteDraft(id){
  await deleteDoc(doc(db, "drafts", id));
}

// 監聽草稿變化(即時同步:A 電腦加草稿,B 電腦立刻看到)
export function watchDrafts(callback){
  const q = query(DRAFTS_COL, orderBy("createdAt", "asc"));
  return onSnapshot(q, snap => {
    const drafts = [];
    snap.forEach(doc => drafts.push({ id: doc.id, ...doc.data() }));
    callback(drafts);
  });
}

/* =========================================================
   歷史記錄(forms/)- 已產出的假單
   ---------------------------------------------------------
   列印/送出後留下的永久記錄,供查詢統計
   ========================================================= */

const FORMS_COL = collection(db, "forms");

// 將草稿轉為歷史記錄(列印時呼叫)
export async function archiveDraft(draft){
  const data = {
    ...draft,
    status: "completed",
    outputBy: "列印",  // 之後 LINE 版會用 'LINE'
    completedAt: serverTimestamp(),
    completedBy: auth.currentUser?.email || "unknown"
  };
  // 刪除 draft 專屬欄位
  delete data.id;
  delete data.createdAt;
  delete data.createdBy;
  await addDoc(FORMS_COL, data);
}

// 讀取單張假單完整內容(含簽名 base64)——給追蹤後台「看簽名」用
// 管理者已登入,firestore.rules 允許 admin 讀 forms,故直接走 SDK 讀,不經公開 API
export async function getFormById(id){
  const snap = await getDoc(doc(db, "forms", id));
  if(!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// 刪除單張假單(給追蹤後台刪掉被駁回的錯誤假單用)
export async function deleteFormById(id){
  await deleteDoc(doc(db, "forms", id));
}

// 查詢歷史(可依員工、月份篩選,第二階段大量使用)
export async function queryForms(filters = {}){
  const conds = [];
  if(filters.empKey) conds.push(where("empKey", "==", filters.empKey));
  if(filters.mon) conds.push(where("mon", "==", filters.mon));
  if(filters.formType) conds.push(where("formType", "==", filters.formType));
  const q = conds.length
    ? query(FORMS_COL, ...conds, orderBy("completedAt", "desc"))
    : query(FORMS_COL, orderBy("completedAt", "desc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
  return rows;
}

/* =========================================================
   對外統一介面
   ========================================================= */

window.Cloud = {
  // Auth
  watchAuth, currentUser, login, logout,
  // Settings
  loadSettings, saveSettings,
  // Drafts
  addDraft, updateDraft, deleteDraft, watchDrafts,
  // Forms
  archiveDraft, queryForms, getFormById, deleteFormById
};

console.log("[Cloud] Firebase 模組已載入");
