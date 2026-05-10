import os
from pathlib import Path
from shutil import copyfileobj

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, or_, select, text
from sqlalchemy.orm import Session, selectinload

from .database import Base, engine, get_db
from .models import Project, Record, SourceImage
from .schemas import (
    ProjectCreate,
    ProjectMerge,
    ProjectRead,
    RecordCreate,
    RecordRead,
    RecordUpdate,
    SourceImageRead,
)

UPLOAD_DIR = Path(os.getenv("CENSUS_NOTEBOOK_UPLOAD_DIR", "uploads"))

app = FastAPI(title="Census Notebook API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "file://",
        "null",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    if engine.dialect.name == "sqlite":
        inspector = inspect(engine)
        record_columns = {column["name"] for column in inspector.get_columns("records")}
        if "research_notes" not in record_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE records ADD COLUMN research_notes TEXT NOT NULL DEFAULT ''"))
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/projects", response_model=list[ProjectRead])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    statement = select(Project).options(selectinload(Project.records)).order_by(Project.created_at)
    return list(db.scalars(statement))


@app.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> Project:
    project = Project(name=payload.name.strip())
    if not project.name:
        raise HTTPException(status_code=400, detail="Project name is required.")

    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)) -> None:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    db.delete(project)
    db.commit()


@app.post("/projects/{project_id}/merge", response_model=ProjectRead)
def merge_project(project_id: str, payload: ProjectMerge, db: Session = Depends(get_db)) -> Project:
    source_project = db.get(Project, project_id)
    if source_project is None:
        raise HTTPException(status_code=404, detail="Source project not found.")

    if project_id == payload.target_project_id:
        raise HTTPException(status_code=400, detail="Choose a different project to merge into.")

    target_project = db.get(Project, payload.target_project_id)
    if target_project is None:
        raise HTTPException(status_code=404, detail="Target project not found.")

    for record in list(source_project.records):
        record.project_id = target_project.id

    for source_image in list(source_project.source_images):
        source_image.project_id = target_project.id

    db.delete(source_project)
    db.commit()
    db.refresh(target_project)
    return target_project


@app.post("/projects/{project_id}/records", response_model=RecordRead, status_code=201)
def create_record(project_id: str, payload: RecordCreate, db: Session = Depends(get_db)) -> Record:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    record = Record(project_id=project_id, **payload.model_dump())
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@app.patch("/records/{record_id}", response_model=RecordRead)
def update_record(record_id: str, payload: RecordUpdate, db: Session = Depends(get_db)) -> Record:
    record = db.get(Record, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found.")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, key, value)

    db.commit()
    db.refresh(record)
    return record


@app.delete("/records/{record_id}", status_code=204)
def delete_record(record_id: str, db: Session = Depends(get_db)) -> None:
    record = db.get(Record, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found.")

    db.delete(record)
    db.commit()


@app.get("/search", response_model=list[RecordRead])
def search_records(q: str = "", db: Session = Depends(get_db)) -> list[Record]:
    query = q.strip()
    statement = select(Record).order_by(Record.created_at.desc())

    if query:
        pattern = f"%{query}%"
        statement = statement.where(
            or_(
                Record.year.ilike(pattern),
                Record.name.ilike(pattern),
                Record.location.ilike(pattern),
                Record.household.ilike(pattern),
                Record.notes.ilike(pattern),
                Record.research_notes.ilike(pattern),
            )
        )

    return list(db.scalars(statement))


@app.post("/projects/{project_id}/uploads", response_model=SourceImageRead, status_code=201)
def upload_source_image(
    project_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> SourceImage:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    project_dir = UPLOAD_DIR / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    storage_path = project_dir / file.filename

    with storage_path.open("wb") as output:
        copyfileobj(file.file, output)

    source_image = SourceImage(
        project_id=project_id,
        original_filename=file.filename,
        storage_path=str(storage_path),
        content_type=file.content_type or "",
    )
    db.add(source_image)
    db.commit()
    db.refresh(source_image)
    return source_image
