# F1T Backend

This directory contains the HTTP API layer only. The fashion recommendation
workflow lives in `../pipeline/recommendation_service.py`.

Run the local API from the repository root:

```bash
pip install -r backend/requirements.txt
uvicorn backend.api:app --host 0.0.0.0 --port 8000
```

Runtime credentials remain in `pipeline/.env` because they are consumed by the
search pipeline.
