"""Target-description Gemini embedding retrieval module.

Uses gemini-embedding-2 to encode target descriptions into 768-dim vectors
for pgvector similarity search in Supabase.
"""
from __future__ import annotations

import os
from typing import Any


GEMINI_EMBEDDING_MODEL = "gemini-embedding-2"
GEMINI_EMBEDDING_DIM = 768


class GeminiEmbeddingClient:
    """Text encoder via Gemini Embedding API (google-genai SDK)."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        dimensionality: int | None = None,
    ):
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise RuntimeError(
                "google-genai is required. Install with: pip install google-genai"
            ) from exc

        self._types = types
        self._client = genai.Client(
            api_key=api_key or os.getenv("GEMINI_API_KEY")
        )
        self._model = (
            model
            or os.getenv("GEMINI_EMBEDDING_MODEL", GEMINI_EMBEDDING_MODEL)
        )
        dim = dimensionality or int(
            os.getenv("GEMINI_EMBEDDING_DIM", str(GEMINI_EMBEDDING_DIM))
        )
        self._config = types.EmbedContentConfig(output_dimensionality=dim)

    def encode_text(self, captions: list[str]) -> Any:
        import numpy as np

        vectors = []
        for text in captions:
            response = self._client.models.embed_content(
                model=self._model,
                contents=f"task: search result | query: {text}",
                config=self._config,
            )
            vectors.append(response.embeddings[0].values)
        return np.array(vectors, dtype=np.float32)


class RetrieveModule:
    """Query encoder using gemini-embedding-2 for Supabase pgvector search."""

    def __init__(
        self,
        clip_model_name: str = "ViT-B-32",
        pretrained: str = "openai",
        hf_api_key: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        dimensionality: int | None = None,
        **_legacy_options: Any,
    ):
        _ = (clip_model_name, pretrained, hf_api_key, _legacy_options)
        self._backend = GeminiEmbeddingClient(
            api_key=api_key,
            model=model,
            dimensionality=dimensionality,
        )

    def encode_text(self, captions: list[str]) -> Any:
        return self._backend.encode_text(captions)
