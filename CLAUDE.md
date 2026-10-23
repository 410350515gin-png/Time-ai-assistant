# CLAUDE.md — 實作者指引

你是這個 repo 的主要實作者。另一個 AI（ChatGPT / Codex）會在 PR 上擔任第二 reviewer 和產品邏輯驗收。

## 專案
豬豬行程小秘書：LINE 個人任務助理。主要程式在 `cloudflare/src/index.js`（Cloudflare Workers + D1 + Queue + Cron + Gemini）。
變更紀錄見 `cloudflare/CHANGES.md`。

## 產品原則（不可任意改）
1. 使用者不用記固定指令；手打的自然語言由 AI 判斷意圖。
2. Fast Path 只處理決定性操作（按鈕 postback、`系統：` 指令、待確認方案的確認字），不要用 regex 枚舉自然語言來取代 AI。
3. AI 只負責理解，不直接執行不可逆的 DB 操作；刪除等高影響動作要使用者確認。
4. 不診斷心理疾病；拖延介入必須 non-shaming；不做懲罰式 streak。
5. 這是 MVP / pilot，不是醫療產品。

## 工作方式
- 優先維持既有產品行為，不做沒有被要求的大重構。
- 每次修改都要附上或更新測試（`cloudflare/test/`），並在 PR 說明寫清楚驗證方式。
- 送 PR 前執行 `cd cloudflare && npm test`，全部通過才送。
- 一個 PR 只處理一個主題；在 PR 說明寫出 P0/P1/P2 分級、影響範圍、怎麼驗證。
- 不直接 push 到 `main`；開分支、開 PR，等 review 通過才 merge。

## 技術約定
- 時間一律以 Asia/Taipei（固定 +08:00）計算，用 `tpeLocal` / `tpeToMs`；不要依賴執行環境時區。
- D1 的 `CURRENT_TIMESTAMP` 格式是 `YYYY-MM-DD HH:MM:SS`（UTC），跟 ISO 字串比較前要先轉成同一種格式（`toSqlTs`）。
- 有副作用的流程要可以重做：事件走 `webhook_events` 狀態機；提醒和晚間回顧走 claim → send → sent；push 帶決定性的 `X-Line-Retry-Key`。
- 改 schema 時同步更新 `SCHEMA_STATEMENTS` / `SCHEMA_ALTERS` 和 `cloudflare/schema.sql`，必須可以重複執行。
- 不要把使用者原文、任務標題寫進 log。
