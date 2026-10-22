import logging
from apscheduler.schedulers.blocking import BlockingScheduler
from app.config import settings
from app.database import Base,engine,SessionLocal
from app.services.reminder_service import dispatch_due_reminders,send_daily_summaries
import app.models
logging.basicConfig(level=settings.LOG_LEVEL);Base.metadata.create_all(bind=engine)
def reminders():
    with SessionLocal() as db:dispatch_due_reminders(db)
if __name__=="__main__":
    s=BlockingScheduler(timezone=settings.tz);s.add_job(reminders,"interval",seconds=30,max_instances=1,coalesce=True);s.add_job(send_daily_summaries,"interval",seconds=30,max_instances=1,coalesce=True);s.start()
