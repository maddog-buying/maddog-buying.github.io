# 貨態查詢 PWA

管理者維護貨態，使用者用 Google 帳號登入後，查詢自己綁定的貨態。
資料存在 Google 試算表，後端用 Google Apps Script（免費）。

```
frontend/   PWA 前端（純 HTML/CSS/JS，可放 GitHub Pages）
backend/    Code.gs — 貼到 Apps Script 的後端程式
```

## 功能

| 角色 | 功能 |
|---|---|
| 使用者 | Google 登入、查看綁定貨態的**最新狀態**、輸入「編號＋綁定碼」自行綁定、取消綁定、離線時顯示上次查詢結果 |
| 管理者 | 新增／編輯／刪除貨態、批次更新狀態、查看完整**歷程**、綁定／移除使用者 Email、設定其他人為管理者 |

試算表會自動建立 4 張工作表：`貨態`（每筆貨態的最新狀態）、`歷程`（每次異動都會新增一列，不會覆蓋）、`綁定`（編號 ↔ Email，可多對多）、`使用者`。

## 先在本機試玩（示範模式）

`config.js` 的 `API_URL` 留空時，會進入示範模式，資料只存在瀏覽器裡：

```bash
python -m http.server 8080 --directory frontend
```

開啟 http://localhost:8080 ，可選擇以管理者或使用者身分試用。

---

## 正式部署（約 20 分鐘）

### 1. 建立試算表與後端

1. 到 Google 雲端硬碟新增一份**空白試算表**，例如命名為「貨態資料庫」。
2. 選單「擴充功能 → Apps Script」，刪掉預設內容，貼上 `backend/Code.gs` 的全部內容並儲存。
3. 上方函式選單選 `setup`，按「執行」，依提示授權。
   完成後試算表會出現 4 張工作表，而你（執行者）會被設為管理者。

### 2. 建立 Google 登入用的 OAuth 用戶端 ID

1. 前往 https://console.cloud.google.com/ ，建立一個新專案（例如 `shipment-tracker`）。
2. 「API 和服務 → OAuth 同意畫面」：
   - 使用者類型選「外部」，填寫應用程式名稱和支援 Email 即可。
   - 範圍不必新增（只用到基本的 email/profile，**不需要 Google 審核**）。
   - 完成後按「發布應用程式」，改成「實際運作中」，否則只有測試使用者能登入。
3. 「API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID」：
   - 應用程式類型：**網頁應用程式**
   - 已授權的 JavaScript 來源加入：
     - `http://localhost:8080`（本機測試用）
     - 你的正式網址，例如 `https://你的帳號.github.io`
   - 「已授權的重新導向 URI」留空。
4. 複製產生的「用戶端 ID」（格式為 `xxxx.apps.googleusercontent.com`）。

### 3. 填入用戶端 ID 並部署後端

1. 在 Apps Script 的 `Code.gs` 中，把 `GOOGLE_CLIENT_ID` 改成上一步的用戶端 ID，然後儲存。
2. 右上角「部署 → 新增部署作業」→ 類型選「網頁應用程式」：
   - 執行身分：**我**
   - 誰可以存取：**所有人**（實際權限由程式碼檢查 Google 登入，不會直接公開資料）
3. 複製「網頁應用程式網址」（結尾是 `/exec`）。

> ⚠️ 之後若修改 Code.gs，必須到「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署」，網址才會套用新程式碼（網址不變）。

### 4. 設定並發布前端

1. 編輯 `frontend/config.js`：
   ```js
   API_URL: 'https://script.google.com/macros/s/xxxx/exec',
   GOOGLE_CLIENT_ID: 'xxxx.apps.googleusercontent.com',
   ```
2. 先在本機測試：`python -m http.server 8080 --directory frontend`，開啟 http://localhost:8080 ，用 Google 登入。
3. 發布到 GitHub Pages（免費，而且是 HTTPS，PWA 必須使用 HTTPS）：
   - 建立一個 GitHub repo，把 `frontend/` 裡的檔案上傳到 repo 根目錄。
   - repo 的 Settings → Pages → Source 選 `main` branch / root。
   - 幾分鐘後即可透過 `https://你的帳號.github.io/repo名稱/` 開啟。
   - 記得把 `https://你的帳號.github.io` 加入第 2 步的「已授權的 JavaScript 來源」。

### 5. 安裝到手機

- Android（Chrome）：開啟網址 → 選單 →「安裝應用程式／加到主畫面」
- iPhone（Safari）：開啟網址 → 分享 →「加入主畫面」

---

## 日常使用

**管理者讓使用者看到貨態，有兩種方式：**
1. **直接綁定 Email**：在貨態編輯畫面輸入使用者的 Google 帳號 Email。對方不需要先登入過。
2. **給綁定碼**：每筆貨態都有一組綁定碼（新增時會自動產生）。把「編號＋綁定碼」交給客戶，客戶可以自行綁定。綁定碼留空，就只能由管理者綁定。

**修改狀態清單**：編輯 `Code.gs` 中的 `CONFIG.STATUSES`，再部署新版本。狀態顏色定義在 `app.js` 的 `TONES`。

**更新前端**：修改檔案後，把 `sw.js` 的 `VERSION` 加 1（例如改成 `v2`），使用者重新開啟兩次就會拿到新版。

## 已知限制

- Apps Script 每次請求約需 1～2 秒；資料在數千筆以內都很順暢。
- Google 登入憑證有效期限為 1 小時，過期後會自動跳出 Google 一鍵登入，再點一下即可繼續使用。
- 請勿直接在試算表中修改 `貨態` 工作表的狀態，否則不會留下歷程紀錄；請一律透過網頁操作。
