# Census Notebook Backend

FastAPI backend for the Census Notebook app.

## Local setup

1. Create a Python virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start PostgreSQL and set `DATABASE_URL`, for example:

```bash
export DATABASE_URL=postgresql+psycopg://census:census@localhost:5432/census_notebook
```

4. Run the API:

```bash
uvicorn app.main:app --reload --port 8000
```

The React app expects the API at `http://127.0.0.1:8000`.
