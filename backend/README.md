# Census Notebook Backend

FastAPI backend for the Census Notebook app.

## Local setup

1. Create a Python virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Run the API:

```bash
uvicorn app.main:app --reload --port 8000
```

By default, local development uses a SQLite database file at `backend/census_notebook.db`.
The React app expects the API at `http://127.0.0.1:8000`.

## PostgreSQL

For PostgreSQL, start a database and set `DATABASE_URL`, for example:

```bash
export DATABASE_URL=postgresql+psycopg://census:census@localhost:5432/census_notebook
```

This repository includes a `docker-compose.yml` at the project root for PostgreSQL:

```bash
docker compose up -d postgres
```
