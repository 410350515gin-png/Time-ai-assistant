import { REWARD_IMAGES_BASE64 } from "./rewardImages.js";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const YES = new Set(["是","好","確認","確認執行","同意","可以","ok","yes","好啊","照這個安排","確認計畫","好呀🐽"]);
const NO = new Set(["否","不要","取消","不用","no","先不要","不接受","先不要🙈"]);
const MODIFY = new Set(["修改","我要改","我要修改","調整","我要改✏️"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        status: "ok",
        runtime: "cloudflare-workers",
        version: "0.2",
        db_bound: Boolean(env.DB)
      });
    }

    if (request.method === "GET" && url.pathname === "/diag") {
      return runDiagnostics(env);
    }

    if (request.method === "GET" && url.pathname === "/diag/reminders") {
      return runReminderDiagnostics(env);
    }

    if (request.method === "POST" && url.pathname === "/admin/setup-rich-menu") {
      return setupRichMenu(env);
    }

    const rewardMatch = url.pathname.match(/^\/reward-images\/(\d+)\.jpg$/);
    if (request.method === "GET" && rewardMatch) {
      const index = Number(rewardMatch[1]) - 1;
      const base64 = REWARD_IMAGES_BASE64[index];
      if (!base64) return new Response("Not Found", { status: 404 });

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    if (request.method === "POST" && (url.pathname === "/callback" || url.pathname === "/webhook")) {
      return handleLineWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    console.log("Cron scheduled event", {
      scheduledTime: controller.scheduledTime,
      cron: controller.cron || null
    });
    ctx.waitUntil(Promise.all([
      processDueReminders(env, controller.scheduledTime),
      processEveningCheckins(env, controller.scheduledTime)
    ]));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const body = message.body || {};
        if (body.type !== "LINE_EVENT" || !body.event) {
          console.warn("Unknown queue message", { type: body.type || null });
          message.ack();
          continue;
        }

        await processQueuedLineEvent(body.event, env);
        message.ack();
      } catch (err) {
        console.error("Queue processing failed", {
          name: err?.name || null,
          message: err?.message || String(err),
          stack: err?.stack || null
        });
        message.retry({ delaySeconds: 30 });
      }
    }
  }
};

async function handleLineWebhook(request, env, ctx) {
  console.log("LINE webhook received", request.method, new URL(request.url).pathname);
  const raw = await request.text();
  const signature = request.headers.get("x-line-signature") || "";

  if (!env.CHANNEL_SECRET || !env.CHANNEL_ACCESS_TOKEN || !env.GEMINI_API_KEY) {
    return json({ error: "missing secrets" }, 500);
  }

  const valid = await verifyLineSignature(raw, signature, env.CHANNEL_SECRET);
  if (!valid) {
    console.error("LINE signature invalid");
    return json({ error: "invalid signature" }, 400);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  console.log("LINE events count", events.length);

  if (env.DB && env.CHANNEL_ACCESS_TOKEN) {
    ctx.waitUntil(
      ensurePigRichMenu(env).catch(err => {
        console.error("Rich Menu bootstrap failed", {
          name: err?.name || null,
          message: err?.message || String(err)
        });
      })
    );
  }

  if (!env.GEMINI_QUEUE) {
    console.error("GEMINI_QUEUE binding missing");
    return json({ error: "queue unavailable" }, 503);
  }

  try {
    for (const event of events) {
      await env.GEMINI_QUEUE.send({
        type: "LINE_EVENT",
        event,
        enqueued_at: Date.now()
      });
    }
  } catch (err) {
    console.error("Queue enqueue failed", {
      name: err?.name || null,
      message: err?.message || String(err)
    });
    return json({ error: "queue enqueue failed" }, 503);
  }

  return json({ status: "queued", count: events.length });
}

async function processQueuedLineEvent(event, env) {
  const isText = event?.type === "message" && event?.message?.type === "text";
  const isPostback = event?.type === "postback" && typeof event?.postback?.data === "string";
  if (!isText && !isPostback) return;

  const text = isPostback
    ? String(event.postback.data || "").trim()
    : String(event.message.text || "").trim();
  const uid = event?.source?.userId;
  if (!text || !uid) return;

  if (env.DB) {
    await ensureSchema(env.DB);
    await ensureReminderColumn(env.DB);
    await ensureRecurrenceColumn(env.DB);
    await ensureTaskTypeColumn(env.DB);
    await ensureBehaviorColumns(env.DB);
    await env.DB.prepare(
      "UPDATE tasks SET task_type='routine' WHERE recurrence_json IS NOT NULL AND recurrence_json <> '' AND task_type='daily'"
    ).run();
  }

  console.log("Queue LINE text event", {
    textLength: text.length,
    db: Boolean(env.DB),
    webhookEventId: event.webhookEventId || null
  });

  if (env.DB && event.webhookEventId) {
    const inserted = await rememberEvent(env.DB, event.webhookEventId);
    if (!inserted) {
      console.log("Duplicate queued webhook skipped", event.webhookEventId);
      return;
    }
  }

  let reply;
  try {
    reply = env.DB
      ? await handleTaskMessage(uid, text, env)
      : await interpretPlainText(text, env);
    console.log("Queue AI/task reply ready", { length: messageText(reply).length, quickReply: Boolean(reply?.quickReply) });
  } catch (err) {
    console.error("Queued message processing failed", {
      name: err?.name || null,
      message: err?.message || String(err),
      stack: err?.stack || null
    });
    throw err;
  }

  await pushLine(uid, reply, env.CHANNEL_ACCESS_TOKEN);
  console.log("LINE push sent from queue");
}

async function processLineEvents(events, env) {
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
    } catch (err) {
      console.error("D1 schema init failed", err);
    }
  }

  for (const event of events) {
    if (event?.type !== "message" || event?.message?.type !== "text") continue;

    const text = (event.message.text || "").trim();
    const replyToken = event.replyToken;
    const uid = event?.source?.userId;
    if (!text || !replyToken || !uid) continue;

    console.log("LINE text event", { hasReplyToken: true, textLength: text.length, db: Boolean(env.DB) });

    if (env.DB && event.webhookEventId) {
      const inserted = await rememberEvent(env.DB, event.webhookEventId);
      if (!inserted) {
        console.log("Duplicate webhook skipped", event.webhookEventId);
        continue;
      }
    }

    let reply;
    try {
      reply = env.DB
        ? await handleTaskMessage(uid, text, env)
        : await interpretPlainText(text, env);
      console.log("AI/task reply ready", { length: reply.length });
    } catch (err) {
      console.error("Message processing failed", {
        name: err?.name || null,
        message: err?.message || String(err),
        stack: err?.stack || null
      });
      reply = "這次處理失敗，但 LINE 連線正常。請稍後再傳一次。";
    }

    try {
      await replyLine(replyToken, reply, env.CHANNEL_ACCESS_TOKEN);
      console.log("LINE reply sent successfully");
    } catch (err) {
      console.error("LINE reply failed", err);
    }
  }
}

async function handleTaskMessage(uid, text, env) {
  await ensureUser(env.DB, uid);
  const lower = String(text || "").trim().toLowerCase();

  // System button actions only. Natural-language intent is handled by AI below.
  const pending = await getPendingPlan(env.DB, uid);

  if (pending && YES.has(lower)) {
    if (pending.action === "delete_all") {
      const r = await env.DB.prepare(
        "UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE line_user_id=? AND status IN ('pending','paused')"
      ).bind(uid).run();
      await clearPendingPlan(env.DB, uid);
      return `🗑️ 已移除 ${Number(r?.meta?.changes || 0)} 項待辦任務，後續提醒也會停止。`;
    }

    if (pending.action === "delete_tasks") {
      const ids = Array.isArray(pending.task_ids) ? pending.task_ids.filter(Number.isInteger) : [];
      if (!ids.length) {
        await clearPendingPlan(env.DB, uid);
        return "找不到要刪除的任務。";
      }
      const placeholders = ids.map(() => "?").join(",");
      const r = await env.DB.prepare(
        `UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
         WHERE line_user_id=? AND status IN ('pending','paused') AND id IN (${placeholders})`
      ).bind(uid, ...ids).run();
      await clearPendingPlan(env.DB, uid);
      return `🗑️ 已移除 ${Number(r?.meta?.changes || 0)} 項任務，之後不會再提醒。`;
    }

    const items = Array.isArray(pending.plan_items) ? pending.plan_items : [];
    const saved = await savePlanTasks(env.DB, uid, items);
    await clearPendingPlan(env.DB, uid);
    return `✅ 好呀🐽 已經幫你存好 ${saved} 項任務。\n之後可以直接跟我說「列出任務」或告訴我哪一項完成了。`;
  }

  if (pending && NO.has(lower)) {
    await clearPendingPlan(env.DB, uid);
    return "好～這次先不執行🙈";
  }

  if (pending && MODIFY.has(lower)) {
    return "可以呀✏️ 直接用你平常說話的方式告訴我想怎麼改。";
  }

  const incompleteReply = /^(還沒|還沒有|還沒做|還沒完成|還沒開始|尚未|還沒弄|還沒用)$/u.test(String(text || "").trim());
  if (!pending && incompleteReply) {
    const recent = await findRecentRemindedTask(env.DB, uid);
    if (recent) {
      const task = await markTaskStuck(env.DB, uid, Number(recent.id), "natural_incomplete");
      if (task) return buildStuckIntervention(task);
    }
  }

  const fast = await handleFastPath(uid, text, env);
  if (fast) return fast;

  const activeContext = await activeTasksContext(env.DB, uid);
  const pendingContext = pending?.plan_items?.length
    ? "\n\n尚未確認的方案：\n" + pending.plan_items.map((x, i) =>
        `proposal_${i + 1};title=${x.title || ""};start=${x.start_time || ""};due=${x.due_time || ""};remind=${x.remind_at || ""};first_step=${x.first_step || ""}`
      ).join("\n")
    : "";
  const context = activeContext + pendingContext;
  const result = await interpretStructured(text, context, env);

  if (result.intent === "list_tasks") {
    return buildTaskHubMessage();
  }

  if (result.intent === "complete_task") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    if (!ids.length) return result.reply || "我還不能確定你要完成哪一項任務。";

    const id = ids[0];
    const task = await env.DB.prepare(
      "UPDATE tasks SET status='completed', stuck_count=0, last_barrier=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status IN ('pending','paused') RETURNING id,title"
    ).bind(id, uid).first();
    if (task) await logTaskEvent(env.DB, id, uid, "completed");
    return task ? buildCompletionMessage(task, env) : "找不到這個待辦任務。";
  }

  if (result.intent === "change_task_type") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    const type = ["routine","goal","daily"].includes(result.task_type) ? result.task_type : null;
    if (!ids.length || !type) return result.reply || "我還不能確定要改哪一項或改成哪一類🐽";

    const placeholders = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `UPDATE tasks SET task_type=?, updated_at=CURRENT_TIMESTAMP
       WHERE line_user_id=? AND status IN ('pending','paused') AND id IN (${placeholders})`
    ).bind(type, uid, ...ids).run();

    return Number(r?.meta?.changes || 0) > 0
      ? `改好啦🐽 已移到 ${taskTypeLabel(type)} 任務。`
      : "找不到符合的待辦任務🐽";
  }

  if (result.intent === "delete_all_tasks") {
    await setPendingPlan(env.DB, uid, { action: "delete_all" });
    return withDeleteActions("要把目前所有待辦任務都移除嗎？\n這會停止後續提醒，但會保留歷史紀錄。");
  }

  if (result.intent === "delete_task") {
    const ids = normalizeTaskIds(result.task_ids, result.task_id);
    if (!ids.length) return result.reply || "我還不能確定你想刪除哪一項任務。";

    const rows = await env.DB.prepare(
      `SELECT id,title FROM tasks
       WHERE line_user_id=? AND status IN ('pending','paused')
       ORDER BY id DESC LIMIT 100`
    ).bind(uid).all();
    const selected = (rows.results || []).filter(t => ids.includes(Number(t.id)));
    if (!selected.length) return "找不到你要刪除的待辦任務。";

    await setPendingPlan(env.DB, uid, {
      action: "delete_tasks",
      task_ids: selected.map(t => Number(t.id))
    });

    const names = selected.map(t => `「${t.title}」`).join("、");
    return withDeleteActions(`要移除 ${names} 嗎？\n移除後會停止提醒，但會保留歷史紀錄。`);
  }

  if (result.intent === "propose_plan" || result.intent === "revise_plan" || result.intent === "create_reminder") {
    let items = sanitizePlanItems(result.plan_items);

    if (result.intent === "create_reminder" && items.length) {
      items = items.map(item => normalizeReminderItem(
        applyAiTimeSemantics(item, result.time_semantics)
      ));
    }

    // Safety validation only: AI understands language; program validates execution data.
    items = items.map(validatePlanTimes).filter(Boolean);

    if (result.intent === "create_reminder" && !items.some(x => x.remind_at)) {
      return result.reply || "我理解你要設定提醒，但目前還不能可靠確定提醒時間；請再補一點時間資訊。";
    }

    if (items.length) {
      await setPendingPlan(env.DB, uid, { plan_items: items });
      if (result.intent === "create_reminder") {
        const first = items[0];
        return withPlanActions(
          `好呀🐽 我先幫你排著～\n📌 ${first.title}\n🏷️ ${taskTypeLabel(first.task_type)}\n⏰ 提醒：${fmtTaipei(first.remind_at)}\n\n還沒正式存，選一下👇`,
          items.length === 1
        );
      }

      const heading = "📅 我幫你整理好了🐽";
      return withPlanActions(`${result.reply || heading}\n\n${formatPlan(items)}\n\n選一下👇`, items.length === 1);
    }
  }

  return result.reply || "我有收到，但目前還不能安全判斷你想執行哪個操作。";
}

async function findRecentRemindedTask(db, uid) {
  // Prefer an explicit reminder event from the last 6 hours.
  const eventTask = await db.prepare(
    `SELECT t.id,t.title,t.first_step,t.due_time,t.task_type,t.stuck_count,t.last_barrier
     FROM task_events e
     JOIN tasks t ON t.id=e.task_id
     WHERE e.line_user_id=?
       AND e.event_type='reminder_sent'
       AND e.created_at >= datetime('now','-6 hours')
       AND t.status IN ('pending','paused')
     ORDER BY e.created_at DESC
     LIMIT 1`
  ).bind(uid).first();
  if (eventTask) return eventTask;

  // Backward-compatible fallback for reminders sent before event logging existed.
  return db.prepare(
    `SELECT id,title,first_step,due_time,task_type,stuck_count,last_barrier
     FROM tasks
     WHERE line_user_id=?
       AND status IN ('pending','paused')
       AND reminder_sent_at IS NOT NULL
       AND reminder_sent_at >= datetime('now','-6 hours')
     ORDER BY reminder_sent_at DESC
     LIMIT 1`
  ).bind(uid).first();
}

async function markTaskStuck(db, uid, id, source = "button") {
  const task = await db.prepare(
    `UPDATE tasks
     SET stuck_count=COALESCE(stuck_count,0)+1, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND line_user_id=? AND status IN ('pending','paused')
     RETURNING id,title,first_step,due_time,task_type,stuck_count,last_barrier`
  ).bind(id, uid).first();

  if (task) {
    await logTaskEvent(db, id, uid, "stuck", JSON.stringify({
      count: Number(task.stuck_count || 1),
      source
    }));
  }
  return task;
}

async function handleFastPath(uid, text, env) {
  const s = String(text || "").trim();

  if (s === "系統：列出任務" || s === "查看所有任務") {
    return buildTaskHubMessage();
  }

  const categoryMatch = s.match(/^系統：任務分類:(routine|goal|daily)$/u);
  if (categoryMatch) {
    return listTasksByType(env.DB, uid, categoryMatch[1]);
  }

  if (s === "系統：改待確認分類") {
    const pending = await getPendingPlan(env.DB, uid);
    const items = Array.isArray(pending?.plan_items) ? pending.plan_items : [];
    if (items.length !== 1) return "這次有多個任務，直接跟我說哪一項要改成哪一類就好🐽";
    return categoryChoiceMessage(items[0].title, "pending");
  }

  const pendingType = s.match(/^系統：設定待確認分類:(routine|goal|daily)$/u);
  if (pendingType) {
    const pending = await getPendingPlan(env.DB, uid);
    const items = Array.isArray(pending?.plan_items) ? pending.plan_items : [];
    if (items.length !== 1) return "找不到可以修改的待確認任務🐽";
    items[0].task_type = pendingType[1];
    await setPendingPlan(env.DB, uid, { ...pending, plan_items: items });
    return withPlanActions(
      `改好啦🐽\n📌 ${items[0].title}\n🏷️ ${taskTypeLabel(items[0].task_type)}\n\n確認沒問題就存起來～`,
      true
    );
  }

  const changeType = s.match(/^系統：改分類:(\d+)$/u);
  if (changeType) {
    const id = Number(changeType[1]);
    const task = await env.DB.prepare(
      "SELECT id,title FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    return categoryChoiceMessage(task.title, id);
  }

  const setType = s.match(/^系統：設定分類:(\d+):(routine|goal|daily)$/u);
  if (setType) {
    const id = Number(setType[1]);
    const type = setType[2];
    const task = await env.DB.prepare(
      "UPDATE tasks SET task_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status IN ('pending','paused') RETURNING id,title"
    ).bind(type, id, uid).first();
    return task
      ? `改好啦🐽 「${task.title}」已移到 ${taskTypeLabel(type)} 任務。`
      : "找不到這項待辦了🐽";
  }

  const mood = s.match(/^系統：晚間心情:(\d{4}-\d{2}-\d{2}):(great|good|neutral|tired|low)$/u);
  if (mood) {
    const dateKey = mood[1];
    const value = mood[2];
    await env.DB.prepare(
      `INSERT INTO daily_checkins(line_user_id,date_key,mood,responded_at)
       VALUES (?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(line_user_id,date_key) DO UPDATE
       SET mood=excluded.mood, responded_at=CURRENT_TIMESTAMP`
    ).bind(uid, dateKey, value).run();

    const labels = {
      great: "很不錯 😄",
      good: "還可以 🙂",
      neutral: "普通 😐",
      tired: "有點累 😮‍💨",
      low: "很低落 😞"
    };

    return {
      text: `記下來了🐽 今天是「${labels[value]}」。\n如果願意，再選一個今天最明顯的感受；不想填也可以直接收工。`,
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("✨ 有成就感", `系統：晚間情緒:${dateKey}:accomplished`, "✨ 今天有成就感") },
          { type: "action", action: hiddenPostbackAction("🌿 平靜", `系統：晚間情緒:${dateKey}:calm`, "🌿 今天比較平靜") },
          { type: "action", action: hiddenPostbackAction("😵‍💫 焦慮", `系統：晚間情緒:${dateKey}:anxious`, "😵‍💫 今天有點焦慮") },
          { type: "action", action: hiddenPostbackAction("🪫 疲累", `系統：晚間情緒:${dateKey}:exhausted`, "🪫 今天很疲累") },
          { type: "action", action: hiddenPostbackAction("😤 煩躁", `系統：晚間情緒:${dateKey}:irritable`, "😤 今天有點煩躁") },
          { type: "action", action: hiddenPostbackAction("🌧️ 低落", `系統：晚間情緒:${dateKey}:down`, "🌧️ 今天有點低落") },
          { type: "action", action: hiddenPostbackAction("收工🐽", `系統：晚間情緒:${dateKey}:skip`, "今天先到這裡 🐽") }
        ]
      }
    };
  }

  const emotion = s.match(/^系統：晚間情緒:(\d{4}-\d{2}-\d{2}):(accomplished|calm|anxious|exhausted|irritable|down|skip)$/u);
  if (emotion) {
    const dateKey = emotion[1];
    const tag = emotion[2];

    if (tag !== "skip") {
      await env.DB.prepare(
        `INSERT INTO daily_checkins(line_user_id,date_key,emotion_tag,responded_at)
         VALUES (?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(line_user_id,date_key) DO UPDATE
         SET emotion_tag=excluded.emotion_tag, responded_at=CURRENT_TIMESTAMP`
      ).bind(uid, dateKey, tag).run();
    }

    const closings = {
      accomplished: "今天有做到一些對自己重要的事，這份進度值得看見✨",
      calm: "有一點平靜就很好，今晚先把今天放下吧🌿",
      anxious: "今天有點焦慮也沒關係，明天的事情明天再一起整理🐽",
      exhausted: "今天真的累了，今晚先休息，不用再補進度🪫",
      irritable: "今天有點煩躁，先讓這一天結束就好🐽",
      down: "今天比較低落，明天我會盡量把事情排得更輕一點🌧️",
      skip: "好，今天就到這裡🐽 晚安。"
    };

    return closings[tag] || "記下來了🐽 今天先到這裡。";
  }

  const stuck = s.match(/^系統：卡住任務:(\d+)$/u);
  if (stuck) {
    const id = Number(stuck[1]);
    const task = await markTaskStuck(env.DB, uid, id, "button");
    if (!task) return "找不到這項待辦了🐽";
    return buildStuckIntervention(task);
  }

  const barrier = s.match(/^系統：障礙:(\d+):(tired|unclear|time|avoid)$/u);
  if (barrier) {
    const id = Number(barrier[1]);
    const kind = barrier[2];
    const task = await env.DB.prepare(
      `UPDATE tasks
       SET last_barrier=?, stuck_count=CASE WHEN COALESCE(stuck_count,0) < 2 THEN 2 ELSE stuck_count END, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=? AND status IN ('pending','paused')
       RETURNING id,title,first_step,due_time,task_type,stuck_count,last_barrier`
    ).bind(kind, id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    await logTaskEvent(env.DB, id, uid, "barrier", kind);
    return buildBarrierPlan(task, kind);
  }

  const microStart = s.match(/^系統：先做五分鐘:(\d+)$/u);
  if (microStart) {
    const id = Number(microStart[1]);
    const task = await env.DB.prepare(
      "SELECT id,title,first_step FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";
    await logTaskEvent(env.DB, id, uid, "micro_start", "5m");
    return {
      text: `好，就只做 5 分鐘🐽\n\n👉 ${task.first_step || task.title}\n\n5 分鐘後想停也可以；現在不用處理整件事。`,
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("✅ 做完了", `系統：完成任務:${id}`, "這一步做完了 ✅") },
          { type: "action", action: hiddenPostbackAction("😵 還是卡住", `系統：卡住任務:${id}`, "還是卡住了 😵") }
        ]
      }
    };
  }

  const done = s.match(/^系統：完成任務:(\d+)$/u);
  if (done) {
    const id = Number(done[1]);
    const task = await env.DB.prepare(
      "UPDATE tasks SET status='completed', stuck_count=0, last_barrier=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND line_user_id=? AND status IN ('pending','paused') RETURNING id,title"
    ).bind(id, uid).first();
    if (task) await logTaskEvent(env.DB, id, uid, "completed");
    return task ? buildCompletionMessage(task, env) : "這項好像已經處理掉了🐽";
  }

  const del = s.match(/^系統：刪除任務:(\d+)$/u);
  if (del) {
    const id = Number(del[1]);
    const task = await env.DB.prepare(
      "SELECT id,title FROM tasks WHERE id=? AND line_user_id=? AND status IN ('pending','paused')"
    ).bind(id, uid).first();
    if (!task) return "找不到這項待辦了🐽";

    await setPendingPlan(env.DB, uid, { action: "delete_tasks", task_ids: [id] });
    return withDeleteActions(`要移除「${task.title}」嗎？🐽\n移除後就不會再提醒囉。`);
  }

  const snooze = s.match(/^系統：延後任務:(\d+):(\d+)$/u);
  if (snooze) {
    const id = Number(snooze[1]);
    const minutes = Number(snooze[2]);
    if (!Number.isInteger(minutes) || minutes <= 0) return null;

    const when = new Date(Date.now() + minutes * 60000).toISOString();
    const task = await env.DB.prepare(
      `UPDATE tasks
       SET remind_at=?, reminder_sent_at=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND line_user_id=? AND status='pending'
       RETURNING id,title`
    ).bind(when, id, uid).first();

    return task
      ? `好呀🐽 我晚 ${minutes} 分鐘再叫你～`
      : "找不到這項待辦了🐽";
  }

  return null;
}

function hiddenPostbackAction(label, data, displayText = null) {
  const action = { type: "postback", label, data };
  if (displayText) action.displayText = displayText;
  return action;
}

function hoursUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? ms / 3600000 : null;
}

function buildStuckIntervention(task) {
  const count = Number(task.stuck_count || 1);
  const first = String(task.first_step || task.title || "").trim();
  const h = hoursUntil(task.due_time);

  if (h !== null && h <= 24 && h > 0) {
    return {
      text: `先不追求完整，我們切成「能交出去」的版本🐽\n\n📌 ${task.title}\n👉 現在先做：${first}\n\n剩下的等這一步完成再決定。`,
      quickReply: { items: [
        { type: "action", action: hiddenPostbackAction("▶️ 先做5分鐘", `系統：先做五分鐘:${task.id}`, "我先做 5 分鐘 ▶️") },
        { type: "action", action: hiddenPostbackAction("🧩 我卡住了", `系統：卡住任務:${task.id}`, "這一步我還是卡住 🧩") }
      ] }
    };
  }

  if (count <= 1) {
    return {
      text: `不用處理整件事，先把門檻降到很低🐽\n\n📌 ${task.title}\n👉 只做這一步：${first}\n\n先做 5 分鐘就算有前進。`,
      quickReply: { items: [
        { type: "action", action: hiddenPostbackAction("▶️ 先做5分鐘", `系統：先做五分鐘:${task.id}`, "我先做 5 分鐘 ▶️") },
        { type: "action", action: hiddenPostbackAction("😵 還是很難", `系統：卡住任務:${task.id}`, "還是很難開始 😵") }
      ] }
    };
  }

  return {
    text: `看起來不是提醒次數的問題，我們找真正卡點🐽\n「${task.title}」現在比較像哪一種？`,
    quickReply: { items: [
      { type: "action", action: hiddenPostbackAction("😴 太累", `系統：障礙:${task.id}:tired`, "我現在太累 😴") },
      { type: "action", action: hiddenPostbackAction("❓ 不知怎開始", `系統：障礙:${task.id}:unclear`, "我不知道怎麼開始 ❓") },
      { type: "action", action: hiddenPostbackAction("⏰ 時間不夠", `系統：障礙:${task.id}:time`, "我時間不夠 ⏰") },
      { type: "action", action: hiddenPostbackAction("🙈 很不想做", `系統：障礙:${task.id}:avoid`, "我就是很不想做 🙈") }
    ] }
  };
}

function buildBarrierPlan(task, kind) {
  const first = String(task.first_step || task.title || "").trim();
  const plans = {
    tired: `如果現在很累，就只做 5 分鐘「${first}」；5 分鐘到就可以停。`,
    unclear: `如果不知道怎麼開始，就先只做「${first}」，不要往後想。`,
    time: `如果今天時間真的不夠，就先做「${first}」，其餘先保留，不硬塞進今天。`,
    avoid: `可以很不想做，同時只做 5 分鐘「${first}」。不需要先讓自己有動力。`
  };
  return {
    text: `好，我們不跟卡住硬碰硬🐽\n\n${plans[kind] || plans.unclear}\n\n這次只要求「開始」，不要求一次做完。`,
    quickReply: { items: [
      { type: "action", action: hiddenPostbackAction("▶️ 好，先開始", `系統：先做五分鐘:${task.id}`, "好，我先開始 ▶️") },
      { type: "action", action: hiddenPostbackAction("📅 晚點再排", `系統：延後任務:${task.id}:60`, "一小時後再提醒我 📅") }
    ] }
  };
}

function categoryChoiceMessage(title, target) {
  const pending = target === "pending";
  const prefix = pending ? "系統：設定待確認分類:" : `系統：設定分類:${target}:`;
  return {
    text: `「${title}」要放去哪一類？🐽`,
    quickReply: {
      items: [
        { type: "action", action: hiddenPostbackAction("🔁 例行", prefix + "routine", "改成例行任務 🔁") },
        { type: "action", action: hiddenPostbackAction("🎯 目標", prefix + "goal", "改成目標任務 🎯") },
        { type: "action", action: hiddenPostbackAction("🧺 日常", prefix + "daily", "改成日常任務 🧺") }
      ]
    }
  };
}

function buildTaskHubMessage() {
  return {
    text: "任務中心來啦🐽✨\n想看哪一區？",
    flex: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🐽 任務中心", weight: "bold", size: "xl" },
          { type: "text", text: "我幫你分成三區，找起來比較快～", wrap: true, size: "sm" },
          {
            type: "button",
            action: hiddenPostbackAction("🔁 例行性任務", "系統：任務分類:routine", "查看例行性任務 🔁")
          },
          {
            type: "button",
            action: hiddenPostbackAction("🎯 目標任務", "系統：任務分類:goal", "查看目標任務 🎯")
          },
          {
            type: "button",
            action: hiddenPostbackAction("🧺 日常任務", "系統：任務分類:daily", "查看日常任務 🧺")
          }
        ]
      }
    }
  };
}

async function listTasksByType(db, uid, type) {
  const meta = {
    routine: { title: "🔁 例行性任務", empty: "目前沒有固定例行任務喔🐽" },
    goal: { title: "🎯 目標任務", empty: "目前沒有目標任務喔🐽" },
    daily: { title: "🧺 日常任務", empty: "目前沒有日常任務喔🐽" }
  }[type];

  const r = await db.prepare(
    "SELECT id,title,due_time,remind_at,recurrence_json FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') AND task_type=? ORDER BY COALESCE(due_time,remind_at,'9999-12-31'), priority ASC LIMIT 12"
  ).bind(uid, type).all();

  const rows = r.results || [];
  if (!rows.length) {
    return {
      text: meta.empty,
      quickReply: {
        items: [{
          type: "action",
          action: hiddenPostbackAction("← 回任務中心", "系統：列出任務", "查看所有任務")
        }]
      }
    };
  }

  const contents = [
    { type: "text", text: meta.title, weight: "bold", size: "xl" },
    { type: "separator", margin: "md" }
  ];

  for (const t of rows.slice(0, 6)) {
    const when = t.remind_at || t.due_time;
    const recur = parseRecurrenceJson(t.recurrence_json);
    const detail = recur
      ? formatRecurrence(recur)
      : (when ? fmtTaipei(when) : "尚未排時間");

    contents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        { type: "text", text: String(t.title || "").slice(0, 40), weight: "bold", wrap: true },
        { type: "text", text: detail, size: "sm", color: "#777777", wrap: true },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("✅ 完成", `系統：完成任務:${t.id}`, `完成「${String(t.title || "").slice(0, 40)}」✅`)
            },
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🧩 卡住", `系統：卡住任務:${t.id}`, `「${String(t.title || "").slice(0, 30)}」卡住了 🧩`)
            }
          ]
        },
        {
          type: "box",
          layout: "horizontal",
          spacing: "sm",
          contents: [
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🏷 分類", `系統：改分類:${t.id}`, `修改「${String(t.title || "").slice(0, 40)}」分類 🏷️`)
            },
            {
              type: "button",
              height: "sm",
              action: hiddenPostbackAction("🗑 刪除", `系統：刪除任務:${t.id}`, `刪除「${String(t.title || "").slice(0, 40)}」🗑️`)
            }
          ]
        }
      ]
    });
  }

  return {
    text: meta.title,
    flex: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents }
    },
    quickReply: {
      items: [{
        type: "action",
        action: hiddenPostbackAction("← 回任務中心", "系統：列出任務", "查看所有任務")
      }]
    }
  };
}

function normalizeTaskIds(taskIds, taskId) {
  const raw = Array.isArray(taskIds) ? taskIds : (taskId !== null && taskId !== undefined ? [taskId] : []);
  return [...new Set(raw.map(Number).filter(Number.isInteger))].slice(0, 50);
}

function normalizeReminderItem(item) {
  if (!item) return item;

  let title = String(item.title || "").trim();
  title = title
    .replace(/^(提醒我|記得提醒我|到時候提醒我|叫我|通知我)\s*/u, "")
    .replace(/^去\s+/u, "去")
    .trim();

  return {
    ...item,
    title: title || String(item.title || "").trim(),
    description: item.description || null,
    first_step: title || String(item.first_step || item.title || "").trim(),
    // A reminder is a point-in-time event, not a 15-minute work block.
    start_time: null,
    due_time: null,
    estimated_minutes: null
  };
}

function applyAiTimeSemantics(item, semantics) {
  if (!item || !semantics || typeof semantics !== "object") return item;

  if (semantics.kind === "relative") {
    const amount = Number(semantics.amount);
    const unit = semantics.unit;
    if (!Number.isFinite(amount) || amount <= 0) return item;

    const unitMs = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000
    }[unit];

    if (!unitMs) return item;
    const when = new Date(Date.now() + amount * unitMs).toISOString();
    return {
      ...item,
      start_time: when,
      due_time: when,
      remind_at: when,
      reason: "AI 負責理解相對時間語意；實際時間由程式精確計算。"
    };
  }

  return item;
}

function validatePlanTimes(item) {
  if (!item) return null;
  const now = Date.now();

  for (const key of ["start_time","due_time","remind_at"]) {
    if (!item[key]) continue;
    const t = new Date(item[key]).getTime();
    if (!Number.isFinite(t)) item[key] = null;
  }

  // Reminders must never be silently scheduled in the past.
  if (item.remind_at && new Date(item.remind_at).getTime() <= now) {
    item.remind_at = null;
  }

  // Due time should not precede start time.
  if (item.start_time && item.due_time) {
    const s = new Date(item.start_time).getTime();
    const d = new Date(item.due_time).getTime();
    if (d < s) item.start_time = null;
  }

  return item;
}


async function resolveReminderIntent(text, env) {
  const source = String(text || "").trim();
  if (!/(提醒|叫我|通知我|記得叫我|到時候)/u.test(source)) return null;

  // 1) Exact relative anchors from the user's own words are authoritative.
  const anchored = parseFlexibleRelativeReminder(source);
  if (anchored) return anchored;

  // 2) Keep fast deterministic parsing for very explicit absolute phrases.
  const deterministic = parseDeterministicReminder(source);
  if (deterministic) return deterministic;

  // 3) Let Gemini understand natural time language, then validate the result.
  const now = new Date();
  const taipeiNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    weekday: "long"
  }).format(now);

  const prompt = `你是一個只負責解析提醒時間的繁體中文時間理解器。
現在台灣時間：${taipeiNow}（${weekday}）
時區固定：Asia/Taipei。

請理解使用者自然語言中的提醒意圖，例如：
「明早八點叫我起床」
「下週五下午提醒我交報告」
「月底前提醒我繳房租」
「今晚睡前提醒我吃藥」
「晚一點提醒我回電話」

只輸出 JSON：
{
  "is_reminder": true,
  "title": "真正要做的事情",
  "remind_at": "ISO8601（必須含 +08:00）或 null",
  "time_is_ambiguous": false,
  "ambiguity_reason": ""
}

規則：
1. 不可輸出過去時間。
2. 明確日期、星期、時段依台灣時間解讀。
3. 「下午3點」= 15:00；「晚上8點」= 20:00。
4. 「三點半」= xx:30。
5. 若只有模糊時段：早上 09:00、下午 15:00、晚上 19:00、睡前 23:00。
6. 「晚一點」預設現在 + 2 小時。
7. 「月底前」若沒有更精確時間，設為本月底 20:00。
8. 無法合理判定才將 remind_at 設 null，絕對不要亂填。
9. title 只保留任務本身，不要包含「提醒我」。

使用者：${source}`;

  let raw;
  try {
    raw = await callGemini(prompt, env, true);
  } catch (err) {
    console.error("Reminder semantic parser failed", {
      name: err?.name || null,
      message: err?.message || String(err)
    });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return null;
  }

  if (!parsed?.is_reminder || !parsed?.title || !parsed?.remind_at) return null;

  const when = new Date(parsed.remind_at);
  if (Number.isNaN(when.getTime())) return null;

  // Safety margin: reject AI outputs that land in the past or essentially "now".
  if (when.getTime() <= Date.now() + 15000) {
    console.warn("Rejected invalid reminder time from Gemini", {
      remind_at: parsed.remind_at,
      source_length: source.length
    });
    return null;
  }

  return {
    title: String(parsed.title).trim().slice(0, 200),
    description: parsed.time_is_ambiguous
      ? `自然語言提醒（採預設時間）：${String(parsed.ambiguity_reason || "").slice(0, 300)}`
      : "自然語言提醒時間已解析並通過台灣時區驗證",
    first_step: String(parsed.title).trim().slice(0, 500),
    priority: 1,
    start_time: when.toISOString(),
    due_time: when.toISOString(),
    remind_at: when.toISOString(),
    estimated_minutes: null,
    reason: parsed.time_is_ambiguous
      ? "時間描述較模糊，使用預設時段並在儲存前讓使用者確認。"
      : "由 AI 理解自然時間語意，程式驗證時區與時間有效性。"
  };
}

function parseFlexibleRelativeReminder(text) {
  const s = String(text || "").trim();

  // 半小時後
  const half = s.match(/半\s*(小時|鐘頭)後(?:到時候)?\s*(?:提醒我|叫我|通知我)\s*(.+)$/u);
  if (half) return buildRelativeReminder(30, "分鐘", half[2], "半小時後");

  // Supports Arabic or common Chinese numbers and minutes/hours/days/weeks.
  const m = s.match(/(\d+(?:\.\d+)?|[零〇一二兩三四五六七八九十百]+)\s*(分鐘|分|小時|鐘頭|天|日|週|星期)後(?:到時候)?\s*(?:提醒我|叫我|通知我)\s*(.+)$/u);
  if (!m) return null;

  const amount = parseNaturalNumber(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = m[2];
  const title = String(m[3] || "").trim().replace(/[。！!]+$/u, "");
  if (!title) return null;

  let ms;
  if (unit === "分鐘" || unit === "分") ms = amount * 60 * 1000;
  else if (unit === "小時" || unit === "鐘頭") ms = amount * 60 * 60 * 1000;
  else if (unit === "天" || unit === "日") ms = amount * 24 * 60 * 60 * 1000;
  else ms = amount * 7 * 24 * 60 * 60 * 1000;

  const when = new Date(Date.now() + ms).toISOString();
  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${m[1]}${unit}後`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "直接依使用者原句中的相對時間計算，不交由 AI 猜測。"
  };
}

function parseNaturalNumber(input) {
  const s = String(input || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);

  const digits = { "零":0, "〇":0, "一":1, "二":2, "兩":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9 };
  if (s === "十") return 10;
  if (s === "百") return 100;

  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in digits) {
      current = digits[ch];
    } else if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else {
      return NaN;
    }
  }
  return total + current;
}

function buildRelativeReminder(amount, unit, rawTitle, rawTimeText) {
  const title = String(rawTitle || "").trim().replace(/[。！!]+$/u, "");
  if (!title) return null;
  const ms = unit === "分鐘"
    ? amount * 60 * 1000
    : amount * 60 * 60 * 1000;
  const when = new Date(Date.now() + ms).toISOString();
  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${rawTimeText}`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "直接依使用者原句中的相對時間計算，不交由 AI 猜測。"
  };
}

function parseDeterministicReminder(text) {
  return parseRelativeReminder(text) || parseAbsoluteReminder(text);
}

function parseAbsoluteReminder(text) {
  const s = String(text || "").trim();

  // Examples:
  // 今天晚上10:50提醒我叫弟弟起床
  // 明天下午3點提醒我交作業
  // 今天 22:30 到時候提醒我洗衣服
  const m = s.match(/^(今天|明天)?\s*(早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{1,2})|點(?:\s*(\d{1,2})\s*分?)?)?\s*(?:到時候)?\s*提醒我\s*(.+)$/u);
  if (!m) return null;

  const dayWord = m[1] || "今天";
  const part = m[2] || "";
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? m[5] ?? 0);
  const title = String(m[6] || "").trim().replace(/[。！!]+$/u, "");

  if (!title || !Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (part === "下午" || part === "晚上") {
    if (hour < 12) hour += 12;
  } else if (part === "中午") {
    if (hour < 11) hour += 12;
  } else if ((part === "早上" || part === "上午") && hour === 12) {
    hour = 0;
  }
  if (hour < 0 || hour > 23) return null;

  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  let y = get("year"), mo = get("month"), d = get("day");

  // Build target using Taipei wall-clock -> UTC by using +08:00 explicitly.
  const base = new Date(`${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}T00:00:00+08:00`);
  if (dayWord === "明天") base.setUTCDate(base.getUTCDate() + 1);

  const targetDate = new Date(base.getTime());
  // base above is midnight Taipei = previous day 16:00Z; adding local hour/minute is safe.
  targetDate.setTime(base.getTime() + hour * 3600000 + minute * 60000);

  // If user said "今天" and target already passed, reject instead of silently scheduling past.
  if (dayWord === "今天" && targetDate.getTime() <= now.getTime()) return null;

  const when = targetDate.toISOString();
  return {
    title: title.slice(0, 200),
    description: `指定時間提醒：${dayWord}${part}${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: "依照使用者指定的絕對時間由程式精準計算，不交由 AI 推算。"
  };
}

function parseChineseNumber(input) {
  const s = String(input || "").trim();
  if (/^\d+$/.test(s)) return Number(s);

  const digitMap = {
    "零": 0, "〇": 0,
    "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? digitMap[a] : 1;
    const ones = b ? digitMap[b] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }

  return digitMap[s] ?? NaN;
}

function parseRelativeReminder(text) {
  const s = String(text || "").trim();
  const m = s.match(/(?:^|\s)(\d+|[零〇一二兩三四五六七八九十]+)\s*(分鐘|小時)後(?:到時候)?\s*提醒我\s*(.+)$/u);
  if (!m) return null;

  const amount = parseChineseNumber(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = m[2];
  const title = m[3].trim().replace(/[。！!]+$/u, "");
  if (!title) return null;

  const ms = unit === "小時" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
  const when = new Date(Date.now() + ms).toISOString();

  return {
    title: title.slice(0, 200),
    description: `相對時間提醒：${m[1]}${unit}後`,
    first_step: title.slice(0, 500),
    priority: 1,
    start_time: when,
    due_time: when,
    remind_at: when,
    estimated_minutes: null,
    reason: `依照使用者指定的「${m[1]}${unit}後」精準計算，不交由 AI 推算。`
  };
}

function sanitizePlanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(x => x && typeof x === "object" && x.title && x.first_step)
    .slice(0, 20)
    .map(x => ({
      title: String(x.title).slice(0, 200),
      description: x.description ? String(x.description).slice(0, 1000) : null,
      first_step: String(x.first_step).slice(0, 500),
      priority: Number.isFinite(Number(x.priority)) ? Math.min(5, Math.max(1, Number(x.priority))) : 3,
      start_time: normalizeIso(x.start_time),
      due_time: normalizeIso(x.due_time),
      remind_at: normalizeIso(x.remind_at),
      estimated_minutes: x.estimated_minutes !== null && x.estimated_minutes !== undefined && x.estimated_minutes !== "" && Number.isFinite(Number(x.estimated_minutes))
        ? Math.max(1, Math.round(Number(x.estimated_minutes)))
        : null,
      recurrence: sanitizeRecurrence(x.recurrence),
      task_type: ["routine","goal","daily"].includes(String(x.task_type || "").toLowerCase())
        ? String(x.task_type).toLowerCase()
        : (x.recurrence ? "routine" : "daily"),
      reason: x.reason ? String(x.reason).slice(0, 500) : ""
    }));
}

function sanitizeTaskType(v, recurrence = null) {
  if (recurrence) return "routine";
  const type = String(v || "").toLowerCase();
  return ["routine","goal","daily"].includes(type) ? type : "daily";
}

function sanitizeRecurrence(v) {
  if (!v || typeof v !== "object") return null;
  const freq = String(v.freq || "").toLowerCase();
  if (!["daily","weekly","monthly"].includes(freq)) return null;

  const interval = Math.max(1, Math.min(365, Number(v.interval) || 1));
  const weekdays = Array.isArray(v.weekdays)
    ? [...new Set(v.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
    : [];
  const dayOfMonth = Number.isInteger(Number(v.day_of_month))
    ? Math.max(1, Math.min(31, Number(v.day_of_month)))
    : null;
  const time = /^\d{2}:\d{2}$/.test(String(v.time || "")) ? String(v.time) : null;
  const until = normalizeIso(v.until);

  return { freq, interval, weekdays, day_of_month: dayOfMonth, time, until };
}

function normalizeIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function taskTypeLabel(type) {
  return {
    routine: "🔁 例行",
    goal: "🎯 目標",
    daily: "🧺 日常"
  }[type] || "🧺 日常";
}

function formatPlan(items) {
  return items.map((x, i) => {
    const bits = [
      `${i + 1}. ${x.title}`,
      `分類 ${taskTypeLabel(x.task_type)}`,
      x.start_time ? `開始 ${fmtTaipei(x.start_time)}` : null,
      x.due_time ? `截止 ${fmtTaipei(x.due_time)}` : null,
      x.remind_at ? `提醒 ${fmtTaipei(x.remind_at)}` : null,
      x.recurrence ? `重複 ${formatRecurrence(x.recurrence)}` : null,
      x.estimated_minutes ? `${x.estimated_minutes} 分鐘` : null
    ].filter(Boolean);
    return bits.join("｜") + (x.reason ? `\n   原因：${x.reason}` : "");
  }).join("\n");
}

function formatRecurrence(r) {
  if (!r) return "";
  const dayNames = ["日","一","二","三","四","五","六"];
  if (r.freq === "daily") return `每${r.interval > 1 ? r.interval : ""}天${r.time ? " " + r.time : ""}`;
  if (r.freq === "weekly") {
    const days = (r.weekdays || []).map(d => "週" + dayNames[d]).join("、");
    return `每${r.interval > 1 ? r.interval : ""}週${days ? " " + days : ""}${r.time ? " " + r.time : ""}`;
  }
  if (r.freq === "monthly") return `每${r.interval > 1 ? r.interval : ""}月${r.day_of_month ? " " + r.day_of_month + "號" : ""}${r.time ? " " + r.time : ""}`;
  return "";
}

function fmtTaipei(v) {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(v));
  } catch {
    return String(v);
  }
}

async function interpretStructured(message, context, env) {
  const now = new Date();
  const taipeiNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    weekday: "long"
  }).format(now);

  const prompt = `你是繁體中文的「可愛豬豬小秘書 🐽」。
你的工作是把自然語言待辦整理成可以執行的計畫。

說話人格：
- 語氣可愛、親近、自然，像一隻認真幫忙的豬豬小秘書。
- 可以適度使用 🐽、✨、📌、⏰、🙈 等 emoji，但不要每句都塞。
- 回覆要短、清楚、有行動感，不要幼稚、不裝可憐、不過度撒嬌。
- 優先用「我幫你整理好了」「這個我先幫你排著」「做完啦🐽✨」這種自然口吻。
- 不要使用過度正式的敬語，例如「您好、請問您、為您安排」；改成「好呀」「我幫你」「你可以」。
- 不要講技術術語、資料庫、intent、模型、系統內部邏輯。
- 如果需要確認，就像秘書一樣直接問，不要長篇解釋。
- 如果時間或指令不確定，要誠實說「這個時間我還不敢直接幫你定，想再確認一下🐽」之類的自然說法。

你的工作是把自然語言待辦整理成可以執行的計畫。

現在台灣時間：${taipeiNow}（${weekday}）
時區：Asia/Taipei

現有待辦：
${context || "目前沒有"}

規則：
1. 使用者一次給多個任務時，全部處理。
2. 找出依賴關係、優先順序、第一步、合理開始時間與截止時間。first_step 必須是 2–10 分鐘內能立刻開始、可觀察完成的動作，不可只是把原任務換句話說。
3. 不要假裝資料已經儲存；你只能提出方案。
4. 若資訊不足，不要亂編固定行程；可以用合理建議，但要保守。
5. 僅輸出 JSON，不要 markdown。
6. 所有「今天、明天、後天、週幾、本週、下週、月底」都必須以「現在台灣時間」換算成正確的台灣日期，不能用 UTC 日期直接推算。
7. 「下午」預設代表 13:00–17:59；若使用者只說下午，不要排到晚上。
8. 「週五前」代表最晚必須在本週五當天完成，不可排到週六或週日；若今天已經是週五，則視情況安排今天完成。
9. 若使用者明確給截止日，due_time 不得晚於該截止日。
10. 所有自然語言意圖都由你判斷，不要求使用者記固定指令。例：「都刪掉」「清空一下」「這些不要了」可判斷為 delete_all_tasks；「把叫弟弟起床那個刪掉」為 delete_task；「這個做完了」為 complete_task。
11. delete_task / complete_task 必須根據「現有待辦」選出真正存在的 task id。不可自行捏造 id。找不到唯一對應時，task_ids 留空，reply 說明需要使用者再指明。
12. delete_all_tasks 只代表使用者要移除目前全部待辦，不要建立一個名為「刪除全部任務」的新任務。
13. 使用者說「把 X 改成目標/日常/例行」等已儲存任務分類調整時，intent=change_task_type，從現有待辦選 task_id/task_ids，並填頂層 task_type。不要重新建立任務。
14. 使用者是在要求提醒時，intent 使用 create_reminder，並在 plan_items 中輸出真正的任務名稱與 remind_at。title 只寫行動本身，例如「去洗澡」，不要寫「提醒我去洗澡」。提醒型任務的 start_time、due_time、estimated_minutes 一律設 null。
15. 時間解析一律以 Asia/Taipei 為準.相對時間（例如「兩分鐘後」「半小時後」「三天後」）必須以現在台灣時間精確相加。
15. 若使用者只是說「完成」「好了」「做完了」，優先參考現有任務與最近上下文判斷；若無法唯一判定，不要猜 task id。
16. 若提醒時間是相對時間，例如「兩分鐘後」「半小時後」「1.5 小時後」「三天後」，你負責理解並填 time_semantics；不要自己做最終時間算術。kind=relative，amount 填數值（半小時 = 30 minute），unit 只能是 minute|hour|day|week。
17. 若是絕對時間，例如「明早八點」「下週五下午三點」，kind=absolute，remind_at 仍輸出含 +08:00 的 ISO8601。
18. 修改尚未確認的方案時，intent=revise_plan，必須依「尚未確認的方案」輸出完整修正版 plan_items，而不是新增另一份無關任務。
19. 使用者描述固定課表、每週、每天、每月、固定週期時，可以在 plan_items.recurrence 填週期設定；不要把未來每一次全部展開成很多筆任務。
20. 使用者一次給多項行程時，你仍要先幫他比較衝突、優先順序、空檔與負荷，必要時提出較合理的時間安排；除非使用者明確要求立即建立，否則先提出完整方案讓他確認。
21. recurrence 格式：freq 只能 daily|weekly|monthly；weekdays 用 0=週日...6=週六；time 用 HH:MM；monthly 可用 day_of_month。
22. 每個 plan_item 都必須分類 task_type：
- routine：固定課表、每天/每週/每月重複、固定習慣。
- goal：報告、考試準備、專案、申請、長期目標或需要多步驟推進的任務。
- daily：洗衣、洗澡、拿包裹、回電話、單次生活雜事。
若有 recurrence，task_type 必須是 routine。
22. 每個任務都要分類 task_type：routine=固定重複的例行任務/課表/固定習慣；goal=有成果、截止或需要多步驟推進的目標/報告/專案；daily=一次性的日常瑣事，例如洗衣、洗澡、拿包裹。
23. 有 recurrence 的任務原則上 task_type=routine。
24. 對大型、模糊或容易拖延的目標，優先降低啟動門檻：第一步只要求開始，不要求一次完成整個成果。避免責備、羞辱、罪惡感或「應該更自律」式語氣。

JSON schema：
{
  "intent": "chat|propose_plan|revise_plan|create_reminder|list_tasks|complete_task|delete_task|delete_all_tasks|change_task_type",
  "reply": "給使用者看的繁體中文文字",
  "task_id": 3,
  "task_ids": [3, 7],
  "task_type": "routine|goal|daily 或 null",
  "time_semantics": {
    "kind": "relative|absolute|none",
    "amount": 2,
    "unit": "minute|hour|day|week"
  },
  "plan_items": [
    {
      "title": "任務名稱",
      "description": "補充",
      "first_step": "最小可執行第一步",
      "priority": 1,
      "start_time": "ISO8601 或 null",
      "due_time": "ISO8601 或 null",
      "remind_at": "ISO8601 或 null",
      "estimated_minutes": 60,
      "task_type": "routine|goal|daily",
      "recurrence": {
        "freq": "weekly",
        "interval": 1,
        "weekdays": [1,3,5],
        "day_of_month": null,
        "time": "09:00",
        "until": null
      },
      "reason": "排序理由"
    }
  ]
}

使用者：
${message}`;

  let raw;
  try {
    raw = await callGemini(prompt, env, true);
  } catch (jsonErr) {
    console.error("Structured Gemini JSON mode failed, retrying plain mode", String(jsonErr));
    try {
      raw = await callGemini(prompt, env, false);
    } catch (plainErr) {
      console.error("Structured Gemini plain mode also failed", String(plainErr));
      return buildLocalFallback(message);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      console.error("Gemini returned non-JSON content; using local fallback");
      return buildLocalFallback(message);
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      console.error("Gemini JSON parse failed; using local fallback");
      return buildLocalFallback(message);
    }
  }

  const allowed = new Set(["chat","propose_plan","revise_plan","create_reminder","list_tasks","complete_task","delete_task","delete_all_tasks","change_task_type"]);
  if (!allowed.has(parsed.intent)) parsed.intent = "chat";
  if (typeof parsed.reply !== "string") parsed.reply = "";
  if (!["routine","goal","daily"].includes(parsed.task_type)) parsed.task_type = null;
  if (!Array.isArray(parsed.task_ids)) parsed.task_ids = [];
  parsed.task_ids = parsed.task_ids.map(Number).filter(Number.isInteger).slice(0, 50);
  if (parsed.task_id !== null && parsed.task_id !== undefined) {
    const n = Number(parsed.task_id);
    parsed.task_id = Number.isInteger(n) ? n : null;
  } else {
    parsed.task_id = null;
  }

  if (!parsed.time_semantics || typeof parsed.time_semantics !== "object") {
    parsed.time_semantics = { kind: "none", amount: null, unit: null };
  }
  const allowedTimeKinds = new Set(["relative","absolute","none"]);
  if (!allowedTimeKinds.has(parsed.time_semantics.kind)) parsed.time_semantics.kind = "none";
  if (parsed.time_semantics.kind === "relative") {
    parsed.time_semantics.amount = Number(parsed.time_semantics.amount);
    if (!Number.isFinite(parsed.time_semantics.amount) || parsed.time_semantics.amount <= 0) {
      parsed.time_semantics.kind = "none";
    }
    if (!["minute","hour","day","week"].includes(parsed.time_semantics.unit)) {
      parsed.time_semantics.kind = "none";
    }
  }
  return parsed;
}

function buildLocalFallback(message) {
  const normalized = String(message || "")
    .replace(/^幫我安排[:：]?/u, "")
    .replace(/^幫我整理[:：]?/u, "")
    .trim();

  const parts = normalized
    .split(/[、，,；;\n]+/u)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 10);

  if (!parts.length) {
    return {
      intent: "chat",
      reply: "我有收到訊息，但 AI 暫時不穩。你可以直接把待辦一項一項列給我，我會先用保底模式整理。",
      task_id: null,
      plan_items: []
    };
  }

  const items = parts.map((p, i) => ({
    title: p.slice(0, 120),
    description: null,
    first_step: "先花 5 分鐘確認下一個最小可執行動作",
    priority: Math.min(5, i + 1),
    start_time: null,
    due_time: null,
    remind_at: null,
    estimated_minutes: null,
    reason: "AI 暫時不可用，先依輸入順序建立保底方案；之後可再調整時間與優先順序。"
  }));

  return {
    intent: "propose_plan",
    reply: "Gemini 目前回應不穩，我先用保底模式把任務整理出來，避免整段失敗。",
    task_id: null,
    plan_items: items
  };
}

async function interpretPlainText(message, env) {
  const prompt = `你是繁體中文的可愛豬豬小秘書 🐽。
使用者會輸入待辦、期限、安排需求或一般問題。
請用繁體中文直接、精簡、自然回答。
語氣可愛但不要幼稚，適度用 🐽✨📌⏰，不要每句都塞 emoji。
避免過度正式敬語，像熟悉的貼身小秘書一樣說話。
若使用者一次給多個任務，請幫他排序並提出合理的下一步。
不要假裝已儲存、已提醒或已建立任務，除非系統真的執行了資料寫入。

使用者：
${message}`;
  return callGemini(prompt, env, false);
}

async function callGemini(prompt, env, jsonMode) {
  const configured = String(
    env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite"
  )
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  // Keep order stable and deduplicated.
  const models = [...new Set(configured)].slice(0, 3);
  const backoffMs = [300, 800];
  const maxAttemptsPerModel = 2;
  const failures = [];

  for (const model of models) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      try {
        const text = await executeGeminiFetch(model, prompt, env, jsonMode);

        console.log("Gemini resilient call succeeded", {
          model,
          attempt
        });

        return text.slice(0, 9000);
      } catch (err) {
        const status = Number(err?.status || 0) || null;
        const retryAfterMs = Number(err?.retryAfterMs || 0) || null;
        const transient = status === 503 || status === 429 || err?.name === "AbortError";

        failures.push({
          model,
          attempt,
          status,
          name: err?.name || null,
          message: String(err?.message || err).slice(0, 300)
        });

        console.warn("Gemini resilient attempt failed", {
          model,
          attempt,
          status,
          transient,
          retry_after_ms: retryAfterMs
        });

        // Permanent client/auth errors should not be retried across models.
        if ([400, 401, 403].includes(status)) {
          console.error("Gemini permanent error; aborting failover", {
            model,
            status
          });
          throw err;
        }

        const hasAnotherAttempt = attempt < maxAttemptsPerModel;
        if (transient && hasAnotherAttempt) {
          let delay = backoffMs[attempt - 1] || 1000;

          // Respect Retry-After for 429 when present, but cap it so the bot
          // does not feel frozen for a very long time.
          if (status === 429 && retryAfterMs) {
            delay = Math.min(Math.max(delay, retryAfterMs), 5000);
          }

          await sleep(delay);
          continue;
        }

        // Move to the next model after retries are exhausted or for
        // non-permanent errors that may be model-specific.
        break;
      }
    }
  }

  const finalError = new Error("All Gemini models failed after retry and failover");
  finalError.failures = failures;
  console.error("All Gemini models exhausted", { failures });
  throw finalError;
}

async function executeGeminiFetch(model, prompt, env, jsonMode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: jsonMode ? 1200 : 900
    };
    if (jsonMode) generationConfig.responseMimeType = "application/json";

    const started = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig
        }),
        signal: controller.signal
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = parseRetryAfterMs(retryAfter);

      const err = new Error(`${model} -> ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      err.retryAfterMs = retryAfterMs;

      console.error("Gemini HTTP error", {
        model,
        status: res.status,
        elapsed_ms: Date.now() - started,
        retry_after_ms: retryAfterMs,
        detail: detail.slice(0, 500)
      });

      throw err;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map(p => p?.text || "")
      .join("")
      .trim();

    if (!text) {
      const err = new Error(`${model} returned empty response`);
      err.status = 502;
      throw err;
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripFence(text) {
  return String(text || "")
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "")
    .trim();
}

async function ensureSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      line_user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS pending_plans (
      line_user_id TEXT PRIMARY KEY,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      first_step TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      start_time TEXT,
      due_time TEXT,
      remind_at TEXT,
      estimated_minutes INTEGER,
      recurrence_json TEXT,
      task_type TEXT NOT NULL DEFAULT 'daily',
      stuck_count INTEGER NOT NULL DEFAULT 0,
      last_barrier TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reminder_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      line_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_value TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_checkins (
      line_user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      mood TEXT,
      emotion_tag TEXT,
      sent_at TEXT,
      responded_at TEXT,
      PRIMARY KEY(line_user_id, date_key)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(line_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_time)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at)`
  ];

  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

async function rememberEvent(db, eventId) {
  const r = await db.prepare(
    "INSERT OR IGNORE INTO webhook_events(event_id) VALUES (?)"
  ).bind(eventId).run();
  return Number(r?.meta?.changes || 0) > 0;
}

async function ensureUser(db, uid) {
  await db.prepare(
    `INSERT INTO users(line_user_id,updated_at)
     VALUES (?,CURRENT_TIMESTAMP)
     ON CONFLICT(line_user_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`
  ).bind(uid).run();
}

async function getPendingPlan(db, uid) {
  const row = await db.prepare(
    "SELECT plan_json FROM pending_plans WHERE line_user_id=?"
  ).bind(uid).first();
  if (!row?.plan_json) return null;
  try { return JSON.parse(row.plan_json); } catch { return null; }
}

async function setPendingPlan(db, uid, data) {
  await db.prepare(
    "INSERT INTO pending_plans(line_user_id,plan_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(line_user_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=CURRENT_TIMESTAMP"
  ).bind(uid, JSON.stringify(data)).run();
}

async function clearPendingPlan(db, uid) {
  await db.prepare("DELETE FROM pending_plans WHERE line_user_id=?").bind(uid).run();
}

async function savePlanTasks(db, uid, items) {
  const clean = sanitizePlanItems(items);
  if (!clean.length) return 0;
  const stmts = clean.map(x => db.prepare(
    `INSERT INTO tasks(
      line_user_id,title,description,first_step,priority,start_time,due_time,remind_at,estimated_minutes,recurrence_json,task_type,status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`
  ).bind(
    uid, x.title, x.description, x.first_step, x.priority,
    x.start_time, x.due_time, x.remind_at, x.estimated_minutes,
    x.recurrence ? JSON.stringify(x.recurrence) : null,
    x.task_type
  ));
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + Number(r?.meta?.changes || 0), 0);
}

async function activeTasksContext(db, uid) {
  const r = await db.prepare(
    "SELECT id,title,status,start_time,due_time,first_step,task_type,stuck_count,last_barrier FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') ORDER BY COALESCE(due_time,'9999-12-31'), priority ASC LIMIT 40"
  ).bind(uid).all();
  return (r.results || []).map(t =>
    `id=${t.id};title=${t.title};type=${t.task_type || "daily"};status=${t.status};stuck=${Number(t.stuck_count || 0)};barrier=${t.last_barrier || ""};start=${t.start_time || ""};due=${t.due_time || ""};first_step=${t.first_step || ""}`
  ).join("\n");
}

function taskHubMessage() {
  return {
    text: "想看哪一區呀？🐽✨",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "🔁 例行任務", text: "系統：任務分類:routine" } },
        { type: "action", action: { type: "message", label: "🎯 目標任務", text: "系統：任務分類:goal" } },
        { type: "action", action: { type: "message", label: "🧺 日常任務", text: "系統：任務分類:daily" } }
      ]
    }
  };
}

async function listTasksText(db, uid, taskType = null) {
  const r = await db.prepare(
    taskType
      ? "SELECT id,title,status,due_time,remind_at,task_type FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') AND task_type=? ORDER BY COALESCE(due_time,remind_at,'9999-12-31'), priority ASC LIMIT 20"
      : "SELECT id,title,status,due_time,remind_at FROM tasks WHERE line_user_id=? AND status IN ('pending','paused') ORDER BY COALESCE(due_time,remind_at,'9999-12-31'), priority ASC LIMIT 20"
  );
  const query = taskType ? r.bind(uid, taskType) : r.bind(uid);
  const result = await query.all();

  const rows = result.results || [];
  if (!rows.length) {
    const names = { routine: "例行任務", goal: "目標任務", daily: "日常任務" };
    return taskType ? `${names[taskType]}目前空空的🐽✨` : "現在沒有待辦啦🐽✨";
  }

  const now = Date.now();
  const todayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const buckets = { overdue: [], today: [], later: [], anytime: [] };

  for (const t of rows) {
    const rawTime = t.due_time || t.remind_at || null;
    const when = rawTime ? new Date(rawTime) : null;
    const item = {
      id: Number(t.id),
      title: String(t.title || "").trim(),
      time: when && !Number.isNaN(when.getTime()) ? when : null
    };

    if (!item.time) {
      buckets.anytime.push(item);
      continue;
    }

    const itemKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(item.time);

    if (item.time.getTime() < now) buckets.overdue.push(item);
    else if (itemKey === todayKey) buckets.today.push(item);
    else buckets.later.push(item);
  }

  const formatItem = (item, showDate) => {
    const timeText = item.time
      ? new Intl.DateTimeFormat("zh-TW", {
          timeZone: "Asia/Taipei",
          ...(showDate ? { month: "2-digit", day: "2-digit" } : {}),
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(item.time)
      : null;

    return `• ${item.title}${timeText ? `　${timeText}` : ""}`;
  };

  const sections = [];
  if (buckets.overdue.length) {
    sections.push("🥺 過期了\n" + buckets.overdue.map(x => formatItem(x, true)).join("\n"));
  }
  if (buckets.today.length) {
    sections.push("🌤 今天\n" + buckets.today.map(x => formatItem(x, false)).join("\n"));
  }
  if (buckets.later.length) {
    sections.push("📅 接下來\n" + buckets.later.map(x => formatItem(x, true)).join("\n"));
  }
  if (buckets.anytime.length) {
    sections.push("🐽 還沒排時間\n" + buckets.anytime.map(x => formatItem(x, false)).join("\n"));
  }

  const top = rows.slice(0, 4);
  const quickItems = [];
  for (const t of top) {
    const short = String(t.title || "").trim().slice(0, 8);
    quickItems.push({
      type: "action",
      action: hiddenPostbackAction(
        `✅ ${short}`.slice(0, 20),
        `系統：完成任務:${t.id}`,
        `完成「${short}」✅`
      )
    });
    quickItems.push({
      type: "action",
      action: hiddenPostbackAction(
        `🗑️ ${short}`.slice(0, 20),
        `系統：刪除任務:${t.id}`,
        `刪除「${short}」🗑️`
      )
    });
  }

  const categoryNames = { routine: "🔁 例行任務", goal: "🎯 目標任務", daily: "🧺 日常任務" };
  return {
    text: (taskType ? categoryNames[taskType] : "這些還在等你喔🐽") + "\n\n" + sections.join("\n\n"),
    quickReply: { items: quickItems.slice(0, 13) }
  };
}

async function ensureReminderColumn(db) {
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN reminder_sent_at TEXT").run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

async function ensureRecurrenceColumn(db) {
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN recurrence_json TEXT").run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

async function ensureTaskTypeColumn(db) {
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'daily'").run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

async function ensureBehaviorColumns(db) {
  const alters = [
    "ALTER TABLE tasks ADD COLUMN stuck_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN last_barrier TEXT"
  ];
  for (const sql of alters) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
}

async function logTaskEvent(db, taskId, uid, type, value = null) {
  try {
    await db.prepare("INSERT INTO task_events(task_id,line_user_id,event_type,event_value) VALUES (?,?,?,?)")
      .bind(taskId, uid, type, value).run();
  } catch (err) {
    console.warn("Task event log failed", { task_id: taskId, type, message: String(err?.message || err) });
  }
}

function taipeiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}

function taipeiDayBoundsUtc(dateKey) {
  const start = new Date(`${dateKey}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function processEveningCheckins(env, scheduledTime) {
  if (!env.DB || !env.CHANNEL_ACCESS_TOKEN) return;

  const now = new Date(scheduledTime || Date.now());
  const local = taipeiDateParts(now);

  // 10-minute retry window so a transient LINE failure can recover.
  if (local.hour !== 22 || local.minute < 30 || local.minute > 39) return;

  await ensureSchema(env.DB);
  const { start, end } = taipeiDayBoundsUtc(local.dateKey);

  const users = await env.DB.prepare(
    `SELECT line_user_id FROM users
     WHERE updated_at >= datetime('now','-30 day')
     ORDER BY updated_at DESC
     LIMIT 200`
  ).all();

  for (const row of (users.results || [])) {
    const uid = row.line_user_id;
    if (!uid) continue;

    const existing = await env.DB.prepare(
      "SELECT sent_at FROM daily_checkins WHERE line_user_id=? AND date_key=?"
    ).bind(uid, local.dateKey).first();
    if (existing?.sent_at) continue;

    const completed = await env.DB.prepare(
      `SELECT title FROM tasks
       WHERE line_user_id=? AND status='completed'
         AND updated_at >= ? AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 8`
    ).bind(uid, start, end).all();

    const titles = (completed.results || [])
      .map(x => String(x.title || "").trim())
      .filter(Boolean);

    const summary = titles.length
      ? ["今天你完成了：", ...titles.slice(0, 5).map(x => `✅ ${x}`), titles.length > 5 ? `還有 ${titles.length - 5} 件 ✨` : null]
          .filter(Boolean).join("\n")
      : "今天沒有需要用完成數量證明什麼。能走到一天尾聲，就先讓自己收工一下🐽";

    const message = {
      text: `今天辛苦啦🐽\n\n${summary}\n\n今天整體感覺怎麼樣？`,
      quickReply: {
        items: [
          { type: "action", action: hiddenPostbackAction("😄 很不錯", `系統：晚間心情:${local.dateKey}:great`, "😄 今天很不錯") },
          { type: "action", action: hiddenPostbackAction("🙂 還可以", `系統：晚間心情:${local.dateKey}:good`, "🙂 今天還可以") },
          { type: "action", action: hiddenPostbackAction("😐 普通", `系統：晚間心情:${local.dateKey}:neutral`, "😐 今天普通") },
          { type: "action", action: hiddenPostbackAction("😮‍💨 有點累", `系統：晚間心情:${local.dateKey}:tired`, "😮‍💨 今天有點累") },
          { type: "action", action: hiddenPostbackAction("😞 很低落", `系統：晚間心情:${local.dateKey}:low`, "😞 今天很低落") }
        ]
      }
    };

    try {
      await pushLine(uid, message, env.CHANNEL_ACCESS_TOKEN);
      await env.DB.prepare(
        `INSERT INTO daily_checkins(line_user_id,date_key,sent_at)
         VALUES (?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(line_user_id,date_key) DO UPDATE SET sent_at=COALESCE(daily_checkins.sent_at,excluded.sent_at)`
      ).bind(uid, local.dateKey).run();
    } catch (err) {
      console.error("Evening check-in push failed", {
        date_key: local.dateKey,
        name: err?.name || null,
        message: err?.message || String(err)
      });
    }
  }
}

async function processDueReminders(env, scheduledTime) {
  if (!env.DB || !env.CHANNEL_ACCESS_TOKEN) return;

  await ensureSchema(env.DB);
  await ensureReminderColumn(env.DB);

  const now = new Date(scheduledTime || Date.now()).toISOString();
  const due = await env.DB.prepare(
    `SELECT id,line_user_id,title,due_time,remind_at,recurrence_json
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND remind_at <= ?
       AND reminder_sent_at IS NULL
     ORDER BY remind_at ASC
     LIMIT 50`
  ).bind(now).all();

  for (const task of (due.results || [])) {
    const text = {
      text: [
        `📌 ${task.title}`,
        task.due_time ? `⏰ 截止：${fmtTaipei(task.due_time)}` : null,
        "",
        "做完就直接按下面 👇"
      ].filter(x => x !== null).join("\n"),
      quickReply: {
        items: [
          {
            type: "action",
            action: hiddenPostbackAction("完成了✅", `系統：完成任務:${task.id}`, `完成「${String(task.title || "").slice(0, 40)}」✅`)
          },
          {
            type: "action",
            action: hiddenPostbackAction("卡住了🧩", `系統：卡住任務:${task.id}`, `「${String(task.title || "").slice(0, 30)}」卡住了 🧩`)
          }
        ]
      }
    };

    try {
      await pushLine(task.line_user_id, text, env.CHANNEL_ACCESS_TOKEN);
      await logTaskEvent(env.DB, Number(task.id), task.line_user_id, "reminder_sent", task.remind_at || null);
      const recurrence = parseRecurrenceJson(task.recurrence_json);
      const next = recurrence ? computeNextOccurrence(task.remind_at, recurrence) : null;

      if (next) {
        await env.DB.prepare(
          "UPDATE tasks SET remind_at=?, due_time=?, reminder_sent_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(next, next, task.id).run();
      } else {
        await env.DB.prepare(
          "UPDATE tasks SET reminder_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(task.id).run();
      }
      console.log("Reminder pushed", { task_id: task.id });
    } catch (err) {
      console.error("Reminder push failed", {
        task_id: task.id,
        name: err?.name || null,
        message: err?.message || String(err)
      });
    }
  }
}

function parseRecurrenceJson(v) {
  if (!v) return null;
  try { return sanitizeRecurrence(JSON.parse(v)); } catch { return null; }
}

function computeNextOccurrence(currentIso, r) {
  const current = new Date(currentIso);
  if (Number.isNaN(current.getTime()) || !r) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(current);
  const get = t => Number(parts.find(p => p.type === t)?.value);
  const [hh, mm] = String(r.time || "09:00").split(":").map(Number);
  let base = new Date(`${get("year")}-${String(get("month")).padStart(2,"0")}-${String(get("day")).padStart(2,"0")}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00+08:00`);

  let next = null;
  if (r.freq === "daily") {
    next = new Date(base.getTime() + r.interval * 86400000);
  } else if (r.freq === "weekly") {
    const days = (r.weekdays || []).length ? r.weekdays : [base.getUTCDay()];
    for (let offset = 1; offset <= 7 * r.interval + 7; offset++) {
      const cand = new Date(base.getTime() + offset * 86400000);
      const taipeiDow = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", weekday: "short" })
        .formatToParts(cand).find(p => p.type === "weekday") ? cand.toLocaleString("en-US",{timeZone:"Asia/Taipei",weekday:"short"}) : "");
      const jsDow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(cand.toLocaleString("en-US",{timeZone:"Asia/Taipei",weekday:"short"}));
      if (days.includes(jsDow)) { next = cand; break; }
    }
  } else if (r.freq === "monthly") {
    const target = new Date(base.getTime());
    target.setUTCMonth(target.getUTCMonth() + r.interval);
    if (r.day_of_month) {
      const y = Number(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric"}).format(target));
      const m = Number(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",month:"2-digit"}).format(target));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = Math.min(r.day_of_month, last);
      next = new Date(`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00+08:00`);
    } else next = target;
  }

  if (!next || Number.isNaN(next.getTime())) return null;
  if (r.until && next.getTime() > new Date(r.until).getTime()) return null;
  return next.toISOString();
}

function buildCompletionMessage(task, env) {
  const base = String(
    env.PUBLIC_BASE_URL || "https://time-ai-assistant.410350515gin.workers.dev"
  ).replace(/\/$/, "");
  const index = Math.floor(Math.random() * REWARD_IMAGES_BASE64.length) + 1;

  return {
    text: `做完啦！🐽✨\n${task.title}\n這項我幫你收掉了。`,
    rewardImageUrl: `${base}/reward-images/${index}.jpg`
  };
}

function withDeleteActions(text) {
  return {
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "確定刪除🗑️", text: "好呀🐽" }
        },
        {
          type: "action",
          action: { type: "message", label: "先不要🙈", text: "先不要🙈" }
        }
      ]
    }
  };
}

function withPlanActions(text, allowCategoryChange = false) {
  const items = [
    {
      type: "action",
      action: { type: "message", label: "好呀🐽", text: "好呀🐽" }
    }
  ];

  if (allowCategoryChange) {
    items.push({
      type: "action",
      action: hiddenPostbackAction("🏷️ 改分類", "系統：改待確認分類", "修改分類 🏷️")
    });
  }

  items.push(
    {
      type: "action",
      action: { type: "message", label: "我要改✏️", text: "我要改✏️" }
    },
    {
      type: "action",
      action: { type: "message", label: "先不要🙈", text: "先不要🙈" }
    }
  );

  return { text, quickReply: { items } };
}

function messageText(message) {
  if (message && typeof message === "object") return String(message.text || "");
  return String(message || "");
}

function toLineTextMessage(message) {
  if (message && typeof message === "object") {
    const out = {
      type: "text",
      text: String(message.text || "").slice(0, 5000)
    };
    if (message.quickReply) out.quickReply = message.quickReply;
    return out;
  }
  return { type: "text", text: String(message || "").slice(0, 5000) };
}

function toLineMessages(message) {
  const messages = [];

  if (message && typeof message === "object" && message.flex) {
    messages.push({
      type: "flex",
      altText: String(message.text || "任務中心").slice(0, 400),
      contents: message.flex,
      ...(message.quickReply ? { quickReply: message.quickReply } : {})
    });
  } else {
    messages.push(toLineTextMessage(message));
  }

  if (message && typeof message === "object" && message.rewardImageUrl) {
    messages.push({
      type: "image",
      originalContentUrl: message.rewardImageUrl,
      previewImageUrl: message.rewardImageUrl
    });
  }
  return messages;
}

async function pushLine(to, text, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      to,
      messages: toLineMessages(text)
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE push ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function replyLine(replyToken, text, accessToken) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: toLineMessages(text)
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE reply ${res.status}: ${detail.slice(0, 300)}`);
  }
}

let richMenuReadyInIsolate = false;

async function ensurePigRichMenu(env) {
  if (richMenuReadyInIsolate) return;

  await ensureSchema(env.DB);
  const saved = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key='default_rich_menu_id'"
  ).first();

  if (saved?.value) {
    richMenuReadyInIsolate = true;
    return;
  }

  const auth = { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` };

  // Reuse an existing menu with the same name if a prior setup partially succeeded.
  const listRes = await fetch("https://api.line.me/v2/bot/richmenu/list", {
    headers: auth
  });
  if (!listRes.ok) {
    const detail = await listRes.text();
    throw new Error(`LINE rich menu list ${listRes.status}: ${detail.slice(0, 200)}`);
  }

  const list = await listRes.json();
  let richMenuId = (list.richmenus || []).find(x => x.name === "Pig Secretary Task Book")?.richMenuId || null;

  if (!richMenuId) {
    const createRes = await fetch("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: { ...auth, ...JSON_HEADERS },
      body: JSON.stringify({
        size: { width: 2500, height: 843 },
        selected: true,
        name: "Pig Secretary Task Book",
        chatBarText: "🐽 任務本",
        areas: [{
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: {
            type: "message",
            label: "查看所有任務",
            text: "系統：任務首頁"
          }
        }]
      })
    });

    if (!createRes.ok) {
      const detail = await createRes.text();
      throw new Error(`LINE rich menu create ${createRes.status}: ${detail.slice(0, 300)}`);
    }

    const created = await createRes.json();
    richMenuId = created.richMenuId;

    const png = await buildPigRichMenuPng();
    const uploadRes = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "image/png"
        },
        body: png
      }
    );

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      throw new Error(`LINE rich menu image upload ${uploadRes.status}: ${detail.slice(0, 300)}`);
    }
  }

  const defaultRes = await fetch(
    `https://api.line.me/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    { method: "POST", headers: auth }
  );

  if (!defaultRes.ok) {
    const detail = await defaultRes.text();
    throw new Error(`LINE default rich menu ${defaultRes.status}: ${detail.slice(0, 300)}`);
  }

  await env.DB.prepare(
    "INSERT INTO app_settings(key,value,updated_at) VALUES('default_rich_menu_id',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
  ).bind(richMenuId).run();

  richMenuReadyInIsolate = true;
  console.log("Pig task Rich Menu ready", { richMenuId });
}

async function buildPigRichMenuPng() {
  const width = 2500;
  const height = 843;
  const stride = 1 + width * 3;
  const raw = new Uint8Array(stride * height);

  // Soft pink background.
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = 255;
      raw[p + 1] = 241;
      raw[p + 2] = 244;
    }
  }

  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const p = y * stride + 1 + x * 3;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
  };

  const circle = (cx, cy, radius, color) => {
    const [r,g,b] = color;
    const r2 = radius * radius;
    for (let y = Math.max(0, cy-radius); y <= Math.min(height-1, cy+radius); y++) {
      const dy = y - cy;
      const dx = Math.floor(Math.sqrt(Math.max(0, r2 - dy*dy)));
      for (let x = cx-dx; x <= cx+dx; x++) setPixel(x,y,r,g,b);
    }
  };

  // Pig face.
  circle(500, 420, 235, [255,186,200]);
  circle(405, 365, 24, [65,50,55]);
  circle(595, 365, 24, [65,50,55]);
  circle(500, 500, 115, [255,218,225]);
  circle(455, 500, 18, [90,65,72]);
  circle(545, 500, 18, [90,65,72]);

  // Cute ear triangles.
  for (let yy = 165; yy < 310; yy++) {
    const span = Math.floor((yy - 165) * 0.9);
    for (let xx = 275 - span/2; xx <= 275 + span/2; xx++) setPixel(Math.floor(xx),yy,255,186,200);
    for (let xx = 725 - span/2; xx <= 725 + span/2; xx++) setPixel(Math.floor(xx),yy,255,186,200);
  }

  // Simple bitmap word TASKS; whole banner is one tappable button.
  const glyphs = {
    T:["11111","00100","00100","00100","00100","00100","00100"],
    A:["01110","10001","10001","11111","10001","10001","10001"],
    S:["01111","10000","10000","01110","00001","00001","11110"],
    K:["10001","10010","10100","11000","10100","10010","10001"]
  };
  const word = "TASKS";
  const scale = 34;
  const gap = 44;
  let x0 = 1050;
  const y0 = 265;

  for (const ch of word) {
    const rows = glyphs[ch];
    for (let gy=0; gy<7; gy++) {
      for (let gx=0; gx<5; gx++) {
        if (rows[gy][gx] !== "1") continue;
        for (let py=0; py<scale; py++) {
          for (let px=0; px<scale; px++) {
            setPixel(x0 + gx*scale + px, y0 + gy*scale + py, 65,50,55);
          }
        }
      }
    }
    x0 += 5*scale + gap;
  }

  const compressed = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))
  ).arrayBuffer());

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n=0; n<256; n++) {
      let cc=n;
      for (let k=0; k<8; k++) cc = (cc & 1) ? (0xedb88320 ^ (cc >>> 1)) : (cc >>> 1);
      table[n]=cc>>>0;
    }
    return table;
  })();

  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const u32 = n => new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);
  const chunk = (type, data) => {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes,0); crcInput.set(data,typeBytes.length);
    const out = new Uint8Array(12 + data.length);
    out.set(u32(data.length),0);
    out.set(typeBytes,4);
    out.set(data,8);
    out.set(u32(crc32(crcInput)),8+data.length);
    return out;
  };

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width),0);
  ihdr.set(u32(height),4);
  ihdr[8]=8;   // bit depth
  ihdr[9]=2;   // RGB
  ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;

  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const chunks = [chunk("IHDR",ihdr), chunk("IDAT",compressed), chunk("IEND",new Uint8Array())];
  const size = signature.length + chunks.reduce((n,x)=>n+x.length,0);
  const png = new Uint8Array(size);
  let offset=0;
  png.set(signature,offset); offset+=signature.length;
  for (const part of chunks) { png.set(part,offset); offset+=part.length; }
  return png;
}

async function verifyLineSignature(body, signature, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const expected = btoa(binary);
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function setupRichMenu(env) {
  if (!env.CHANNEL_ACCESS_TOKEN) return json({ error: "missing LINE token" }, 500);

  const create = await fetch("https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: true,
      name: "Pig Secretary Main Menu",
      chatBarText: "🐽 任務選單",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: { type: "message", text: "查看所有任務" }
        }
      ]
    })
  });

  if (!create.ok) {
    const detail = await create.text();
    return json({ error: "rich menu create failed", detail: detail.slice(0, 500) }, create.status);
  }

  const data = await create.json();
  const richMenuId = data.richMenuId;

  // A simple embedded PNG is used as the tappable persistent menu image.
  const png = Uint8Array.from(atob(RICH_MENU_PNG_BASE64), c => c.charCodeAt(0));
  const upload = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`
    },
    body: png
  });

  if (!upload.ok) {
    const detail = await upload.text();
    return json({ error: "rich menu image upload failed", richMenuId, detail: detail.slice(0, 500) }, upload.status);
  }

  const setDefault = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` }
  });

  if (!setDefault.ok) {
    const detail = await setDefault.text();
    return json({ error: "set default rich menu failed", richMenuId, detail: detail.slice(0, 500) }, setDefault.status);
  }

  return json({ ok: true, richMenuId });
}

const RICH_MENU_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAA+gAAADSCAYAAADr0j6QAAAACXBIWXMAAAsSAAALEgHS3X78AAABF0lEQVR4nO3BMQEAAADCoPVPbQhPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgJ8B0AABkFfXWQAAAABJRU5ErkJggg==";

async function runReminderDiagnostics(env) {
  const result = {
    now: new Date().toISOString(),
    timezone: "Asia/Taipei",
    db_bound: Boolean(env.DB),
    pending_with_reminder: 0,
    due_now: 0,
    next_reminder: null,
    recent_tasks: []
  };

  if (!env.DB) return json(result, 503);

  await ensureSchema(env.DB);
  await ensureReminderColumn(env.DB);

  const now = new Date().toISOString();

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND reminder_sent_at IS NULL`
  ).first();

  const due = await env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND remind_at <= ?
       AND reminder_sent_at IS NULL`
  ).bind(now).first();

  const next = await env.DB.prepare(
    `SELECT id,title,remind_at,due_time,reminder_sent_at
     FROM tasks
     WHERE status='pending'
       AND remind_at IS NOT NULL
       AND reminder_sent_at IS NULL
     ORDER BY remind_at ASC
     LIMIT 1`
  ).first();

  const recent = await env.DB.prepare(
    `SELECT id,title,status,remind_at,due_time,reminder_sent_at
     FROM tasks
     ORDER BY id DESC
     LIMIT 8`
  ).all();

  result.pending_with_reminder = Number(pending?.n || 0);
  result.due_now = Number(due?.n || 0);
  result.next_reminder = next || null;
  result.recent_tasks = recent.results || [];
  return json(result);
}

async function runDiagnostics(env) {
  const result = {
    runtime: "cloudflare-workers",
    version: "0.2",
    db_bound: Boolean(env.DB),
    secrets: {
      GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
      CHANNEL_SECRET: Boolean(env.CHANNEL_SECRET),
      CHANNEL_ACCESS_TOKEN: Boolean(env.CHANNEL_ACCESS_TOKEN)
    },
    gemini: { ok: false, model: null, status: null },
    line: { ok: false, status: null },
    db: { ok: false, status: env.DB ? "bound" : "not_bound", tables: false }
  };

  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").first();
      result.db.ok = row?.ok === 1;
      result.db.tables = Boolean(table?.name);
      result.db.status = result.db.ok && result.db.tables ? "ok" : "query_failed";
    } catch (err) {
      result.db.status = String(err?.message || err);
    }
  }

  const models = String(env.GEMINI_MODELS || "gemini-3.8-flash")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  for (const model of models.slice(0, 2)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY || "")}`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with exactly OK" }] }],
            generationConfig: { maxOutputTokens: 8, temperature: 0 }
          }),
          signal: controller.signal
        }
      );
      clearTimeout(timeout);
      result.gemini.status = res.status;
      result.gemini.model = model;
      if (res.ok) {
        result.gemini.ok = true;
        break;
      }
    } catch (err) {
      result.gemini.status = String(err?.name || err);
      result.gemini.model = model;
    }
  }

  try {
    const res = await fetch("https://api.line.me/v2/bot/info", {
      headers: { authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN || ""}` }
    });
    result.line.status = res.status;
    result.line.ok = res.ok;
  } catch (err) {
    result.line.status = String(err?.name || err);
  }

  return json(result);
}
