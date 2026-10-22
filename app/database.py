from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import settings
engine=create_engine(settings.sql_alchemy_db_url,pool_pre_ping=True,pool_recycle=1800)
SessionLocal=sessionmaker(autocommit=False,autoflush=False,bind=engine)
Base=declarative_base()
