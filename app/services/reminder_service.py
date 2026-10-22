import logging
from datetime import timedelta
from app.database import SessionLocal
from app.models import Reminder,ReminderStatus,ReminderType,Task,TaskStatus,User,UserMemory
from app.services.line_service import push_message
from app.services.task_service import now_local
logger=logging.getLogger(__name__)
def dispatch_due_reminders(db):
    now=now_local();rows=db.query(Reminder).filter(Reminder.status==ReminderStatus.PENDING,Reminder.remind_time<=now).order_by(Reminder.remind_time).limit(50).all()
    for r in rows:
        u=db.query(User).filter_by(id=r.user_id,is_active=True).first();t=db.query(Task).filter_by(id=r.task_id).first() if r.task_id else None
        if not u or (t and t.status in {TaskStatus.COMPLETED,TaskStatus.CANCELLED,TaskStatus.PAUSED}):r.status=ReminderStatus.CANCELLED;db.commit();continue
        if push_message(u.line_user_id,[r.content]):
            r.status=ReminderStatus.SENT;r.sent_at=now_local()
            if t and t.due_time and t.due_time<=now_local() and t.status in {TaskStatus.PENDING,TaskStatus.IN_PROGRESS,TaskStatus.POSTPONED}:
                exists=db.query(Reminder).filter(Reminder.task_id==t.id,Reminder.status==ReminderStatus.PENDING).first()
                if not exists:db.add(Reminder(user_id=u.id,task_id=t.id,remind_time=now_local()+timedelta(hours=max(1,u.overdue_repeat_interval_hours or 3)),reminder_type=ReminderType.OVERDUE_REPEAT,content=f"🔴 任務仍未完成：{t.title}\n告訴我卡住原因，我們一起重排。"))
        else:r.retry_count+=1;r.status=ReminderStatus.FAILED if r.retry_count>=3 else ReminderStatus.PENDING;r.remind_time=now_local()+timedelta(minutes=5)
        db.commit()
def send_daily_summaries():
    now=now_local();day=now.strftime("%Y-%m-%d")
    with SessionLocal() as db:
        for u in db.query(User).filter_by(is_active=True).all():
            for slot,hh,greet in [("morning",u.morning_summary_time,"🌅 早安！今天先抓住最重要的一件事。"),("noon",u.noon_summary_time,"☀️ 午間檢視：要不要調整下午安排？"),("night",u.night_summary_time,"🌙 今日收尾：未完成的事可以重新安排。")]:
                if now.strftime("%H:%M")!=hh:continue
                key=f"daily_{slot}_{day}"
                if db.query(UserMemory).filter_by(user_id=u.id,memory_key=key).first():continue
                tasks=db.query(Task).filter(Task.user_id==u.id,Task.status.in_([TaskStatus.PENDING,TaskStatus.IN_PROGRESS,TaskStatus.POSTPONED])).limit(8).all()
                body=greet+"\n\n"+("\n".join(f"• #{t.id} {t.title}" for t in tasks) if tasks else "目前沒有待處理任務。")
                if push_message(u.line_user_id,[body]):db.add(UserMemory(user_id=u.id,memory_key=key,memory_value="sent"));db.commit()
