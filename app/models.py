import enum
from datetime import datetime, timezone
from sqlalchemy import Column,Integer,String,Text,Boolean,DateTime,ForeignKey,Enum,Index,UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base

def utcnow(): return datetime.now(timezone.utc)
class TaskStatus(str,enum.Enum):
    PENDING="PENDING"; IN_PROGRESS="IN_PROGRESS"; COMPLETED="COMPLETED"; POSTPONED="POSTPONED"; PAUSED="PAUSED"; CANCELLED="CANCELLED"
class TaskPriority(str,enum.Enum):
    LOW="LOW"; MEDIUM="MEDIUM"; HIGH="HIGH"; URGENT="URGENT"
class ReminderType(str,enum.Enum):
    SPECIFIC="SPECIFIC"; DUE_ADVANCE="DUE_ADVANCE"; OVERDUE_REPEAT="OVERDUE_REPEAT"
class ReminderStatus(str,enum.Enum):
    PENDING="PENDING"; PROCESSING="PROCESSING"; SENT="SENT"; CANCELLED="CANCELLED"; FAILED="FAILED"
class User(Base):
    __tablename__="users"; id=Column(Integer,primary_key=True); line_user_id=Column(String(64),unique=True,nullable=False,index=True); display_name=Column(String(128)); created_at=Column(DateTime(timezone=True),default=utcnow,nullable=False); morning_summary_time=Column(String(5),default="08:00"); noon_summary_time=Column(String(5),default="12:30"); night_summary_time=Column(String(5),default="21:00"); overdue_repeat_interval_hours=Column(Integer,default=3); is_active=Column(Boolean,default=True)
class Task(Base):
    __tablename__="tasks"; id=Column(Integer,primary_key=True); user_id=Column(Integer,ForeignKey("users.id",ondelete="CASCADE"),nullable=False,index=True); title=Column(String(255),nullable=False); description=Column(Text); first_step=Column(String(255),nullable=False); status=Column(Enum(TaskStatus),default=TaskStatus.PENDING,nullable=False,index=True); priority=Column(Enum(TaskPriority),default=TaskPriority.MEDIUM,nullable=False); start_time=Column(DateTime(timezone=True)); due_time=Column(DateTime(timezone=True),index=True); estimated_minutes=Column(Integer); postpone_count=Column(Integer,default=0); last_postpone_reason=Column(Text); completed_at=Column(DateTime(timezone=True)); created_at=Column(DateTime(timezone=True),default=utcnow)
class Reminder(Base):
    __tablename__="reminders"; id=Column(Integer,primary_key=True); user_id=Column(Integer,ForeignKey("users.id",ondelete="CASCADE"),nullable=False,index=True); task_id=Column(Integer,ForeignKey("tasks.id",ondelete="CASCADE"),index=True); remind_time=Column(DateTime(timezone=True),nullable=False,index=True); reminder_type=Column(Enum(ReminderType),nullable=False); status=Column(Enum(ReminderStatus),default=ReminderStatus.PENDING,nullable=False,index=True); content=Column(String(500),nullable=False); retry_count=Column(Integer,default=0); last_error=Column(Text); sent_at=Column(DateTime(timezone=True)); claimed_at=Column(DateTime(timezone=True))
class UserMemory(Base):
    __tablename__="user_memories"; id=Column(Integer,primary_key=True); user_id=Column(Integer,ForeignKey("users.id",ondelete="CASCADE"),nullable=False,index=True); memory_key=Column(String(64),nullable=False); memory_value=Column(Text,nullable=False); updated_at=Column(DateTime(timezone=True),default=utcnow); __table_args__=(UniqueConstraint("user_id","memory_key",name="uq_user_memory_key"),)
