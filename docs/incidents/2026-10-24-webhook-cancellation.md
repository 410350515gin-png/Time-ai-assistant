# Incident：LINE webhook 被取消，按鈕沒有回覆（2026-10-24）

| 項目 | 內容 |
|---|---|
| 分級 | P0（使用者操作沒有回應、事件可能遺失） |
| 影響期間 | 約 2026-10-24 00:07 至 02:03（台灣時間；PR #1 部署到 PR #2 部署） |
| 影響範圍 | 所有按鈕操作（Quick Reply、Rich Menu postback）。打字的訊息走 Queue，不受影響 |
| 使用者規模 | pilot 前的 E2E 測試期間，只有開發者本人受影響 |
| 修正 | PR #2（`1a64df4`） |

## 一句話摘要
Webhook 在回應 LINE 之前，等待 inline 處理的上限是 2.5 秒，但 LINE 大約 2.2 秒就會斷線。所以處理一變慢，request 就在備援機制啟動前被取消，使用者按了按鈕卻什麼都沒收到。

## 現象
- Cloudflare production log：`POST /callback`，`outcome: canceled`，`wallTimeMs: 2274`
- 使用者按 Quick Reply「好呀🐽」確認方案，沒有回覆
- Rich Menu「查看所有任務」沒有立即回覆，任務中心有時延遲才出現
- AI 建立待確認方案的流程正常（走 Queue）

## 時間軸（台灣時間）
| 時間 | 事件 |
|---|---|
| 00:07 | PR #1 merge，Cloudflare Workers Builds 自動部署 |
| 約 01:50 | 正式 LINE E2E 測試發現按鈕沒有回覆，從 production log 找到 `canceled` |
| 01:57 | 開 PR #2 |
| 02:02 | PR #2 merge |
| 02:03 | `main` 的 Workers Build 成功（自動部署） |

## Root cause
**直接原因：等待時間的設計上限，比上游平台的實際上限還長。**
PR #1 為了確保「webhook 回 200 之前，事件一定已經處理完或已經進 Queue」，讓 webhook 先在 request 內等 inline 處理，超過 `INLINE_BUDGET_MS = 2500` 才改送 Queue。但 LINE 大約 2.2 秒就斷線（目前只有這一次的觀察值），所以真正慢的時候，改送 Queue 那一步根本來不及執行。

**為什麼 inline 會超過 2 秒（推論，沒有逐項量測）：**
1. **冷啟動的 schema 檢查**：新的 isolate 第一次處理事件時，要依序執行約 27 個 D1 statement，每個都是一次網路往返。
2. **Rich Menu 初始化放在 webhook 裡**：第一次部署 v2 選單時，要產生 2500×843 的 PNG（吃 CPU），再呼叫好幾支 LINE API，跟 inline 處理同時進行。
3. **按鈕流程本身約 10 次 D1 往返**：如果 D1 跟 Worker 不在同一個地區，每次往返都會變慢。

PR #1 部署後第一次被呼叫，剛好同時碰上 1 和 2。

**為什麼測試沒有抓到：** PR #1 的測試用的是本機 SQLite，D1 延遲是 0，也沒有模擬「request 被平台取消」。測試證明了邏輯正確，卻沒有涵蓋時間上的限制。

## 修正（PR #2）
設計原則改成：**webhook 回應之前，只等「送進 Queue」這一步**（通常幾十毫秒），不等任何 D1 查詢、LINE API 或 AI。

1. **先寫進 Queue，再嘗試處理**：每個按鈕事件一進來，先送一份延遲 5 秒的 Queue 備份，然後立刻回 200；inline 處理移到背景（`waitUntil`）。inline 成功的話，備份到期時看到事件已經完成就直接略過（`webhook_events` 冪等）。
2. **Queue 掛掉時的退路**：只有 Queue 不可用時，才在 request 內等 inline，而且硬上限是 800ms，遠低於 2.2 秒；超過就回 503，讓 LINE 重送。
3. **租約分擁有者**：inline 的租約 15 秒、Queue 的租約 90 秒。inline 被砍掉時，Queue 15 秒後就能接手；inline 剛處理完、可能還在送 reply 時，Queue 先退避，避免同一則回覆用 reply 和 push 各送一次。
4. **把慢的工作移出 webhook**：Rich Menu 初始化移到 cron；schema 加上版本號，已經是最新版的資料庫冷啟動只要查 1 次。

另外沒有採用「只把 2500 改成 2000」這種調參數的做法：webhook 路徑上的任何等待，仍然取決於 D1 和網路的延遲，只要上游斷線時間有變動就會再出事。

## 驗證
- 新增 9 項回歸測試，模擬每次 D1 往返 400ms、LINE 2 秒斷線、inline 在送回覆時被砍、Queue 掛掉等情況，並確認副作用與 LINE 回覆都各只發生一次。
- **測試抓得到這個 bug**：把新測試放到修正前的 `main` 上跑，6 項跟取消安全有關的會失敗（核心案例：webhook 超過 2 秒被斷線），修正後全部 54 項通過。
- CI（GitHub Actions）：`npm test` 和 `npm run check`（wrangler dry-run）都通過。
- Production 驗收：見 [`../e2e-acceptance.md`](../e2e-acceptance.md)。

## 學到的事
1. **超時預算要從最嚴格的上游往回推。** LINE 的斷線時間就是 webhook 的實際上限，自己設的所有等待都要遠小於它，而且要留給「最慢的情況」，不是平均情況。
2. **先寫一份耐久紀錄，再嘗試快速路徑。** 順序反過來（先試、失敗才寫）的話，「失敗才寫」這一步本身就可能來不及。
3. **冪等讓「多送一份」變得安全。** 因為有 `webhook_events` 的狀態機，同一個事件同時有 inline 和 Queue 兩份，也不會重複執行副作用。PR #1 打下的這個基礎，讓 PR #2 可以用很小的改動解決問題。
4. **測試要模擬時間和取消，不只模擬邏輯。** 在測試的 D1 裡加上延遲，並模擬「request 在 N 秒後被取消」，是這次補上的測試能力。
5. **初始化工作不要放在使用者等待的路徑上。** 例如 Rich Menu 初始化和 schema 檢查。
6. **把規則寫進協作文件。** 這條原則已經加進 `CLAUDE.md` 和 `REVIEW.md`，之後不論是哪個 AI 或人改程式，都會在 review 時被檢查到。

## 作品集版（3 句話）
> 一個 LINE 任務助理在正式環境測試時，使用者按按鈕卻沒有回應。我從 Cloudflare log 找到 request 在 2.27 秒被取消，原因是 webhook 等待處理的上限（2.5 秒）超過了 LINE 實際的斷線時間（約 2.2 秒）。修正方式是改成「先把事件寫進 Queue、再在背景快速處理」，並靠既有的冪等狀態機避免重複執行，同時補上模擬 D1 延遲和 request 取消的回歸測試，並確認這些測試在修正前的版本上確實會失敗。
