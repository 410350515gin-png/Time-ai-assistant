import json,logging
from datetime import datetime
from fastapi import FastAPI,Request,HTTPException
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.webhooks import MessageEvent,TextMessageContent
from app.config import settings
from app.database import Base,engine,SessionLocal
from app.models import Task,TaskStatus,UserMemory
from app.services.line_service import line_parser,reply_message
from app.services.task_service import *
from app.agent.gemini_coach import interpret_message
from app.services.reminder_service import dispatch_due_reminders, send_daily_summaries
from apscheduler.schedulers.background import BackgroundScheduler
logging.basicConfig(level=settings.LOG_LEVEL);logger=logging.getLogger(__name__)
app=FastAPI(title="LINE Action Agent",version="2.1")
Base.metadata.create_all(bind=engine)
scheduler=BackgroundScheduler(timezone=settings.tz)
def _run_reminders():
    with SessionLocal() as db:
        dispatch_due_reminders(db)
@app.on_event("startup")
def start_scheduler():
    if not scheduler.running:
        scheduler.add_job(_run_reminders,"interval",seconds=30,id="reminders",replace_existing=True,max_instances=1,coalesce=True)
        scheduler.add_job(send_daily_summaries,"interval",seconds=30,id="summaries",replace_existing=True,max_instances=1,coalesce=True)
        scheduler.start()
@app.on_event("shutdown")
def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
YES={"是","好","確認","確認執行","同意","可以","ok","yes","好啊","照這個安排","確認計畫"}
NO={"否","不要","取消","不用","no","先不要","不接受"}
def fmt(v):
    if not v:return "未設定"
    try:return datetime.fromisoformat(str(v).replace("Z","+00:00")).astimezone(settings.tz).strftime("%m/%d %H:%M")
    except:return str(v)
def plan_text(items):
    return "\n".join(f"{i}. {x.get('title','未命名')}｜開始 {fmt(x.get('start_time'))}｜截止 {fmt(x.get('due_time'))}｜提醒 {fmt(x.get('remind_at'))}｜{x.get('estimated_minutes') or '未估'} 分鐘｜{x.get('reason','')}" for i,x in enumerate(items,1))
def context(tasks):
    return "\n".join(f"id={t.id};title={t.title};status={t.status.value};start={t.start_time};due={t.due_time};first_step={t.first_step}" for t in tasks[:40])
@app.get("/")
@app.get("/health")
def health():return {"status":"ok","version":"2.1"}
@app.post("/callback")
@app.post("/webhook")
async def webhook(request:Request):
    body=(await request.body()).decode();sig=request.headers.get("X-Line-Signature","")
    try:events=line_parser.parse(body,sig)
    except InvalidSignatureError:raise HTTPException(400,"Invalid signature")
    for e in events:
        if not isinstance(e,MessageEvent) or not isinstance(e.message,TextMessageContent):continue
        uid=e.source.user_id;text=e.message.text.strip()
        with SessionLocal() as db:
            try:
                u=get_or_create_user(db,uid);raw=memory_get(db,u.id,"pending_plan");pending=json.loads(raw) if raw else None
                if pending and text.lower() in YES:
                    ts=apply_plan(db,u,pending["plan_items"]);memory_set(db,u.id,"pending_plan","");db.commit()
                    reply_message(e.reply_token,[f"✅ 已儲存 {len(ts)} 項任務。提醒會依確認時間主動推播。"]);continue
                if pending and text.lower() in NO:
                    memory_set(db,u.id,"pending_plan","");reply_message(e.reply_token,["好的，沒有套用任何變更。"]);continue
                tasks=list_active_tasks(db,u.id);r=interpret_message(text,context(tasks)+("\n待確認："+plan_text(pending["plan_items"]) if pending else ""));intent=r.get("intent","chat");reply=r.get("reply","")
                if intent in {"propose_plan","revise_plan"}:
                    items=r.get("plan_items") or [];valid={t.id for t in tasks};clean=[]
                    for x in items:
                        if not isinstance(x,dict):continue
                        a=x.get("action","create");tid=x.get("task_id")
                        if a in {"update","keep"} and tid not in valid:continue
                        if a=="create" and (not x.get("title") or not x.get("first_step")):continue
                        clean.append(x)
                    if clean:
                        memory_set(db,u.id,"pending_plan",json.dumps({"plan_items":clean},ensure_ascii=False));reply=(reply+"\n\n📅 建議安排（尚未執行）：\n"+plan_text(clean)+"\n\n回覆「確認」、告訴我怎麼修改，或「取消」。")[:4900]
                elif intent=="list_tasks":reply="🟡 待處理：\n"+("\n".join(f"#{t.id} {t.title}｜{t.status.value}｜截止 {fmt(t.due_time)}" for t in tasks) if tasks else "目前沒有待辦。")
                elif intent=="complete_task":
                    o=complete_task(db,u.id,r.get("task_id")) if isinstance(r.get("task_id"),int) else None;reply=f"✅ 已完成 #{o.id} {o.title}" if o else "請提供任務編號。"
                elif intent=="cancel_task":
                    o=cancel_task(db,u.id,r.get("task_id")) if isinstance(r.get("task_id"),int) else None;reply=f"已取消 #{o.id} {o.title}" if o else "請提供任務編號。"
                elif intent=="pause_task":
                    o=set_task_status(db,u.id,r.get("task_id"),TaskStatus.PAUSED) if isinstance(r.get("task_id"),int) else None;reply=f"⏸️ 已暫停 #{o.id} {o.title}" if o else "請提供任務編號。"
                elif intent=="resume_task":
                    o=set_task_status(db,u.id,r.get("task_id"),TaskStatus.PENDING) if isinstance(r.get("task_id"),int) else None;reply=f"🔵 已恢復 #{o.id} {o.title}" if o else "請提供任務編號。"
                elif intent=="postpone_task":
                    o=postpone_task(db,u.id,r.get("task_id"),r.get("new_due_time"),r.get("reason")) if isinstance(r.get("task_id"),int) and r.get("new_due_time") else None;reply=f"📅 已延期 #{o.id} {o.title} 至 {fmt(o.due_time)}" if o else "請提供任務編號與新截止時間。"
                elif intent=="stats":
                    total=db.query(Task).filter_by(user_id=u.id).count();done=db.query(Task).filter(Task.user_id==u.id,Task.status==TaskStatus.COMPLETED).count();reply=f"📊 總任務 {total}｜完成 {done}｜完成率 {round(done/total*100,1) if total else 0}%"
                elif intent=="help":reply="可一次貼多項待辦。我會排序、拆第一步、提議開始/截止/提醒時間；你確認後才儲存。也可列出、完成、延期、暫停、恢復、取消任務。"
                reply_message(e.reply_token,[reply or "請把待辦和已知期限告訴我。"])
            except Exception:
                db.rollback();logger.exception("message failed");reply_message(e.reply_token,["這次處理失敗，資料沒有被確認成功。請稍後再試。"])
    return {"status":"ok"}
