# Pilot checklist（5–10 位朋友）

> 每一項做完就打勾，並在後面寫上日期。指令和查詢見 [`observability.md`](observability.md)。

## A. 邀請朋友之前（全部完成才開始）

### 環境與設定
- [ ] Cloudflare secret `ADMIN_TOKEN` 已設定（`npx wrangler secret list` 看得到）
- [ ] LINE Developers Console → Messaging API → **Webhook redelivery 已開啟**
- [ ] `/diag` 帶 token：`secrets.*`、`db.ok`、`gemini.ok`、`line.ok` 全部 `true`
- [ ] 不帶 token 打 `/diag` 回 404
- [ ] Rich Menu「🐽 任務本」有出現，點了會開任務中心
- [ ] 弄清楚 Cloudflare **Workers Builds 非 main 分支一直失敗**的原因（PR #1、#2 的分支都失敗，main 正常）；如果只是 preview build 的設定問題，可以關掉非 main 分支的 build
- [ ] 確認「merge 到 main = 自動部署 production」；之後每次 merge 都當作部署

### 驗收
- [ ] [`e2e-acceptance.md`](e2e-acceptance.md) 的 R2 全部 ✅，特別是 E02、E03：按鈕的 `outcome=ok`、`wallTimeMs` 遠低於 2000
- [ ] 22:30 晚間回顧至少實際收過一次（E12）
- [ ] 例行任務至少跑過一個完整週期（E09：提醒 → 完成 → 下一次照常提醒）

### 成本
- [ ] 算過一個月的訊息量：10 人 ×（每天約 1 則提醒 + 1 則晚間回顧）≈ **600 則 / 月**，超過輕用量的免費 200 則
- [ ] 決定方案：升級中用量（3,000 則），或是 pilot 先限制人數、天數
- [ ] 知道輕用量額度用完之後會發生什麼：push 會失敗，提醒和晚間回顧會送不出去。reply 不受影響

### 隱私與說明（傳給朋友的邀請訊息裡要有）
- [ ] 這是測試中的個人專案，**不是醫療或心理治療工具**
- [ ] 會記錄：任務內容、完成和卡住的紀錄、晚間心情和情緒的選擇
- [ ] 任務內容會送到 Google Gemini 做理解
- [ ] 資料保留多久、pilot 結束後怎麼處理（建議：pilot 結束後 30 天內刪除，或依要求立即刪除）
- [ ] 有問題或想退出時找誰

### 復原手段
- [ ] 知道怎麼回到上一版：`cd cloudflare && npx wrangler deployments list`，接著 `npx wrangler rollback`
- [ ] 知道怎麼暫停 bot：在 LINE Developers Console 暫時關閉 **Use webhook**

## B. Pilot 期間：每天一次（約 5 分鐘）

- [ ] `/diag`：各項 `ok`，記下 `push_usage.this_month_total`
- [ ] `/diag/reminders`：`due_now` = 0
- [ ] D1：過期沒送的提醒 = 0、卡住的 claim = 0、卡住的 webhook 事件 = 0
- [ ] D1：昨天的晚間回顧 `sent` 等於活躍人數、`claimed_not_sent` = 0
- [ ] Cloudflare log：沒有 `canceled`，沒有大量 `failed`
- [ ] Queue 的 DLQ（`gemini-tasks-dlq`）沒有新訊息
- [ ] 記下朋友回報的問題，依 P0–P3 分級

**馬上停下來處理（P0）：**
- 有人回報按了沒反應、提醒沒來、收到重複訊息
- 出現 `canceled`、DLQ 有新訊息、過期提醒 > 0
- 錯動到別人的任務，或資料外洩的任何跡象

## C. 第一週結束

- [ ] 實際 push 用量（依 purpose 分類）→ 決定 LINE 方案
- [ ] 產品指標（第 4 節的卡住介入查詢）：卡住、問卡點、先做 5 分鐘、步驟完成、完成各有多少
- [ ] `AI decision` 抽查：「還沒」這類短句的判斷正確率、`fallback` 出現幾次
- [ ] 每位朋友各問 3 題：哪個功能最有用？哪裡讓你覺得被催或有壓力？有沒有按了沒反應的時候？
- [ ] 決定下一個 PR（候選：同一使用者的訊息依序處理、AI 改成直接回傳日期和時間、提醒成功時寫 log、拆檔）

## D. Pilot 結束
- [ ] 依當初說好的方式處理資料（刪除或匿名化）
- [ ] 寫 pilot 總結：人數、天數、push 用量、主要問題、下一步
