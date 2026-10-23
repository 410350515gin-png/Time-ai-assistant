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
  assert.match(h.net.lastText(), /存好 1 項/);
  assert.equal(h.sentToQueue.at(-1).delaySeconds, 5, "按鈕只留一份延遲的 Queue 備份");
  await h.drainQueue();
  assert.equal(h.net.outgoing().length, 2, "備份到期時看到事件已完成，不會重送");

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
  assert.ok(h.queue.length >= 1, "inline 失敗後 Queue 裡有事件（延遲備份 + 立即補送）");
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
  assert.ok(h.queue.length >= 1, "過期 → 當一般對話交給 AI");
  const before = h.net.geminiCalls.length;
  const r = await h.drainQueue();
  assert.equal(r.retried, 0, "queue 不用等租約過期就能接手");
  assert.equal(h.net.geminiCalls.length - before, 1, "AI 只被呼叫一次");
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
  // 固定在台灣時間今天中午，避免測試結果跟執行時刻有關（例如半夜跑）
  const realNow = Date.now;
  const l = new Date(realNow() + 8 * HOUR);
  const noon = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 12, 0) - 8 * HOUR;
  Date.now = () => noon;
  const later = noon + 2 * HOUR; // 今天 14:00 的提醒
  const id = h.insertTask({
    title: "吃藥", task_type: "routine",
    recurrence_json: JSON.stringify({ freq: "daily", interval: 1, time: "14:00" }),
    remind_at: new Date(later).toISOString()
  });
  let text;
  try {
    text = await h.tap(`系統：完成任務:${id}`);
  } finally {
    Date.now = realNow;
  }
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
  assert.equal(h.net.lastMessage().type, "flex");
  await h.drainQueue();
  assert.equal(h.net.geminiCalls.length, 0);
  assert.equal(h.net.outgoing().length, 1);
});

test("新的 Rich Menu 使用 postback 並存成 v2 設定；初始化在 cron 做，不佔 webhook", async () => {
  const h = await setup();
  await h.webhook([h.textEvent("系統：列出任務")]);
  assert.ok(!h.net.calls.some(c => c.path.startsWith("/v2/bot/richmenu")), "webhook 路徑不碰 Rich Menu");
  await h.cron();
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

/* ============================== PR #1 review 修正 ============================== */

test("[review P1] 兩個 processor 同時接手同一個 stale event → 只有一個成功，副作用只執行一次", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  const ev = h.postbackEvent(`系統：卡住任務:${id}`, { eventId: "evt-stale", timestamp: Date.now() - 120000 });
  h.db.exec("INSERT INTO webhook_events(event_id,status,updated_at) VALUES ('evt-stale','processing',datetime('now','-10 minutes'))");

  const results = [];
  const run = () => {
    const r = { acked: 0, retried: 0 };
    results.push(r);
    return h.worker.queue({ messages: [{ id: "x", body: { type: "LINE_EVENT", event: ev }, attempts: 2, ack() { r.acked++; }, retry() { r.retried++; } }] }, h.env);
  };
  await Promise.all([run(), run(), run()]);

  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", id).stuck_count, 1, "副作用只執行一次");
  assert.equal(h.net.outgoing().length, 1, "只回覆一次");
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM task_events WHERE event_type='stuck'").n, 1);
  assert.equal(h.db.row("SELECT status FROM webhook_events WHERE event_id='evt-stale'").status, "done");
});

test("[review P1] 引用 B + AI 誤選 A + 使用者短句「還沒」→ 只會動到 B", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  const a = h.insertTask({ title: "A任務", remind_at: at });
  const b = h.insertTask({ title: "B任務", remind_at: at });
  await h.cron();
  const msgOfB = h.db.row("SELECT message_id FROM bot_messages WHERE task_id=?", b).message_id;
  h.net.gemini = () => ({ intent: "task_stuck", reply: "", task_ids: [a] }); // AI 選錯
  await h.say("還沒", { quotedMessageId: msgOfB });
  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", b).stuck_count, 1);
  assert.equal(h.db.row("SELECT stuck_count FROM tasks WHERE id=?", a).stuck_count, 0);
});

test("[review P1] 引用 B 但文字明確提到 A → 允許改成 A", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  const a = h.insertTask({ title: "繳電話費", remind_at: at });
  const b = h.insertTask({ title: "洗衣服", remind_at: at });
  await h.cron();
  const msgOfB = h.db.row("SELECT message_id FROM bot_messages WHERE task_id=?", b).message_id;
  h.net.gemini = () => ({ intent: "complete_task", reply: "", task_ids: [a] });
  await h.say("不是這個，是電話費已經繳了", { quotedMessageId: msgOfB });
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", a).status, "completed");
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", b).status, "pending");
});

test("[review P1] 引用 B + AI 選 A 和 B，但只提到 B 的情境 → 只完成 B", async () => {
  const h = await setup();
  const at = new Date(Date.now() - 1000).toISOString();
  const a = h.insertTask({ title: "繳電話費", remind_at: at });
  const b = h.insertTask({ title: "洗衣服", remind_at: at });
  await h.cron();
  const msgOfB = h.db.row("SELECT message_id FROM bot_messages WHERE task_id=?", b).message_id;
  h.net.gemini = () => ({ intent: "complete_task", reply: "", task_ids: [a, b] });
  await h.say("好了", { quotedMessageId: msgOfB });
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", b).status, "completed");
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", a).status, "pending");
});

/* ============================== PR #2：webhook 取消安全 ============================== */

const stuckCount = (h, id) => h.db.row("SELECT stuck_count FROM tasks WHERE id=?", id).stuck_count;

test("[PR2 P0] D1 很慢（inline 要好幾秒）+ LINE 約 2 秒斷線 → 斷線前事件已安全進 Queue；副作用與回覆各一次", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  h.db.latencyMs = 400; // 每次 D1 往返 400ms → inline 大約要 4–5 秒
  const r = await h.webhookWithCancel([h.postbackEvent(`系統：卡住任務:${id}`)], 2000);

  assert.equal(r.canceled, false, `webhook 必須在 2 秒內回應（實際 ${r.elapsedMs}ms）`);
  assert.equal(r.status, 200);
  assert.ok(r.elapsedMs < 1000, `回應時間要遠小於 LINE 斷線時間，實際 ${r.elapsedMs}ms`);
  assert.equal(r.queueAtResponse, 1, "回應那一刻，延遲備份已經在 Queue 裡");
  assert.equal(stuckCount(h, id), 0, "此時 inline 還沒做完");

  await Promise.all(r.background);   // 背景 inline 做完
  h.db.latencyMs = 0;
  await h.drainQueue();              // 延遲備份到期
  assert.equal(stuckCount(h, id), 1, "副作用只執行一次");
  assert.equal(h.net.outgoing().length, 1, "LINE 回覆只送一次");
});

test("[PR2 P0] inline 在背景被砍掉（送 reply 時永遠沒回來）→ Queue 備份接手，副作用與回覆各一次", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  const realFetch = globalThis.fetch;
  let hung = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.endsWith("/v2/bot/message/reply") && hung === 0) { hung++; return new Promise(() => {}); } // 第一次 reply 時 isolate 被砍：永遠不會完成
    return realFetch(input, init);
  };
  try {
    const r = await h.webhookWithCancel([h.postbackEvent(`系統：卡住任務:${id}`, { eventId: "evt-killed" })], 2000);
    assert.equal(r.status, 200);
    assert.equal(r.queueAtResponse, 1);
    await new Promise(res => setTimeout(res, 50)); // 讓背景 inline 跑到卡住的 reply
    assert.equal(hung, 1);
    assert.equal(stuckCount(h, id), 1, "副作用已做（handled），只是回覆沒送出");

    // 備份太早到：inline 可能還在送 reply → Queue 先退避，不重送
    const early = await h.drainQueue();
    assert.equal(early.retried, 1);
    assert.equal(h.net.outgoing().length, 0);

    // 超過 inline 租約 → Queue 補送（reply token 還有效就用 reply，否則用帶 retry key 的 push）
    h.db.exec("UPDATE webhook_events SET updated_at=datetime('now','-1 minute') WHERE event_id='evt-killed'");
    const late = await h.drainQueue();
    assert.equal(late.acked, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(stuckCount(h, id), 1, "副作用只執行一次");
  assert.equal(h.net.outgoing().length, 1, "回覆只送出一次（Queue 補送）");
  assert.match(h.net.lastText(), /洗衣服/);
  assert.equal(h.db.row("SELECT status FROM webhook_events WHERE event_id='evt-killed'").status, "done");
});

test("[PR2 P0] inline 在 processing 階段被砍（租約沒放掉）→ inline 租約到期後 Queue 接手", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  const ev = h.postbackEvent(`系統：卡住任務:${id}`, { eventId: "evt-dead-inline", timestamp: Date.now() - 120000 });
  h.db.exec("INSERT INTO webhook_events(event_id,status,owner,updated_at) VALUES ('evt-dead-inline','processing','inline',datetime('now','-5 seconds'))");
  h.queue.push({ type: "LINE_EVENT", event: ev });
  assert.equal((await h.drainQueue()).retried, 1, "inline 租約內先退避");
  h.db.exec("UPDATE webhook_events SET updated_at=datetime('now','-20 seconds') WHERE event_id='evt-dead-inline'");
  assert.equal((await h.drainQueue()).acked, 1, "15 秒 inline 租約到期就接手（不用等 90 秒）");
  assert.equal(stuckCount(h, id), 1);
  assert.equal(h.net.outgoing().length, 1);
});

test("[PR2 P0] Rich Menu postback「查看所有任務」：回應前已進 Queue，背景立刻回覆任務中心", async () => {
  const h = await setup();
  const r = await h.webhookWithCancel([h.postbackEvent("系統：列出任務")], 2000);
  assert.equal(r.status, 200);
  assert.equal(r.queueAtResponse, 1);
  await Promise.all(r.background);
  assert.equal(h.net.replies().length, 1, "用免費的 reply");
  assert.equal(h.net.lastMessage().type, "flex");
  await h.drainQueue();
  assert.equal(h.net.outgoing().length, 1);
});

test("[PR2 P0] Queue 掛掉 + inline 很快 → 在硬上限內完成，回 200", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  h.queueControl.failures = 1;
  const r = await h.webhookWithCancel([h.postbackEvent(`系統：卡住任務:${id}`)], 2000);
  assert.equal(r.status, 200);
  assert.equal(stuckCount(h, id), 1);
  assert.equal(h.net.replies().length, 1);
});

test("[PR2 P0] Queue 掛掉 + inline 很慢 → 硬上限（800ms）後回 503 讓 LINE 重送，不會拖到被斷線；重送後副作用仍只一次", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  h.db.latencyMs = 400;
  h.queueControl.failures = 1;
  const ev = h.postbackEvent(`系統：卡住任務:${id}`, { eventId: "evt-queue-down" });
  const r = await h.webhookWithCancel([ev], 2000);
  assert.equal(r.canceled, false, `必須在斷線前回應（實際 ${r.elapsedMs}ms）`);
  assert.ok(r.status >= 500);
  assert.ok(r.elapsedMs < 1500, `硬上限要遠小於 2 秒，實際 ${r.elapsedMs}ms`);
  await Promise.all(r.background);   // 原本的處理在背景做完
  h.db.latencyMs = 0;

  const again = await h.webhookWithCancel([ev], 2000); // LINE 重送
  assert.equal(again.status, 200);
  await Promise.all(again.background);
  await h.drainQueue();
  assert.equal(stuckCount(h, id), 1, "副作用只執行一次");
  assert.equal(h.net.outgoing().length, 1, "回覆只送一次");
});

test("[PR2 P0] Queue 掛掉 + inline 也失敗 → 回 5xx，不能回 200", async () => {
  const h = await setup();
  const id = h.insertTask({ title: "洗衣服" });
  h.db.failNext(/UPDATE tasks\s+SET stuck_count/);
  h.queueControl.failures = 1;
  const r = await h.webhookWithCancel([h.postbackEvent(`系統：卡住任務:${id}`)], 2000);
  assert.ok(r.status >= 500);
  assert.equal(stuckCount(h, id), 0);
});

test("[PR2 P0] Queue 掛掉時，需要 AI 的文字訊息 → 立刻回 503（不嘗試在 webhook 內呼叫 AI）", async () => {
  const h = await setup();
  h.queueControl.failures = 1;
  const r = await h.webhookWithCancel([h.textEvent("明天提醒我繳費")], 2000);
  assert.ok(r.status >= 500);
  assert.ok(r.elapsedMs < 500);
  assert.equal(h.net.geminiCalls.length, 0);
});

test("[PR2] 舊資料庫已是最新 schema 版本時，冷啟動只查 1 次", async () => {
  const { FakeD1, loadWorker } = await import("./harness.mjs");
  const db = new FakeD1();
  const w1 = await loadWorker();
  await w1.fetch(new Request("https://w.test/diag/reminders", { headers: { authorization: "Bearer t" } }), { DB: db, ADMIN_TOKEN: "t" }, { waitUntil() {} });
  let count = 0;
  const realPrepare = db.prepare.bind(db);
  db.prepare = sql => { if (!/SELECT COUNT|SELECT MIN/.test(sql)) count++; return realPrepare(sql); };
  const w2 = await loadWorker(); // 新的 isolate
  await w2.fetch(new Request("https://w.test/diag/reminders", { headers: { authorization: "Bearer t" } }), { DB: db, ADMIN_TOKEN: "t" }, { waitUntil() {} });
  assert.equal(count, 1, `schema 檢查只應該查 1 次，實際 ${count}`);
});

/* ============================== PR #4：工作切分、工作前提醒、使用者控制權 ============================== */

const REPORT = "星期天晚上 9 點要交心理實驗法報告，我現在還沒開始";
const sundayAt = (hh, mm = 0) => {
  // 下一個台灣時間的星期天
  const l = new Date(Date.now() + 8 * HOUR);
  const add = (7 - l.getUTCDay()) % 7 || 7;
  return tpe(l.getUTCFullYear(), l.getUTCMonth() + 1, l.getUTCDate() + add, hh, mm);
};
const stepsProposal = (extra = {}) => ({
  intent: "propose_steps", reply: "", planning_authorized: false,
  goal: { title: "心理實驗法報告", due_time: sundayAt(21), due_source: "user" },
  steps: [
    { title: "確認有哪些報告要交、各自的要求", first_step: "打開課程網站看作業說明" },
    { title: "決定先做哪一份" },
    { title: "列報告架構" },
    { title: "寫內容" },
    { title: "檢查、交出" }
  ],
  ...extra
});
const pendingRow = h => JSON.parse(h.db.row("SELECT plan_json FROM pending_plans").plan_json);
const quickData = h => h.net.lastMessage().quickReply.items.map(i => i.action.data);

test("[PR4 P1] 只給截止資訊 → 只給步驟建議，不出現開始時間或時長", async () => {
  const h = await setup();
  h.net.gemini = () => stepsProposal();
  const text = await h.say(REPORT);
  assert.match(text, /心理實驗法報告/);
  assert.match(text, /截止/);
  assert.match(text, /① 確認有哪些報告要交/);
  assert.doesNotMatch(text, /開始 \d|分鐘|\d+:\d+ 開始/, "不能替使用者定開始時間或時長");
  const data = quickData(h);
  assert.ok(data.some(d => d.startsWith("系統：確認方案:")));
  assert.ok(data.some(d => d.startsWith("系統：只記目標:")));
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 0, "還沒確認就不會存");
});

test("[PR4 P1] AI 沒被授權卻排了開始時間與 120 分鐘 → 程式丟掉 AI 推算的欄位，只留使用者說的截止", async () => {
  const h = await setup();
  h.net.gemini = () => ({
    intent: "propose_plan", reply: "", planning_authorized: false,
    plan_items: [{
      title: "心理實驗法報告", first_step: "打開文件", task_type: "goal", priority: 1,
      start_time: tpe(2030, 1, 5, 10), estimated_minutes: 120, due_time: sundayAt(21),
      sources: { start_time: "ai", estimated_minutes: "ai", due_time: "user" }
    }]
  });
  const text = await h.say(REPORT);
  assert.doesNotMatch(text, /開始/);
  assert.doesNotMatch(text, /120 分鐘/);
  assert.match(text, /截止/);
  const item = pendingRow(h).plan_items[0];
  assert.equal(item.start_time, null);
  assert.equal(item.estimated_minutes, null);
  assert.equal(item.priority, 3);
  assert.ok(item.due_time);
});

test("[PR4 P1] 使用者明確說「幫我安排」→ 才保留 AI 建議的開始時間", async () => {
  const h = await setup();
  const start = new Date(Date.now() + 26 * HOUR).toISOString();
  h.net.gemini = () => ({
    intent: "propose_plan", reply: "", planning_authorized: true,
    plan_items: [{ title: "洗衣服", first_step: "收髒衣服", start_time: start, estimated_minutes: 30, sources: { start_time: "ai" } }]
  });
  const text = await h.say("幫我安排明天洗衣服");
  assert.match(text, /開始/);
  assert.equal(pendingRow(h).plan_items[0].estimated_minutes, 30);
});

test("[PR4 P1] 截圖情境：bot 在聊天裡提議改成兩天、使用者回「好啊」→ 不能存舊方案，要出現修改版再確認", async () => {
  const h = await setup();
  // 1) 先有一份待確認方案
  h.net.gemini = () => ({ intent: "propose_plan", reply: "", plan_items: [{ title: "心理實驗法報告", first_step: "打開文件" }] });
  await h.say("幫我記心理實驗法報告");
  const oldPlanId = pendingRow(h).id;
  // 2) 使用者問問題，AI 用聊天回覆並提議修改（沒有產生新方案）
  h.net.gemini = () => ({ intent: "chat", reply: "可以拆成兩天，要不要我幫你把進度調整一下？" });
  await h.say("是否要分成兩天做");
  // 3) 使用者回「好啊」
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /你（bot）上一句對使用者說：「可以拆成兩天/);
    return { intent: "revise_plan", reply: "改成兩天囉", plan_items: [
      { title: "心理實驗法報告：整理架構", first_step: "列大綱" },
      { title: "心理實驗法報告：完成與檢查", first_step: "寫第一段" }
    ] };
  };
  await h.webhook([h.textEvent("好啊")]);
  assert.ok(h.queue.length >= 1, "「好啊」交給 AI，不是 Fast Path 直接存");
  await h.drainQueue();
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 0, "不能存舊方案");
  const plan = pendingRow(h);
  assert.notEqual(plan.id, oldPlanId, "產生了新的方案");
  assert.equal(plan.plan_items.length, 2);
  assert.match(h.net.lastText(), /整理架構/);
  // 4) 再按確認才寫入
  await h.tap(h.net.lastMessage().quickReply.items[0].action.data);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 2);
});

test("[PR4] bot 正在請你確認方案時，打字「好啊」仍然直接存檔（原本的功能不能壞）", async () => {
  const h = await setup();
  h.net.gemini = () => ({ intent: "propose_plan", reply: "", plan_items: [{ title: "倒垃圾", first_step: "綁袋子" }] });
  await h.say("記一下倒垃圾");
  const before = h.net.geminiCalls.length;
  await h.webhook([h.textEvent("好啊")]);
  await h.drainQueue();
  assert.equal(h.net.geminiCalls.length, before, "不需要問 AI");
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 1);
});

test("[PR4] 確認步驟 → 存目標與步驟，問要一步一步還是一次排好", async () => {
  const h = await setup();
  h.net.gemini = () => stepsProposal();
  await h.say(REPORT);
  await h.tap(quickData(h)[0]);
  const goal = h.db.row("SELECT * FROM tasks WHERE parent_id IS NULL");
  assert.equal(goal.title, "心理實驗法報告");
  assert.equal(goal.due_time, sundayAt(21));
  assert.equal(goal.remind_at, null, "不會自動排提醒");
  const steps = h.db.rows("SELECT title, step_index, session_at FROM tasks WHERE parent_id=? ORDER BY step_index", goal.id);
  assert.equal(steps.length, 5);
  assert.ok(steps.every(s => s.session_at === null), "步驟沒有時間");
  assert.match(h.net.lastText(), /要怎麼排時間/);
  assert.deepEqual(quickData(h), [`系統：排程方式:${goal.id}:step`, `系統：排程方式:${goal.id}:all`]);
});

test("[PR4] 打字修改步驟 → 顯示修改版、再確認", async () => {
  const h = await setup();
  h.net.gemini = () => stepsProposal();
  await h.say(REPORT);
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /尚未確認的步驟建議/);
    return stepsProposal({ steps: [{ title: "確認報告要求" }, { title: "寫完" }] });
  };
  const text = await h.say("步驟太多了，兩步就好");
  assert.match(text, /改好了/);
  assert.match(text, /② 寫完/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 0);
});

test("[PR4] 只記截止 → 只存目標，可以選截止前一天提醒", async () => {
  const h = await setup();
  h.net.gemini = () => stepsProposal({ goal: { title: "期末報告", due_time: new Date(Date.now() + 5 * 24 * HOUR).toISOString(), due_source: "user" } });
  await h.say("下週要交期末報告");
  const goalOnly = quickData(h).find(d => d.startsWith("系統：只記目標:"));
  await h.tap(goalOnly);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks").n, 1);
  const id = h.db.row("SELECT id FROM tasks").id;
  await h.tap(`系統：截止提醒:${id}`);
  const t = h.db.row("SELECT remind_at, due_time FROM tasks WHERE id=?", id);
  assert.equal(Date.parse(t.due_time) - Date.parse(t.remind_at), 24 * HOUR);
});

test("[PR4] AI 推測（不是使用者說的）截止時間不會存", async () => {
  const h = await setup();
  h.net.gemini = () => stepsProposal({ goal: { title: "報告", due_time: sundayAt(21), due_source: "ai" } });
  const text = await h.say("我有一份報告要寫");
  assert.doesNotMatch(text, /截止/);
});

async function setupGoal(h) {
  h.net.gemini = () => stepsProposal();
  await h.say(REPORT);
  await h.tap(quickData(h)[0]);
  const goal = h.db.row("SELECT id FROM tasks WHERE parent_id IS NULL").id;
  const steps = h.db.rows("SELECT id FROM tasks WHERE parent_id=? ORDER BY step_index", goal).map(r => r.id);
  return { goal, steps };
}

test("[PR4] 一步一步：選「30 分鐘後」→ 開始時間 +30 分、提醒提前 10 分鐘", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  await h.tap(`系統：排程方式:${goal}:step`);
  assert.match(h.net.lastText(), /①「確認有哪些報告要交/);
  assert.equal(pendingRow(h).action, "awaiting_step_time");
  await h.tap(`系統：步驟時間:${steps[0]}:30m`);
  const t = h.db.row("SELECT session_at, remind_at FROM tasks WHERE id=?", steps[0]);
  assert.ok(Math.abs(Date.parse(t.session_at) - Date.now() - 30 * 60000) < 10000);
  assert.equal(Date.parse(t.session_at) - Date.parse(t.remind_at), 10 * 60000);
  assert.match(h.net.lastText(), /提前 10 分鐘/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM pending_plans").n, 0);
});

test("[PR4] 一步一步：打字「今晚八點」→ AI 回 schedule_step，程式寫入時間", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  await h.tap(`系統：排程方式:${goal}:step`);
  const at = new Date(Date.now() + 3 * HOUR).toISOString();
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /目前在等使用者回答/);
    return { intent: "schedule_step", reply: "", task_ids: [steps[0]], session_at: at };
  };
  const text = await h.say("今晚八點");
  assert.match(text, /排好了/);
  assert.equal(h.db.row("SELECT session_at FROM tasks WHERE id=?", steps[0]).session_at, at);
});

test("[PR4] 改提醒提前時間 → 重新計算；設成預設後，下一步也套用", async () => {
  const h = await setup();
  const { steps } = await setupGoal(h);
  await h.tap(`系統：步驟時間:${steps[0]}:tomorrow`);
  await h.tap(`系統：設提前:${steps[0]}:30`);
  let t = h.db.row("SELECT session_at, remind_at, lead_minutes FROM tasks WHERE id=?", steps[0]);
  assert.equal(t.lead_minutes, 30);
  assert.equal(Date.parse(t.session_at) - Date.parse(t.remind_at), 30 * 60000);
  await h.tap("系統：預設提前:30");
  await h.tap(`系統：步驟時間:${steps[1]}:tomorrow`);
  t = h.db.row("SELECT session_at, remind_at FROM tasks WHERE id=?", steps[1]);
  assert.equal(Date.parse(t.session_at) - Date.parse(t.remind_at), 30 * 60000);
});

test("[PR4] 工作前提醒：內容有目標、第幾步、開始時間；按鈕有開始、晚點、卡住、怎麼做", async () => {
  const h = await setup();
  const { steps } = await setupGoal(h);
  const session = new Date(Date.now() + 10 * 60000).toISOString();
  h.db.exec("UPDATE tasks SET session_at=?, remind_at=? WHERE id=?", session, new Date(Date.now() - 1000).toISOString(), steps[0]);
  await h.cron();
  const msg = h.net.pushes().at(-1).body.messages[0];
  assert.match(msg.text, /10 分鐘後/);
  assert.match(msg.text, /心理實驗法報告/);
  assert.match(msg.text, /第 1\/5 步：確認有哪些報告要交/);
  const labels = msg.quickReply.items.map(i => i.action.label);
  assert.deepEqual(labels, ["▶️ 開始了", "⏰ 晚30分", "🧩 卡住", "💡 這步怎麼做"]);
});

test("[PR4] 步驟完成 → 問下一步什麼時候做；最後一步完成 → 整個目標完成", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  await h.tap(`系統：完成任務:${steps[0]}`);
  assert.match(h.net.lastText(), /① 「確認有哪些報告要交、各自的要求」完成|①「確認有哪些報告要交、各自的要求」完成/);
  assert.match(h.net.lastText(), /下一步是 ②「決定先做哪一份」/);
  assert.equal(pendingRow(h).task_id, steps[1]);
  for (const id of steps.slice(1)) await h.tap(`系統：完成任務:${id}`);
  assert.match(h.net.lastText(), /全部完成/);
  assert.equal(h.db.row("SELECT status FROM tasks WHERE id=?", goal).status, "completed");
});

test("[PR4] 下一步已經排好時間 → 完成時直接告訴你什麼時候", async () => {
  const h = await setup();
  const { steps } = await setupGoal(h);
  await h.tap(`系統：步驟時間:${steps[1]}:tomorrow`);
  await h.tap(`系統：完成任務:${steps[0]}`);
  assert.match(h.net.lastText(), /已排在/);
});

test("[PR4] 💡 這步怎麼做 → 交給 AI，回覆具體做法，不排時間", async () => {
  const h = await setup();
  const { steps } = await setupGoal(h);
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /這一步：確認有哪些報告要交/);
    return "• 打開課程網站\n• 列出每份報告的截止日";
  };
  await h.webhook([h.postbackEvent(`系統：步驟建議:${steps[0]}`)]);
  await h.drainQueue();
  assert.match(h.net.lastText(), /打開課程網站/);
  assert.equal(h.db.row("SELECT session_at FROM tasks WHERE id=?", steps[0]).session_at, null);
});

test("[PR4] 一次排好 → AI 建議時間表（還沒存）→ 確認後每一步都有時間與提醒", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  const times = steps.map((_, i) => new Date(Date.now() + (5 + i * 3) * HOUR).toISOString());
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /明確要求/);
    assert.match(prompt, /日期對照/);
    return { sessions: steps.map((id, i) => ({ task_id: id, session_at: times[i] })), reply: "前面先做簡單的" };
  };
  await h.webhook([h.postbackEvent(`系統：排程方式:${goal}:all`)]);
  await h.drainQueue();
  assert.match(h.net.lastText(), /還沒存/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE session_at IS NOT NULL").n, 0);
  await h.tap(h.net.lastMessage().quickReply.items[0].action.data);
  assert.match(h.net.lastText(), /5 步都會在開始前提醒你/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE session_at IS NOT NULL AND remind_at IS NOT NULL").n, 5);
});

test("[PR4] 一次排好：AI 排出超過截止或過去的時間 → 被濾掉；全部無效就改一步一步", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  h.net.gemini = () => ({ sessions: [
    { task_id: steps[0], session_at: tpe(2020, 1, 1, 10) },
    { task_id: steps[1], session_at: tpe(2099, 1, 1, 10) },
    { task_id: 99999, session_at: new Date(Date.now() + HOUR).toISOString() }
  ] });
  await h.webhook([h.postbackEvent(`系統：排程方式:${goal}:all`)]);
  await h.drainQueue();
  assert.match(h.net.lastText(), /一步一步來/);
  assert.equal(pendingRow(h).action, "awaiting_step_time");
});

test("[PR4] 任務中心只列目標並顯示進度，不列出步驟", async () => {
  const h = await setup();
  const { steps } = await setupGoal(h);
  await h.tap(`系統：完成任務:${steps[0]}`);
  await h.tap("系統：任務分類:goal");
  const flex = JSON.stringify(h.net.lastMessage().contents);
  assert.match(flex, /心理實驗法報告/);
  assert.match(flex, /進度 1\/5/);
  assert.match(flex, /下一步：② 決定先做哪一份/);
  assert.doesNotMatch(flex, /列報告架構/);
});

test("[PR4] 刪除目標 → 步驟一起移除，不會再提醒", async () => {
  const h = await setup();
  const { goal } = await setupGoal(h);
  await h.tap(`系統：刪除任務:${goal}`);
  await h.tap(h.net.lastMessage().quickReply.items[0].action.data);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE status='pending'").n, 0);
});

test("[PR4 P2] prompt 附上未來 7 天的日期對照表", async () => {
  const h = await setup();
  await h.say("你好");
  const prompt = h.net.geminiCalls.at(-1).prompt;
  assert.match(prompt, /日期對照（台灣）：今天=\d{4}-\d{2}-\d{2}（星期.）、明天=/);
});

test("[PR4] 一次排好的時間表用打字修改 → 顯示步驟名稱的修改版，還要再確認", async () => {
  const h = await setup();
  const { goal, steps } = await setupGoal(h);
  const times = steps.map((_, i) => new Date(Date.now() + (5 + i * 3) * HOUR).toISOString());
  h.net.gemini = () => ({ sessions: steps.map((id, i) => ({ task_id: id, session_at: times[i] })) });
  await h.webhook([h.postbackEvent(`系統：排程方式:${goal}:all`)]);
  await h.drainQueue();
  const later = new Date(Date.now() + 30 * HOUR).toISOString();
  h.net.gemini = (t, prompt) => {
    assert.match(prompt, /尚未確認的時間表/);
    return { intent: "schedule_step", reply: "", sessions: steps.map((id, i) => ({ task_id: id, session_at: i === 1 ? later : times[i] })) };
  };
  const text = await h.say("第二步改到後天");
  assert.match(text, /② .*決定先做哪一份/);
  assert.equal(h.db.row("SELECT COUNT(*) AS n FROM tasks WHERE session_at IS NOT NULL").n, 0, "還沒確認就不寫入");
});
