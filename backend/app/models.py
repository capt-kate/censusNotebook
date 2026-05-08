import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    records: Mapped[list["Record"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    source_images: Mapped[list["SourceImage"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Record(Base):
    __tablename__ = "records"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    year: Mapped[str] = mapped_column(String(20), default="", nullable=False)
    name: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    location: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    household: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    research_notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    bookmarked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    highlighted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    project: Mapped[Project] = relationship(back_populates="records")


class SourceImage(Base):
    __tablename__ = "source_images"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    project: Mapped[Project] = relationship(back_populates="source_images")
    transcription: Mapped["Transcription | None"] = relationship(
        back_populates="source_image",
        cascade="all, delete-orphan",
        uselist=False,
    )


class Transcription(Base):
    __tablename__ = "transcriptions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid.uuid4()))
    source_image_id: Mapped[str] = mapped_column(ForeignKey("source_images.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(80), default="manual", nullable=False)
    status: Mapped[str] = mapped_column(String(40), default="pending", nullable=False)
    text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    source_image: Mapped[SourceImage] = relationship(back_populates="transcription")
