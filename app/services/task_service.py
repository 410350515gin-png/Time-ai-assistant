from datetime import datetime,timedelta
from sqlalchemy.orm import Session
from app.config import settings
from app.models import User,UserMemory,Task,Reminder,TaskStatus,TaskPriority,ReminderType,ReminderStatus
ACTIVE=[TaskStatus.PENDING,TaskStatus.IN_PROGRESS,TaskStatus.POSTPONED,TaskStatus.PAUSED]
def now_local(): return datetime.now(settings.tz)
def aware(v):
    if v is None:return None
    if isinstance(v,str):v=datetime.fromisoformat(v.replace("Z","+00:00"))
    return v.replace(tzinfo=settings.tz) if v.tzinfo is None else v.astimezone(settings.tz)
def get_or_create_user(db,uid):
    u=db.query(User).filter_by(line_user_id=uid).first()
    if not u: u=User(line_user_id=uid);db.add(u);db.commit();db.refresh(u)
    return u
def memory_get(db,uid,key):
    r=db.query(UserMemory).filter_by(user_id=uid,memory_key=key).first();return r.memory_value if r else None
def memory_set(db,uid,key,val):
    r=db.query(UserMemory).filter_by(user_id=uid,memory_key=key).first()
    if r:r.memory_value=val
    else:db.add(UserMemory(user_id=uid,memory_key=key,memory_value=val))
    db.commit()
def _cancel(db,tid): db.query(Reminder).filter(Reminder.task_id==tid,Reminder.status.in_([ReminderStatus.PENDING,ReminderStatus.PROCESSING])).update({"status":ReminderStatus.CANCELLED},synchronize_session=False)
def _remind(db,u,t,when,kind=ReminderType.SPECIFIC,content=None):
    when=aware(when)
    if when and when>now_local():db.add(Reminder(user_id=u,task_id=t.id,remind_time=when,reminder_type=kind,content=content or f"⏰ {t.title}\n📌 {t.first_step}"))
def schedule(db,u,t,preferred=None):
    if preferred:_remind(db,u,t,preferred)
    elif t.start_time:_remind(db,u,t,t.start_time-timedelta(minutes=10))
    if t.due_time:
        _remind(db,u,t,t.due_time-timedelta(minutes=30),ReminderType.DUE_ADVANCE,f"⏰ {t.title} 約 30 分鐘後截止。")
        _remind(db,u,t,t.due_time,ReminderType.OVERDUE_REPEAT,f"🔔 {t.title} 截止時間到了。若卡住了告訴我原因，我們重新安排。")
def apply_plan(db,u,items):
    out=[]
    for x in items:
        action=x.get("action","create");tid=x.get("task_id")
        if action in {"update","keep"}:
            t=db.query(Task).filter_by(id=tid,user_id=u.id).first()
            if not t:raise ValueError("invalid task")
            if action=="keep":out.append(t);continue
            _cancel(db,t.id)
            for k in ("title","description","first_step","estimated_minutes"):
                if x.get(k) is not None:setattr(t,k,x[k])
            if x.get("priority") in TaskPriority.__members__:t.priority=TaskPriority[x["priority"]]
            if "start_time" in x:t.start_time=aware(x.get("start_time"))
            if "due_time" in x:t.due_time=aware(x.get("due_time"))
        else:
            p=x.get("priority","MEDIUM");p=p if p in TaskPriority.__members__ else "MEDIUM"
            t=Task(user_id=u.id,title=x["title"][:255],description=x.get("description"),first_step=x["first_step"][:255],priority=TaskPriority[p],start_time=aware(x.get("start_time")),due_time=aware(x.get("due_time")),estimated_minutes=x.get("estimated_minutes"));db.add(t);db.flush()
        schedule(db,u.id,t,x.get("remind_at"));out.append(t)
    return out
def list_active_tasks(db,uid):return db.query(Task).filter(Task.user_id==uid,Task.status.in_(ACTIVE)).order_by(Task.due_time.asc().nullslast(),Task.id.asc()).all()
def complete_task(db,uid,tid):
    t=db.query(Task).filter_by(id=tid,user_id=uid).first()
    if t:t.status=TaskStatus.COMPLETED;t.completed_at=now_local();_cancel(db,t.id);db.commit()
    return t
def cancel_task(db,uid,tid):
    t=db.query(Task).filter_by(id=tid,user_id=uid).first()
    if t:t.status=TaskStatus.CANCELLED;_cancel(db,t.id);db.commit()
    return t
def set_task_status(db,uid,tid,status):
    t=db.query(Task).filter_by(id=tid,user_id=uid).first()
    if not t:return None
    old=t.status;t.status=status
    if status==TaskStatus.PAUSED:_cancel(db,t.id)
    elif old==TaskStatus.PAUSED and status==TaskStatus.PENDING:schedule(db,uid,t)
    db.commit();return t
def postpone_task(db,uid,tid,due,reason=None):
    t=db.query(Task).filter_by(id=tid,user_id=uid).first()
    if not t:return None
    t.due_time=aware(due);t.status=TaskStatus.POSTPONED;t.postpone_count+=1;t.last_postpone_reason=reason;_cancel(db,t.id);schedule(db,uid,t);db.commit();return t
