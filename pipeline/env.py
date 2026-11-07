from __future__ import annotations

from pathlib import Path


def load_pipeline_env() -> None:
    """Load pipeline-local environment variables when python-dotenv is installed."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - optional local convenience
        return

    load_dotenv(Path(__file__).resolve().parent / ".env")
