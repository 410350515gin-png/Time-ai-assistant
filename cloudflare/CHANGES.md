# 豬豬行程小秘書 v0.3：pilot 前可靠性修正

> 這份文件是給接手的人（或 AI）看的變更說明。
> 基準：repo `main` commit `d1761e0`（2026-10-23 22:51）
> 改動檔案：`cloudflare/src/index.js`、`cloudflare/wrangler.toml`、`cloudflare/schema.sql`、`cloudflare/package.json`，新增 `cloudflare/test/`

產品決策都沒有改：使用者不用記指令、手打的自然語言交給 AI、按鈕走 Fast Path、AI 不直接執行不可逆的操作、不診斷、不羞辱。

---

## 部署前一定要做的事

1. **設定 ADMIN_TOKEN**（`/diag`、`/admin/*` 現在需要它，沒設就一律回 404）
   ```bash
   npx wrangler secret put ADMIN_TOKEN     # 隨便產生一串長亂碼
   ```
   使用方式：`curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<worker>/diag`
2. **在 LINE Developers Console 開啟 webhook redelivery**：Queue 送不進去時 webhook 會回 503，靠 LINE 重送才不會掉訊息。
3. **在本機先跑一次測試和打包檢查**
   ```bash
   cd cloudflare
   npm test              # 需要 Node 22.13 以上（使用內建的 node:sqlite）
   npm run check         # wrangler dry-run 打包（開發環境無法連 npm，所以這步還沒跑過，請在本機確認）
   npx wrangler deploy
   ```
4. **不需要手動 migration**：既有的 D1 會在每個 isolate 第一次啟動時自動補齊欄位和資料表（可以重複執行，已經用舊 schema 測過）。全新的資料庫也可以用 `schema.sql` 建立。
5. 部署後第一次有人傳訊息時，會自動建立新版 Rich Menu（v2，改用 postback）並設為預設選單。

---

## 對照 13 項 backlog

| # | 項目 | 狀態 | 怎麼做的（主要 function） |
|---|---|---|---|
| 1 | `/diag`、`/admin/*` 驗證 | ✅ | `fetch()` 開頭用 `isAdminRequest()` 做 timing-safe 比對；`/diag/reminders` 只回統計數字，不回任務標題 |
| 2 | Queue 冪等 | ✅ | `webhook_events.status`：`processing → handled（回覆已存）→ done`。retry 遇到 `handled` 只補送回覆、不重做副作用。`processing` 有 90 秒租約，處理失敗或轉交 queue 時立刻釋放（`beginEvent` / `releaseEvent` / `markEventHandled` / `finishEvent`） |
| 3 | Fast Path 直接 Reply | ✅ | `isDeterministicCandidate()` 判斷是按鈕、系統指令或確認字，就在 webhook 的 `waitUntil` 裡處理並用 reply token 回覆（不經 Gemini、不進 Queue）。需要 AI 或處理失敗才轉進 Queue |
| 4 | AI Queue 先 Reply 再 Push | ✅ | `deliver()`：事件發生 50 秒內先試 reply，失敗或過期才 push。reply 失敗記成 info，不算 error |
| 5 | Push 決定性 retry key、409 視為成功 | ✅ | `deterministicUuid(seed)`（SHA-256 → UUID）。seed：AI 回覆用 `event-reply:<webhookEventId>`、提醒用 `reminder:<task_id>:<排定的 remind_at>`、晚間回顧用 `evening:<uid>:<日期>`。`lineApiCall()` 收到 409 回傳成功，也不重複計入用量 |
| 6 | Reminder / Evening 的 DB claim | ✅ | `tasks.reminder_claimed_at` 與 `daily_checkins.claimed_at`。流程是 claim → push → 標記 sent；claim 超過 5 分鐘還沒送完就可以重新 claim（搭配 retry key 不會重複）。push 遇到 5xx/429 會放掉 claim，下一分鐘重試；遇到其他 4xx（例如使用者封鎖）就不再重試 |
| 7 | recurrence | ✅ | 重寫 `computeNextOccurrence()`，用固定 +08:00 的台灣日曆計算：週的 interval 以錨點所在的週為基準、月份用整數計算（1/31 → 2/28 → 3/31）、星期幾用台灣時間判斷、錯過很多次時直接跳到未來、處理 until。`fillRecurringFirstReminder()` 補上第一次提醒時間。`completeTask()` 完成例行任務時只記錄「這一次」，任務本身保持 pending；如果今天的提醒還沒響就直接跳到下一次 |
| 8 | 時間解析 | ✅（短期） | `normalizeIso()`：沒有時區的時間一律補 `+08:00`。prompt 明確要求一定要帶 `+08:00`。相對時間改成每個項目各自的 `plan_items[].time_semantics`，一句話裡有兩個提醒就是兩個時間。**長期**改成 AI 回傳 date + time 這件事還沒做 |
| 9 | Pending plan TTL + plan id | ✅ | `getPendingPlan()` 只讀 30 分鐘內的方案；`setPendingPlan()` 會給每份方案一個 id；確認、取消、修改按鈕都是帶 id 的 postback（`系統：確認方案:<id>`），舊按鈕會回「已過期」。`executePendingPlan()` 存檔前會重新驗證時間，已過期的提醒會明確告訴使用者 |
| 10 | first_step ≠ 整件完成 | ✅ | 「先做 5 分鐘」之後的按鈕改成 `系統：步驟完成`：記一筆 `step_done` 事件、把 stuck_count 歸零，再讓使用者選「整件做完／再做 5 分鐘／先到這裡」 |
| 11 | local fallback 不提案 | ✅ | `buildLocalFallback()` 只回「我這邊暫時沒辦法理解這句話，這次先不動你的任務🐽」 |
| 12 | Rich Menu 與 Fast Path 統一 | ✅ | 新版選單用 postback `系統：列出任務`（設定 key 是 `default_rich_menu_id_v2`）；舊選單送來的「系統：任務首頁」也能直接處理 |
| 13 | Push 用途統計 | ✅ | `push_usage(date_key, purpose, count)`，purpose 分成 `reminder / evening / reply_fallback / system`。`/diag` 會顯示本月總數、各用途數量和最近 7 天的數字 |

---

## 其他一起修掉的問題

**卡住介入**（`buildStuckIntervention` / `buildBarrierPlan`）
- 截止前 24 小時，原本每次按「卡住」都會回同一則訊息，形成無限迴圈。現在第 1 次給「能交出去的版本」，第 2 次以上改問卡點，卡點建議裡會加上截止提醒。
- 例行任務的 `due_time` 只是下一次的發生時間，所以不再套用「截止前」策略。
- 卡到第 3 次會多一個「🌙 今天先放著」出口（`系統：明天再說`，隔天 9 點再提醒）。
- 延後提醒會記一筆 `snoozed` 事件，當作行為訊號保留下來。

**「還沒」的判斷更準**（`handleAiMessage`）
- **LINE 引用回覆**：push 和 reply 回傳的 `sentMessages[].id` 會存進 `bot_messages`。使用者長按提醒、選「回覆」之後打的字，可以用 `quotedMessageId` 直接對到任務；AI 判斷是卡住或完成、卻沒選出任務時，程式會直接用被引用的那個任務。
- **last_task 指標**：bot 發出跟某個任務有關的訊息（提醒、卡住介入）時，記下 `users.last_task_id`，30 分鐘內這個任務會被放進 prompt 的「對話線索」，當作最強的情境。
- 每次 AI 判斷都記一筆 `AI decision` log（intent、task_ids、候選數量、耗時），不記使用者原文。

**晚間回顧**（`processEveningCheckins`）
- 原本 `updated_at` 是 `YYYY-MM-DD HH:MM:SS`，卻拿去和 ISO 字串比較，結果台灣時間 00:00–07:59 完成的任務不算進當天。現在改用 `task_events` 的 completed 事件，時間格式也統一了，例行任務每次完成都會算進去。

**速度**
- schema 檢查從「每則訊息跑約 20 個查詢加上一次全表 UPDATE」改成「每個 isolate 只跑一次」（`ensureSchemaOnce`）。
- 文字訊息一收到就顯示 LINE「輸入中…」動畫（`startLoadingAnimation`，不佔訊息額度）。
- Gemini 總時限 20 秒，拿掉「JSON 模式失敗再用 plain 模式重來一次」。400 錯誤改成換下一個模型，401/403 才直接失敗。API key 改放在 `x-goog-api-key` header，不再放網址裡。
- prompt 去掉重複的規則（原本 15、22 各出現兩次），重新編號；靜態部分少了約 23%。待辦清單從 40 筆降到 20 筆，時間改用精簡的台灣時間格式。
- 選填 `GEMINI_THINKING_LEVEL` / `GEMINI_THINKING_BUDGET` 可以降低模型的思考量（值依模型而定，設錯會自動換下一個模型）。

**其他**
- `wrangler.toml` 加上 `max_concurrency = 1`（pilot 期間的保險絲）。
- AI 一次說完成多個任務時，全部都會處理（原本只處理第一個）。
- 刪除約 500 行沒在用的程式：舊的 regex 時間解析、`processLineEvents`、`listTasksText`、`setupRichMenu` 和壞掉的 PNG 等。

---

## 測試（`cloudflare/test/`，54 項全數通過）

用 Node 內建的 SQLite 模擬 D1（bind `undefined` 會跟真的 D1 一樣報錯），並攔截 LINE 和 Gemini 的 HTTP 呼叫，整個 Worker 從 webhook 跑到 cron 做端對端測試。在 UTC 和 America/New_York 兩種主機時區下都通過。

涵蓋：成功路徑、重複 webhook、Gemini 503 / 400 換模型、LINE push 500 → retry 只補送、409 視為成功、D1 失敗 → 改走 queue、queue retry 不重做 AI、兩個提醒同時、cron 重疊、claim 過期重新搶、「還沒」情境、引用回覆、模糊短句不猜、卡住狀態機、截止前不迴圈、first_step 進度、例行任務完成與第一次提醒、recurrence（1/31 加一個月、閏年、隔週、台北週日深夜但 UTC 還是週六、錯過多次、until）、沒有時區的 ISO、晚間回顧凌晨完成、22:30 與 22:31 不重複、push 失敗重試、pending 過期、舊按鈕、存檔前重新驗證、一句話兩個提醒、權限隔離（別人的 task id）、舊資料庫升級。

---

## PR #1 review 修正（GPT 驗收後）

| 分級 | 問題 | 修法（function） | 測試 |
|---|---|---|---|
| P0 | Inline Fast Path 先回 200 再用 `waitUntil` 處理；inline 和 fallback 進 Queue 都失敗時，事件會遺失 | `handleLineWebhook()` 改成回應前 `await Promise.allSettled(settleInline(...))`。`settleInline()`（取代原本的 `runInline`）必須確定「已處理完」或「已進 Queue」；兩者都失敗就 reject，webhook 回 **503** 讓 LINE 重送。處理超過 `INLINE_BUDGET_MS`（2.5 秒）也會先送進 Queue 當保險，原處理在背景繼續跑 | `[review P0] inline 失敗 + 進 Queue 也失敗 → webhook 回 5xx…`、`[review P0] inline 失敗但成功進 Queue…`、`[review P0] inline 成功 → 回 200 之前已經處理完並回覆`、`[review P0] inline 處理超過時間上限…` |
| P1 | `beginEvent()` 的 stale lease 接手是「先判斷、再 UPDATE」，兩個 worker 可能同時接手 | 改成單一條件式 `UPDATE … WHERE status='processing' AND 租約已過期 RETURNING event_id`，只有拿到 RETURNING 的 worker 能處理，其他的照「處理中」對待（queue 稍後重試、inline 略過） | `[review P1] 兩個 processor 同時接手同一個 stale event → 只有一個成功，副作用只執行一次`（3 個 processor 同時跑） |
| P1 | 引用回覆只在 AI 沒選任務時才使用；AI 選錯就會動到錯的任務 | `resolveQuotedTarget()` + `textMentionsTask()`：有引用時被引用的任務優先；AI 選了別的任務，只有使用者文字明確提到那個任務的名稱才保留。適用 `task_stuck / complete_task / delete_task / change_task_type`。結果記在 `AI decision` log 的 `quote_resolution` | `[review P1] 引用 B + AI 誤選 A + 使用者短句「還沒」→ 只會動到 B`、`[review P1] 引用 B 但文字明確提到 A → 允許改成 A`、`[review P1] 引用 B + AI 選 A 和 B，但只提到 B 的情境 → 只完成 B` |

另外：
- 修正一個跟執行時刻有關的測試（例行任務完成）：原本半夜跑會失敗，現在固定在台灣時間中午。
- 新增 `.github/workflows/worker-checks.yml`：PR 上會自動跑 `npm test` 與 `npm run check`（wrangler dry-run）。
- 新增 `cloudflare/.gitignore`。

---

## PR #2：webhook 取消安全（production E2E blocker）

**現象**：production log `POST /callback outcome: canceled wallTimeMs: 2274`。按「好呀🐽」、Rich Menu「查看所有任務」沒有立即回覆，任務中心有時延遲出現。

**原因**：PR #1 讓 webhook 在回應前等 inline 處理，等到 `INLINE_BUDGET_MS = 2500` 才改送 Queue；但 LINE 約 2.2 秒就斷線，fallback 來不及執行。inline 會慢有三個原因：(1) isolate 冷啟動時 schema 檢查要依序跑約 27 次 D1；(2) Rich Menu 初始化（產生 PNG、呼叫多支 LINE API）也在 webhook 裡跑；(3) 按鈕流程本身約 10 次 D1 往返。

**設計原則**：webhook 回應前只等「送進 Queue」這一步（通常幾十毫秒），不等任何 D1 或 LINE API；所有在 webhook 內的等待都要遠小於 LINE 斷線時間（約 2.2 秒）。

| 修改 | function |
|---|---|
| **先有耐久紀錄，再嘗試 inline**：每個決定性事件一進來就送一份延遲 5 秒（`FALLBACK_DELAY_SECONDS`）的 Queue 備份，接著立刻回 200，inline 移到 `waitUntil` 背景。inline 正常完成後，備份到期時看到事件已 `done` 就略過 | `handleLineWebhook()`、`enqueueMessages()`、`runInlineInBackground()` |
| Queue 不可用時才在 webhook 內等 inline，硬上限 **800ms**（`INLINE_BUDGET_MS`）；做不完或需要 AI 就回 503 讓 LINE 重送 | `settleInlineWithinBudget()` |
| 事件租約分 owner：inline 15 秒（`INLINE_LEASE_MS`）、queue 90 秒。inline 剛處理完、可能還在送 reply 時，Queue 先退避，避免 reply 加 push 雙送；inline 被砍掉時，Queue 15 秒後就能接手 | `beginEvent()`、新欄位 `webhook_events.owner` |
| Rich Menu 初始化移到 cron | `scheduled()` |
| schema 版本號：已是最新版的資料庫，冷啟動只查 1 次 | `runSchema()`、`SCHEMA_VERSION` |

**測試（新增 9 項，共 54 項）**：
- `[PR2 P0] D1 很慢（inline 要好幾秒）+ LINE 約 2 秒斷線 → 斷線前事件已安全進 Queue；副作用與回覆各一次`
- `[PR2 P0] inline 在背景被砍掉（送 reply 時永遠沒回來）→ Queue 備份接手，副作用與回覆各一次`
- `[PR2 P0] inline 在 processing 階段被砍（租約沒放掉）→ inline 租約到期後 Queue 接手`
- `[PR2 P0] Rich Menu postback「查看所有任務」：回應前已進 Queue，背景立刻回覆任務中心`
- `[PR2 P0] Queue 掛掉 + inline 很快 → 在硬上限內完成，回 200`
- `[PR2 P0] Queue 掛掉 + inline 很慢 → 硬上限（800ms）後回 503 讓 LINE 重送，不會拖到被斷線；重送後副作用仍只一次`
- `[PR2 P0] Queue 掛掉 + inline 也失敗 → 回 5xx，不能回 200`
- `[PR2 P0] Queue 掛掉時，需要 AI 的文字訊息 → 立刻回 503（不嘗試在 webhook 內呼叫 AI）`
- `[PR2] 舊資料庫已是最新 schema 版本時，冷啟動只查 1 次`

這些測試在目前的 `main` 上會失敗（其中 6 項是取消安全相關），在這個 PR 上全部通過。

**取捨**：每次按鈕會多一則 Queue 訊息（延遲備份）。pilot 規模的成本可以忽略。

---

## 還沒做（建議下一階段）

1. **同一使用者的訊息序列化**：目前用 `max_concurrency = 1` 頂著，使用者變多之後會變慢。可以改用 Durable Object（每個使用者一個），或在 D1 上做每個使用者的租約。
2. **AI 改回傳 date + time 欄位**，由程式組合時間（目前是補 `+08:00` 的短期解法）。
3. **拆檔**：`index.js` 已經按區塊整理，可以照區塊直接拆成 `line/`、`events/`、`ai/`、`tasks/`、`cron/`、`db/`、`ui/`。
4. **LINE 方案**：pilot 第一週看 `/diag` 的 `push_usage`，再決定要不要升級中用量（台灣輕用量每月 200 則免費）。
5. **兩段式 AI 呼叫**（先分類 intent，需要排程才帶完整 prompt），可以讓短句更快。
6. **心情資料保留政策**：pilot 前跟朋友說明會記錄什麼，並決定保留多久。
