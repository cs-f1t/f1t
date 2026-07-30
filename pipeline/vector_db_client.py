from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Sequence

if __package__:
    from .env import load_pipeline_env
else:  # pragma: no cover - allows direct imports from pipeline/
    from env import load_pipeline_env

load_pipeline_env()


class SupabaseVectorSearchClient:
    """Supabase pgvector RPC client for 768-dimensional Gemini retrieval."""

    def __init__(
        self,
        supabase_url: str | None = None,
        supabase_key: str | None = None,
        timeout: int = 30,
    ) -> None:
        self.supabase_url = (supabase_url or os.getenv("SUPABASE_URL") or "").rstrip("/")
        self.supabase_key = supabase_key or os.getenv("SUPABASE_KEY") or ""
        self.timeout = timeout

        if not self.supabase_url or not self.supabase_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_KEY are required for pgvector search."
            )

    @staticmethod
    def _to_pgvector(vector: Sequence[float]) -> str:
        return "[" + ",".join(f"{float(value):.8f}" for value in vector) + "]"

    @staticmethod
    def _rpc_for_dim(dim: int) -> str:
        if dim != 768:
            raise ValueError(
                f"Only 768-dimensional Gemini embeddings are supported; got {dim}."
            )
        return "match_fashion_items_768"

    def search(
        self,
        embedding: Sequence[float],
        match_count: int,
        table_filter: str | None = None,
        category2_filter: str | None = None,
        category2_keyword_filter: str | None = None,
        fabric_embedding: Sequence[float] | None = None,
    ) -> list[dict[str, Any]]:
        rpc = self._rpc_for_dim(len(embedding))
        payload = {
            "p_query_embedding": self._to_pgvector(embedding),
            "p_match_count": match_count,
            "p_table_filter": table_filter,
            "p_category2_filter": category2_filter,
            "p_category2_keyword_filter": category2_keyword_filter,
        }
        if fabric_embedding:
            payload["p_fabric_embedding"] = self._to_pgvector(fabric_embedding)

        request = urllib.request.Request(
            f"{self.supabase_url}/rest/v1/rpc/{rpc}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "apikey": self.supabase_key,
                "Authorization": f"Bearer {self.supabase_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code == 404 or "PGRST202" in body:
                raise RuntimeError(
                    f"Supabase RPC {rpc}를 찾지 못했습니다. "
                    "배포 전에 Supabase SQL Editor에서 match_fashion_items_768 RPC를 "
                    "생성했는지 확인해 주세요."
                ) from exc

            raise RuntimeError(
                f"Supabase vector search failed. ({exc.code}) {body[:400]}"
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Supabase vector search failed: {exc.reason}") from exc

        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Supabase vector search returned invalid JSON.") from exc

        if not isinstance(data, list):
            raise RuntimeError(f"Unexpected Supabase vector search response: {data}")

        return data
