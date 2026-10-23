// 端對端與單元測試。執行：cd cloudflare && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, tpe, loadPureFunctions } from "./harness.mjs";

const HOUR = 3600000;
const reminderPlan = (title, remind_at, extra = {}) => ({
  intent: "create_reminder",
  reply: "",
  plan_items: [{ title, first_step: title, remind_at, task_type: "daily", ...extra }]
});

/* ============================== 安全 ============================== */

test("診斷與管理端點沒帶 ADMIN_TOKEN 一律 404；帶了也不回任務標題", async () => {
  const h = await setup();
  h.insertTask({ title: "秘密任務", remind_at: new Date(Date.now() + HOUR).toISOString() });
  for (const [m, p] of [["GET", "/diag"], ["GET", "/diag/reminders"], ["POST", "/admin/setup-rich-menu"]]) {
    assert.equal((await h.request(m, p)).status, 404, p);
    assert.equal((await h.request(m, p, { headers: { authorization: "Bearer wrong" } })).status, 404, p);
  }
  const res = await h.request("GET", "/diag/reminders", { headers: { authorization: "Bearer admin-token" } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes("秘密任務"));
  assert.match(body, /"pending_with_reminder":1/);
});

test("簽章錯誤的 webhook 回 400", async () => {
  const h = await setup();
  const res = await h.request("POST", "/webhook", { headers: { "x-line-signature": "bad" }, body: "{}" });
  assert.equal(res.status, 400);
});

/* ============================== 成功路徑 ============================== */

test("成功路徑：自然語言提醒 → 待確認 → 按鈕確認 → 存入；AI 沒給時區的時間視為台灣時間", async () => {
  const h = await setup();
  const tomorrow = new Date(Date.now() + 24 * HOUR);
  const local = new Date(tomorrow.getTime() + 8 * HOUR);
  const ymd = local.toISOString().slice(0, 10);
  h.net.gemini = () => reminderPlan("拿包裹", `${ymd}T15:00:00`); // 沒有 +08:00

  await h.webhook([h.textEvent("明天下午三點提醒我拿包裹")]);
  assert.equal(h.queue.length, 1, "文字訊息進 queue");
  assert.ok(h.net.calls.some(c => c.path === "/v2/bot/chat/loading/start"), "有顯示輸入中動畫");
  await h.drainQueue();

  assert.equal(h.net.replies().length, 1, "用免費的 reply");
  assert.equal(h.net.pushes().length, 0);
  assert.match(h.net.lastText(), /15:00/);

  const confirm = h.net.lastMessage().quickReply.items[0].action;
  assert.equal(confirm.type, "postback");
  assert.match(confirm.data, /^系統：確認方案:/);

  await h.webhook([h.postbackEvent(confirm.data)]);
  assert.equal(h.queue.length, 0, "按鈕不經過 queue");
  assert.match(h.net.lastText(), /存好 1 項/);

  const task = h.db.row("SELECT * FROM tasks");
  assert.equal(task.remind_at, `${ymd}T07:00:00.000Z`, "15:00 台灣 = 07:00Z");
  assert.equal(h.net.geminiCalls.length, 1);
});

test("Gemini 用 header 傳金鑰，不放在網址", async () => {
  const h = await setup();
  await h.say("你好");
  const g = h.net.calls.find(c => c.host.includes("generativelanguage"));
  assert.equal(g.headers["x-goog-api-key"], "gkey");
});

/* ============================== 冪等 / Queue ============================== */

test("重複的 webhook 事件只處理一次", async () => {
  const h = await setup();
  const ev = h.textEvent("你好");
  await h.webhook([ev]);
  await h.webhook([ev]);
  await h.drainQueue();
  assert.equal(h.net.geminiCalls.length, 1);
  assert.equal(h.net.outgoing().length, 1);
});

test("LINE push 500 → queue retry 只補送回覆，不重做 AI 與副作用", async () => {
  const h = await setup();
  h.net.gemini = () => reminderPlan("倒垃圾", new Date(Date.now() + 2 * HOUR).toISOString());
  // reply token 已過期（事件是 2 分鐘前），只能 push；第一次 push 失敗
  h.net.pushFailures = [500];
  await h.webhook([h.textEvent("兩小時後提醒我倒垃圾", { timestamp: Date.now() - 120000, eventId: "evt-push-fail" })]);
  const r1 = await h.drainQueue();
  assert.equal(r1.retried, 1);
  assert.equal(h.db.row("SELECT status FROM webhook_events WHERE event_id='evt-push-fail'").status, "handled");

  const r2 = await h.drainQueue();
  assert.equal(r2.acked, 1);
  assert.equal(h.net.geminiCalls.length, 1, "AI 只呼叫一次");
  assert.equal(h.db.row("SELECT status FROM webhook_events WHERE event_id='evt-push-fail'").status, "done");
  const pushes = h.net.pushes();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].headers["x-line-retry-key"], pushes[1].headers["x-line-retry-key"], "同一個事件用同一個 retry key");
  assert.match(h.net.lastText(), /倒垃圾/);
});

test("push 回 409（retry key 已被接受）視為成功", async () => {
  const h = await setup();
  await h.webhook([h.textEvent("你好", { timestamp: Date.now() - 120000, eventId: "evt-409" })]);
  await h.drainQueue();
  // 模擬：LINE 收到了但我們沒收到回應 → 事件又被重跑
  h.db.exec("UPDATE webhook_events SET status='handled', reply_json='\"好喔🐽\"' WHERE event_id='evt-409'");
  h.queue.push({ type: "LINE_EVENT", event: h.textEvent("你好", { timestamp: Date.now() - 120000, eventId: "evt-409" }) });
  const r = await h.drainQueue();
  assert.equal(r.acked, 1);
  assert.equal(h.net.pushes().length, 2);
  assert.equal(h.db.row("SELECT status FROM webhook_events WHERE event_id='evt-409'").status, "done");
});

test("D1 在 inline 處理時失敗 → 自動改走 queue，任務仍然存進去", async () => {
  const h = await setup();
  h.net.gemini = () => reminderPlan("繳費", new Date(Date.now() + 3 * HOUR).toISOString());
  await h.say("三小時後提醒我繳費");
  const data = h.net.lastMessage().quickReply.items[0].action.data;

  h.db.failNext(/INSERT INTO tasks/);
  await h.webhook([h.postbackEvent(data)]);
  assert.equal(h.queue.length, 1, "inline 失敗後送進 queue");
  await h.drainQueue();
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 1);
  assert.match(h.net.lastText(), /存好 1 項/);
});

test("Gemini 全部 503 → 誠實回覆，不建立任何方案", async () => {
  const h = await setup();
  h.net.geminiStatus = [503, 503, 503, 503];
  const text = await h.say("都刪掉");
  assert.match(text, /先不動你的任務/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM pending_plans").n, 0);
});

test("Gemini 第一個模型 400 → 換下一個模型", async () => {
  const h = await setup();
  h.net.geminiStatus = [400];
  await h.say("你好");
  assert.deepEqual(h.net.geminiCalls.map(c => c.model), ["model-a", "model-b"]);
  assert.equal(h.net.lastText(), "好喔🐽");
});

/* ============================== 待確認方案 ============================== */

test("待確認方案過期後，一句「好」不會執行刪除", async () => {
  const h = await setup();
  h.insertTask({ title: "A" });
  h.net.gemini = t => (t === "都刪掉" ? { intent: "delete_all_tasks", reply: "" } : { intent: "chat", reply: "嗯嗯" });
  await h.say("都刪掉");
  h.db.exec("UPDATE pending_plans SET updated_at=datetime('now','-31 minutes')");

  await h.webhook([h.textEvent("好")]);
  assert.equal(h.queue.length, 1, "過期 → 當一般對話交給 AI");
  const r = await h.drainQueue();
  assert.equal(r.acked, 1, "queue 不用等租約過期就能接手");
  assert.equal(h.net.lastText(), "嗯嗯");
  assert.equal(h.db.row("SELECT status FROM tasks").status, "pending");
});

test("舊方案的按鈕不能確認新方案", async () => {
  const h = await setup();
  h.net.gemini = () => reminderPlan("A", new Date(Date.now() + HOUR).toISOString());
  await h.say("一小時後提醒我A");
  const oldData = h.net.lastMessage().quickReply.items[0].action.data;
  h.net.gemini = () => reminderPlan("B", new Date(Date.now() + HOUR).toISOString());
  await h.say("一小時後提醒我B");
  const text = await h.tap(oldData);
  assert.match(text, /過期/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 0);
});

test("確認時重新驗證時間：已經過去的提醒不會存成立刻響", async () => {
  const h = await setup();
  h.net.gemini = () => reminderPlan("喝水", new Date(Date.now() + HOUR).toISOString());
  await h.say("一小時後提醒我喝水");
  const data = h.net.lastMessage().quickReply.items[0].action.data;
  const plan = JSON.parse(h.db.row("SELECT plan_json FROM pending_plans").plan_json);
  plan.plan_items[0].remind_at = new Date(Date.now() - 60000).toISOString();
  h.db.exec("UPDATE pending_plans SET plan_json=?", JSON.stringify(plan));
  const text = await h.tap(data);
  assert.match(text, /提醒時間已經過了/);
  assert.equal(h.db.row("SELECT remind_at FROM tasks").remind_at, null);
});

test("一句話兩個相對時間提醒 → 各自的時間", async () => {
  const h = await setup();
  h.net.gemini = () => ({
    intent: "create_reminder",
    reply: "",
    time_semantics: { kind: "relative", amount: 10, unit: "minute" },
    plan_items: [
      { title: "關火", first_step: "關火", time_semantics: { kind: "relative", amount: 10, unit: "minute" } },
      { title: "收衣服", first_step: "收衣服", time_semantics: { kind: "relative", amount: 1, unit: "hour" } }
    ]
  });
  await h.say("10分鐘後提醒我關火，一小時後提醒我收衣服");
  const plan = JSON.parse(h.db.row("SELECT plan_json FROM pending_plans").plan_json);
  const [a, b] = plan.plan_items.map(x => new Date(x.remind_at).getTime() - Date.now());
  assert.ok(Math.abs(a - 10 * 60000) < 5000, "關火 10 分鐘");
  assert.ok(Math.abs(b - HOUR) < 5000, "收衣服 1 小時");
});

/* ============================== 提醒 / cron ============================== */

test("同時兩個提醒 → 各推一次、retry key 不同；cron 重疊也不會重複推", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  h.insertTask({ title: "A", remind_at: at });
  h.insertTask({ title: "B", remind_at: at });
  await Promise.all([h.cron(), h.cron()]);
  const pushes = h.net.pushes();
  assert.equal(pushes.length, 2);
  assert.notEqual(pushes[0].headers["x-line-retry-key"], pushes[1].headers["x-line-retry-key"]);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE reminder_sent_at IS NOT NULL").n, 2);
  await h.cron();
  assert.equal(h.net.pushes().length, 2, "下一分鐘不會再推");
});

test("提醒 push 500 → 放掉 claim，下一分鐘用同一個 retry key 重試", async () => {
  const h = await setup();
  h.insertTask({ title: "A", remind_at: new Date(Date.now() - 1000).toISOString() });
  h.net.pushFailures = [500];
  await h.cron();
  assert.equal(h.db.row("SELECT reminder_sent_at FROM tasks").reminder_sent_at, null);
  await h.cron();
  const pushes = h.net.pushes();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].headers["x-line-retry-key"], pushes[1].headers["x-line-retry-key"]);
  assert.ok(h.db.row("SELECT reminder_sent_at FROM tasks").reminder_sent_at);
});

test("worker 送到一半被砍（claim 卡住超過 5 分鐘）→ 重新 claim；LINE 回 409 視為已送", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 600000).toISOString();
  const id = h.insertTask({ title: "A", remind_at: at });
  h.db.exec("UPDATE tasks SET reminder_claimed_at=datetime('now','-10 minutes') WHERE id=?", id);
  await h.cron(); // 第一次送出（LINE 記住了 retry key）
  const key = h.net.pushes()[0].headers["x-line-retry-key"];
  h.db.exec("UPDATE tasks SET reminder_sent_at=NULL, reminder_claimed_at=datetime('now','-10 minutes') WHERE id=?", id);
  await h.cron();
  assert.equal(h.net.pushes()[1].headers["x-line-retry-key"], key);
  assert.ok(h.db.row("SELECT reminder_sent_at FROM tasks").reminder_sent_at, "409 也標成已送");
  assert.equal(h.db.row("SELECT count FROM push_usage WHERE purpose='reminder'").count, 1, "409 不重複計費");
});

test("claim 還沒過期時不會被別的 cron 搶走", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "A", remind_at: new Date(Date.now() - 1000).toISOString() });
  h.db.exec("UPDATE tasks SET reminder_claimed_at=CURRENT_TIMESTAMP WHERE id=?", id);
  await h.cron();
  assert.equal(h.net.pushes().length, 0);
});

/* ============================== 「還沒」與引用回覆 ============================== */

test("「還沒」：最近提醒 + 剛剛的任務會進 AI 情境，AI 選出 id 後進入卡住介入", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "煮泡麵", first_step: "把水壺裝水", remind_at: new Date(Date.now() - 1000).toISOString() });
  await h.cron();
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /最近 6 小時提醒過的任務/);
    assert.match(prompt, /剛剛的對話正在談任務 id=\d+「煮泡麵」/);
    return { intent: "task_stuck", reply: "", task_ids: [id] };
  };
  const text = await h.say("還沒");
  assert.match(text, /把水壺裝水/);
  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", id).stuck_count, 1);
});

test("兩個提醒同時響、使用者用 LINE「回覆」引用其中一則 → 決定性對到那個任務", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  const a = h.insertTask({ title: "A任務", remind_at: at });
  const b = h.insertTask({ title: "B任務", remind_at: at });
  await h.cron();
  const msgOfB = h.db.row("SELECT message_id FROM bot_messages WHERE task_id=?", b).message_id;
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /引用回覆.*B任務/);
    return { intent: "task_stuck", reply: "", task_ids: [] }; // AI 不確定是哪個
  };
  await h.say("還沒", { quotedMessageId: msgOfB });
  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", b).stuck_count, 1);
  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", a).stuck_count, 0);
});

test("模糊短句、沒有可指向的任務 → AI 留空時程式不猜", async () => {
  const h = await setup();
  h.insertTask({ title: "A" });
  h.insertTask({ title: "B" });
  h.net.gemini = (t, prompt) => {
    assert.doesNotMatch(prompt, /對話線索：\n/);
    return { intent: "task_stuck", reply: "", task_ids: [] };
  };
  const text = await h.say("還不行");
  assert.match(text, /不敢猜/);
  assert.equal(h.db.row("SELECT SUM(stuck_count) AS n FROM tasks").n, 0);
});

/* ============================== 卡住介入 ============================== */

test("卡住流程：第 1 次降門檻 → 第 2 次問卡點 → 第 3 次多一個「今天先放著」出口", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "寫報告", first_step: "開檔案寫標題" });
  assert.match(await h.tap(`系統：卡住任務:${id}`), /門檻/);
  assert.match(await h.tap(`系統：卡住任務:${id}`), /卡點/);
  await h.tap(`系統：卡住任務:${id}`);
  const labels = h.net.lastMessage().quickReply.items.map(i => i.action.label);
  assert.ok(labels.includes("🌙 今天先放著"));
  const text = await h.tap(`系統：明天再說:${id}`);
  assert.match(text, /明天早上 9 點/);
  const remind = new Date(h.db.row("SELECT remind_at FROM tasks WHERE id=?", id).remind_at);
  assert.equal((remind.getUTCHours() + 8) % 24, 9);
});

test("截止前 24 小時：第 2 次卡住會進到問卡點，不再無限重複同一則", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "交報告", due_time: new Date(Date.now() + 5 * HOUR).toISOString() });
  assert.match(await h.tap(`系統：卡住任務:${id}`), /能交出去/);
  assert.match(await h.tap(`系統：卡住任務:${id}`), /卡點/);
  assert.match(await h.tap(`系統：障礙:${id}:time`), /不到一天/);
});

test("例行任務卡住不套用截止前策略", async () => {
  const h = await setup();
  const id = h.insertTask({
    title: "運動", task_type: "routine",
    recurrence_json: JSON.stringify({ freq: "daily", interval: 1, time: "20:00" }),
    due_time: new Date(Date.now() + 3 * HOUR).toISOString()
  });
  assert.doesNotMatch(await h.tap(`系統：卡住任務:${id}`), /能交出去/);
});

test("做完 5 分鐘的 first_step ≠ 整個任務完成；之後再按整件做完才完成", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "寫報告", task_type: "goal" });
  await h.tap(`系統：卡住任務:${id}`);
  await h.tap(`系統：先做五分鐘:${id}`);
  const stepBtn = h.net.lastMessage().quickReply.items[0].action.data;
  assert.equal(stepBtn, `系統：步驟完成:${id}`);
  await h.tap(stepBtn);
  let t = h.db.row("SELECT status, stuck_count FROM tasks WHERE id=?", id);
  assert.equal(t.status, "pending");
  assert.equal(t.stuck_count, 0);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM task_events WHERE event_type='step_done'").n, 1);
  await h.tap(`系統：完成任務:${id}`);
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", id).status, "completed");
});

/* ============================== 例行任務 ============================== */

test("例行任務按完成 → 不會結束；今天的提醒還沒響就跳到下一次", async () => {
  const h = await setup();
  const now = Date.now();
  const local = new Date(now + 8 * HOUR);
  // 今天稍晚的提醒（若已接近午夜則改用 1 分鐘後，仍在今天）
  const later = Math.min(now + 2 * HOUR, Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 58) - 8 * HOUR);
  const hhmm = new Date(later + 8 * HOUR).toISOString().slice(11, 16);
  const id = h.insertTask({
    title: "吃藥", task_type: "routine",
    recurrence_json: JSON.stringify({ freq: "daily", interval: 1, time: hhmm }),
    remind_at: new Date(later).toISOString().replace(/:\d\d\.\d+Z$/, ":00.000Z")
  });
  const text = await h.tap(`系統：完成任務:${id}`);
  assert.match(text, /下次/);
  const t = h.db.row("SELECT status, remind_at FROM tasks WHERE id=?", id);
  assert.equal(t.status, "pending");
  assert.ok(new Date(t.remind_at).getTime() > later + 20 * HOUR, "跳到明天");
  // 連點不會記兩次
  await h.tap(`系統：完成任務:${id}`);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM task_events WHERE event_type='completed'").n, 1);
});

test("例行任務沒給 remind_at → 程式依 recurrence 算出第一次提醒", async () => {
  const h = await setup();
  h.net.gemini = () => ({
    intent: "propose_plan", reply: "",
    plan_items: [{ title: "健身", first_step: "換運動服", task_type: "daily", recurrence: { freq: "weekly", interval: 1, weekdays: [1, 3, 5], time: "19:00" } }]
  });
  await h.say("每週一三五晚上七點健身");
  await h.tap(h.net.lastMessage().quickReply.items[0].action.data);
  const t = h.db.row("SELECT remind_at, task_type, due_time FROM tasks");
  assert.equal(t.task_type, "routine", "有 recurrence 一律 routine");
  assert.ok(t.remind_at, "有第一次提醒");
  const local = new Date(new Date(t.remind_at).getTime() + 8 * HOUR);
  assert.ok([1, 3, 5].includes(local.getUTCDay()));
  assert.equal(local.toISOString().slice(11, 16), "19:00");
  assert.equal(t.due_time, null);
});

test("例行提醒送出後排下一次", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  const hhmm = new Date(Date.parse(at) + 8 * HOUR).toISOString().slice(11, 16);
  const id = h.insertTask({ title: "喝水", recurrence_json: JSON.stringify({ freq: "daily", interval: 1, time: hhmm }), remind_at: at });
  await h.cron();
  const t = h.db.row("SELECT remind_at, reminder_sent_at, status FROM tasks WHERE id=?", id);
  assert.equal(t.status, "pending");
  assert.equal(t.reminder_sent_at, null);
  assert.ok(new Date(t.remind_at).getTime() > Date.now() + 23 * HOUR);
});

test("computeNextOccurrence：月底、閏年、隔週、台北週日深夜、錯過多次、until", async () => {
  const f = await loadPureFunctions(["pad2", "tpeLocal", "tpeToMs", "computeNextOccurrence"]);
  const next = (cur, r, now = Date.parse(cur), incl = false) => f.computeNextOccurrence(cur, { interval: 1, weekdays: [], ...r }, now, incl);

  // 1/31 + 1 個月 → 2/28（不是 3/3 或 3/31）
  assert.equal(next(tpe(2027, 1, 31, 9), { freq: "monthly", day_of_month: 31, time: "09:00" }), tpe(2027, 2, 28, 9));
  assert.equal(next(tpe(2027, 2, 28, 9), { freq: "monthly", day_of_month: 31, time: "09:00" }), tpe(2027, 3, 31, 9), "下個月回到 31 號");
  assert.equal(next(tpe(2028, 1, 31, 9), { freq: "monthly", day_of_month: 31, time: "09:00" }), tpe(2028, 2, 29, 9), "閏年");
  // 月底 + 早上 7 點（UTC 還是前一天）
  assert.equal(next(tpe(2027, 1, 31, 7), { freq: "monthly", day_of_month: 31, time: "07:00" }), tpe(2027, 2, 28, 7));
  // 每 3 個月
  assert.equal(next(tpe(2026, 11, 15, 9), { freq: "monthly", interval: 3, day_of_month: 15, time: "09:00" }), tpe(2027, 2, 15, 9));

  // 隔週一：2026-10-26 是週一 → 11/9，不是 11/2
  assert.equal(next(tpe(2026, 10, 26, 9), { freq: "weekly", interval: 2, weekdays: [1], time: "09:00" }), tpe(2026, 11, 9, 9));
  // 隔週一三：週一 → 同週週三 → 再跳兩週後的週一
  assert.equal(next(tpe(2026, 10, 26, 9), { freq: "weekly", interval: 2, weekdays: [1, 3], time: "09:00" }), tpe(2026, 10, 28, 9));
  assert.equal(next(tpe(2026, 10, 28, 9), { freq: "weekly", interval: 2, weekdays: [1, 3], time: "09:00" }), tpe(2026, 11, 9, 9));

  // 台北週日 07:00（UTC 還是週六）每週、沒指定星期 → 下週日，不是週六
  const sun = tpe(2026, 11, 1, 7);
  assert.equal(new Date(sun).getUTCDay(), 6, "前提：UTC 是週六");
  assert.equal(next(sun, { freq: "weekly", time: "07:00" }), tpe(2026, 11, 8, 7));
  // 台北週日深夜 23:30（UTC 週日 15:30）
  assert.equal(next(tpe(2026, 11, 1, 23, 30), { freq: "weekly", weekdays: [0], time: "23:30" }), tpe(2026, 11, 8, 23, 30));

  // 錯過很多次 → 直接跳到未來，不會每分鐘補發
  const now = Date.parse(tpe(2026, 10, 23, 12));
  assert.equal(next(tpe(2026, 10, 20, 9), { freq: "daily", time: "09:00" }, now), tpe(2026, 10, 24, 9));
  // 每 2 天保持相位
  assert.equal(next(tpe(2026, 10, 20, 9), { freq: "daily", interval: 2, time: "09:00" }, now), tpe(2026, 10, 24, 9));

  // until
  assert.equal(next(tpe(2026, 10, 26, 9), { freq: "daily", time: "09:00", until: tpe(2026, 10, 26, 23) }), null);

  // 第一次（含錨點當天）
  assert.equal(next(tpe(2026, 10, 23, 8), { freq: "daily", time: "09:00" }, Date.parse(tpe(2026, 10, 23, 8)), true), tpe(2026, 10, 23, 9));
});

test("normalizeIso：沒有時區的字串一律視為台灣時間", async () => {
  const f = await loadPureFunctions(["normalizeIso"]);
  assert.equal(f.normalizeIso("2026-10-24T15:00:00"), "2026-10-24T07:00:00.000Z");
  assert.equal(f.normalizeIso("2026-10-24 15:00"), "2026-10-24T07:00:00.000Z");
  assert.equal(f.normalizeIso("2026-10-24T15:00:00+08:00"), "2026-10-24T07:00:00.000Z");
  assert.equal(f.normalizeIso("2026-10-24T07:00:00Z"), "2026-10-24T07:00:00.000Z");
  assert.equal(f.normalizeIso("2026-10-24"), "2026-10-23T16:00:00.000Z");
  assert.equal(f.normalizeIso("不是時間"), null);
});

/* ============================== 晚間回顧 ============================== */

test("晚間回顧：凌晨完成的也算進今天；22:30 與 22:31 只送一次；用量有記錄", async () => {
  const h = await setup();
  h.db.exec("INSERT INTO users(line_user_id) VALUES ('U1')");
  const id = h.insertTask({ title: "早起跑步", status: "completed" });
  const now = Date.now();
  const l = new Date(now + 8 * HOUR);
  const y = l.getUTCFullYear(), m = l.getUTCMonth() + 1, d = l.getUTCDate();
  // 今天台灣 01:30 完成
  const at = new Date(Date.parse(tpe(y, m, d, 1, 30))).toISOString().slice(0, 19).replace("T", " ");
  h.db.exec("INSERT INTO task_events(task_id,line_user_id,event_type,created_at) VALUES (?,?, 'completed', ?)", id, "U1", at);

  await h.cron(Date.parse(tpe(y, m, d, 22, 30)));
  await h.cron(Date.parse(tpe(y, m, d, 22, 31)));
  const pushes = h.net.pushes();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body.messages[0].text, /早起跑步/);
  assert.equal(h.db.row("SELECT count FROM push_usage WHERE purpose='evening'").count, 1);
});

test("晚間回顧 push 失敗 → 下一分鐘重試（同一個 retry key）；22:40 之後不再送", async () => {
  const h = await setup();
  h.db.exec("INSERT INTO users(line_user_id) VALUES ('U1')");
  const l = new Date(Date.now() + 8 * HOUR);
  const y = l.getUTCFullYear(), m = l.getUTCMonth() + 1, d = l.getUTCDate();
  h.net.pushFailures = [500];
  await h.cron(Date.parse(tpe(y, m, d, 22, 30)));
  await h.cron(Date.parse(tpe(y, m, d, 22, 31)));
  const pushes = h.net.pushes();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].headers["x-line-retry-key"], pushes[1].headers["x-line-retry-key"]);
  assert.ok(h.db.row("SELECT sent_at FROM daily_checkins").sent_at);
  await h.cron(Date.parse(tpe(y, m, d, 22, 45)));
  assert.equal(h.net.pushes().length, 2);
});

test("晚間心情按鈕會記錄", async () => {
  const h = await setup();
  await h.tap("系統：晚間心情:2026-10-23:tired");
  assert.equal(h.db.row("SELECT mood FROM daily_checkins").mood, "tired");
});

/* ============================== 其他 ============================== */

test("舊版 Rich Menu 送來的「系統：任務首頁」也能直接開任務中心，不經過 AI", async () => {
  const h = await setup();
  await h.webhook([h.textEvent("系統：任務首頁")]);
  assert.equal(h.queue.length, 0);
  assert.equal(h.net.geminiCalls.length, 0);
  assert.equal(h.net.lastMessage().type, "flex");
});

test("新的 Rich Menu 使用 postback 並存成 v2 設定", async () => {
  const h = await setup();
  await h.webhook([h.textEvent("系統：列出任務")]);
  const create = h.net.calls.find(c => c.path === "/v2/bot/richmenu");
  assert.equal(create.body.areas[0].action.type, "postback");
  assert.equal(create.body.areas[0].action.data, "系統：列出任務");
  assert.equal(h.db.row("SELECT value FROM app_settings WHERE key='default_rich_menu_id_v2'").value, "richmenu-test");
});

test("AI 判斷完成多個任務", async () => {
  const h = await setup();
  const a = h.insertTask({ title: "洗碗" });
  const b = h.insertTask({ title: "倒垃圾" });
  h.net.gemini = () => ({ intent: "complete_task", reply: "", task_ids: [a, b] });
  const text = await h.say("洗碗跟倒垃圾都做完了");
  assert.match(text, /洗碗/);
  assert.match(text, /倒垃圾/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE status='completed'").n, 2);
});

test("AI 給了不屬於這個使用者的 task id → 不會動到別人的任務", async () => {
  const h = await setup();
  const other = h.insertTask({ title: "別人的", line_user_id: "U2" });
  h.net.gemini = () => ({ intent: "complete_task", reply: "", task_ids: [other] });
  await h.say("做完了");
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", other).status, "pending");
});

test("reply token 過期 → 改用 push，並記成 reply_fallback 用量", async () => {
  const h = await setup();
  await h.say("你好", { timestamp: Date.now() - 120000 });
  assert.equal(h.net.replies().length, 0);
  assert.equal(h.net.pushes().length, 1);
  assert.equal(h.db.row("SELECT count FROM push_usage WHERE purpose='reply_fallback'").count, 1);
});

test("/diag 回報本月 push 用量", async () => {
  const h = await setup();
  h.insertTask({ title: "A", remind_at: new Date(Date.now() - 1000).toISOString() });
  await h.cron();
  const res = await h.request("GET", "/diag", { headers: { authorization: "Bearer admin-token" } });
  const body = await res.json();
  assert.equal(body.push_usage.by_purpose.reminder, 1);
  assert.equal(body.push_usage.this_month_total, 1);
});

test("follow 事件送歡迎訊息（用 reply）", async () => {
  const h = await setup();
  await h.webhook([{ type: "follow", webhookEventId: "f1", replyToken: "rt-f", timestamp: Date.now(), source: { type: "user", userId: "U9" } }]);
  assert.equal(h.net.replies().length, 1);
  assert.match(h.net.lastText(), /豬豬行程小秘書/);
});

test("既有舊資料庫（舊 schema）可以直接升級", async () => {
  const { FakeD1, loadWorker } = await import("./harness.mjs");
  const db = new FakeD1();
  db.db.exec(`
    CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (line_user_id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, line_user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      first_step TEXT, priority INTEGER NOT NULL DEFAULT 3, start_time TEXT, due_time TEXT, remind_at TEXT, estimated_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, updated_at TEXT);
    CREATE TABLE daily_checkins (line_user_id TEXT NOT NULL, date_key TEXT NOT NULL, mood TEXT, emotion_tag TEXT, sent_at TEXT, responded_at TEXT, PRIMARY KEY(line_user_id,date_key));
    INSERT INTO webhook_events(event_id) VALUES ('old-event');
  `);
  const worker = await loadWorker();
  const res = await worker.fetch(new Request("https://w.test/diag/reminders", { headers: { authorization: "Bearer t" } }), { DB: db, ADMIN_TOKEN: "t" }, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(db.row("SELECT status FROM webhook_events WHERE event_id='old-event'").status, "done", "舊事件視為已完成");
  const cols = db.rows("PRAGMA table_info(tasks)").map(c => c.name);
  for (const c of ["reminder_claimed_at", "recurrence_json", "task_type", "stuck_count"]) assert.ok(cols.includes(c), c);
});
