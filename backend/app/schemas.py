from datetime import datetime

from pydantic import BaseModel, ConfigDict


class RecordBase(BaseModel):
    year: str = ""
    name: str = ""
    location: str = ""
    household: str = ""
    notes: str = ""
    research_notes: str = ""
    ai_interpretation: str = ""
    ai_interpreted_at: str = ""
    bookmarked: bool = False
    highlighted: bool = False


class RecordCreate(RecordBase):
    pass


class RecordUpdate(BaseModel):
    year: str | None = None
    name: str | None = None
    location: str | None = None
    household: str | None = None
    notes: str | None = None
    research_notes: str | None = None
    ai_interpretation: str | None = None
    ai_interpreted_at: str | None = None
    bookmarked: bool | None = None
    highlighted: bool | None = None


class RecordRead(RecordBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    created_at: datetime


class ProjectBase(BaseModel):
    name: str


class ProjectCreate(ProjectBase):
    pass


class ProjectMerge(BaseModel):
    target_project_id: str


class ProjectRead(ProjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime
    records: list[RecordRead] = []


class SourceImageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    original_filename: str
    storage_path: str
    content_type: str
    created_at: datetime


class TranscriptionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source_image_id: str
    provider: str
    status: str
    text: str
    created_at: datetime
    updated_at: datetime
