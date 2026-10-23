# REVIEW.md — Code review 規則

Reviewer（人或 AI）審 PR 時依照這份規則。

## 優先順序
- **P0**：資料遺失、隱私外洩、重複副作用（重複推播、重複完成或刪除）、錯誤執行（動到別人的任務、不可逆操作沒有確認）、安全問題
- **P1**：reminder / recurrence / timezone 錯誤、race condition、retry 與冪等、重要的 UX 迴圈或卡死
- **P2**：效能、成本（LINE push 額度、Gemini token）、可維護性
- **P3**：文案、格式

## 每則意見要包含
- 哪個 function、哪幾行
- 具體的 failure scenario（什麼輸入或狀態 → 什麼錯誤結果）
- 建議的修法
- 修完怎麼驗證（最好指出要補哪個測試）

## 不要只給這類意見
命名、格式、「加註解」、「拆 function」、「改用 TypeScript」、「寫 unit test」，除非能指出具體的 bug 或 failure mode。

## 必查清單
- [ ] 產品原則（見 `CLAUDE.md`）沒有被破壞：自然語言交給 AI、Fast Path 只處理決定性操作、non-shaming
- [ ] AI 沒有在使用者沒要求時決定開始時間、時長、優先順序（`enforceAutonomy`）；打字的確認字只能確認 bot 上一輪正在請確認的方案
- [ ] 所有 SQL 都限定在 `line_user_id`；AI 給的 task id 有再驗證
- [ ] 時間計算有考慮台北時區、月底、隔週、UTC 日期與台北日期不同的時段
- [ ] 失敗、retry、cron 重疊時，不會掉事件也不會重複送
- [ ] 新增的 push 有決定性的 retry key 和 purpose
- [ ] webhook 回應前沒有新增 D1、LINE API 或 AI 的等待（LINE 約 2.2 秒斷線）
- [ ] `npm test` 全部通過，新行為有對應的測試
