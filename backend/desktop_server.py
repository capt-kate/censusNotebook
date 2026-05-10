import os
from pathlib import Path

import uvicorn

from app.main import app


if __name__ == "__main__":
    data_dir = os.getenv("CENSUS_NOTEBOOK_DATA_DIR")
    upload_dir = os.getenv("CENSUS_NOTEBOOK_UPLOAD_DIR")
    if data_dir:
        Path(data_dir).mkdir(parents=True, exist_ok=True)
    if upload_dir:
        Path(upload_dir).mkdir(parents=True, exist_ok=True)

    port = int(os.getenv("CENSUS_NOTEBOOK_API_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
