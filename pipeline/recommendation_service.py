from __future__ import annotations

import json
import logging
import os
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np

from .env import load_pipeline_env
from .intent.intent_extraction import extract_conservative_metadata
from .retrieval.candidate_selection import (
    build_attribute_text_search_plan,
    refine_attribute_text_results,
    retrieve_candidates,
)
from .retrieval.target_description_retrieval import RetrieveModule
from .target_description.recommendation_explanation import (
    generate_query_recommendation_explanation,
)
from .target_description.target_description_generation import (
    DEFAULT_IMAGE_ONLY_QUERY,
    GeminiReasoningClient,
    OPENAI_MODEL_NAME,
    OpenAIReasoningClient,
    QWEN_FALLBACK_MODEL_NAME,
    Qwen3VLReasoningClient,
    ReasoningProviderError,
    ReasoningWarning,
)
from .vector_db_client import SupabaseVectorSearchClient


logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 3
DEFAULT_RECOMMENDATION_COUNT = 10
DEFAULT_PIPELINE_METHOD = "intent"
MAX_TOP_K = 100
VALID_TABLES = {
    "musinsa_pants",
    "musinsa_top_clothes",
    "musinsa_skirt_dress",
}
IMAGE_REFERENCE_QUERY_PATTERN = re.compile(
    r"(이\s*(이미지|사진|옷|상품|디자인|스타일|거|것)|이미지처럼|사진처럼|첨부|올린\s*(이미지|사진)|여기서|이거랑|이\s*옷이랑)"
)

load_pipeline_env()

PIPELINE_MODE = os.getenv("PIPELINE_MODE", "supabase_vector")

INTENT_RECOMMENDATION_STAGES = [
    {
        "id": "intent_extraction",
        "label": "VLM 의도 추출",
        "implementation": "pipeline.intent.intent_extraction.extract_conservative_metadata",
    },
    {
        "id": "candidate_selection",
        "label": "의도 기반 DB 후보 축소",
        "implementation": "pipeline.retrieval.candidate_selection.build_attribute_text_search_plan",
    },
    {
        "id": "target_description_vector_search",
        "label": "타겟 디스크립션 기반 최종 추천",
        "implementation": (
            "pipeline.retrieval.target_description_retrieval.RetrieveModule + "
            "pipeline.vector_db_client.SupabaseVectorSearchClient"
        ),
    },
    {
        "id": "recommendation_explanation",
        "label": "한국어 추천 이유 생성",
        "implementation": (
            "pipeline.target_description.recommendation_explanation."
            "build_query_recommendation_explanation"
        ),
    },
]

def _google_translate(text: str, target_lang: str) -> str:
    """Google Translate 무료 API (API 키 불필요)."""
    if not text.strip():
        return ""
    try:
        params = urllib.parse.urlencode({
            "client": "gtx",
            "sl": "auto",
            "tl": target_lang,
            "dt": "t",
            "q": text,
        })
        req = urllib.request.Request(
            f"https://translate.googleapis.com/translate_a/single?{params}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return "".join(part[0] for part in data[0] if part and part[0]).strip()
    except Exception:
        return ""


class FashionRecommendationPipeline:
    """Application-level fashion recommendation workflow."""

    def __init__(self) -> None:
        if PIPELINE_MODE != "supabase_vector":
            raise RuntimeError("PIPELINE_MODE=supabase_vector is required.")

        self._default_provider = os.getenv("VLM_PROVIDER", "gemini").lower()
        self._client_cache: dict[str, Any] = {}
        self.retriever = RetrieveModule()
        self.vector_search = SupabaseVectorSearchClient()

    def _get_reasoning_client(self, provider: str) -> Any:
        if provider not in self._client_cache:
            if provider == "openai":
                self._client_cache[provider] = OpenAIReasoningClient()
            elif provider == "qwen":
                self._client_cache[provider] = Qwen3VLReasoningClient()
            else:
                self._client_cache[provider] = GeminiReasoningClient()
        return self._client_cache[provider]

    def _translate(self, text: str, target_lang: str) -> str:
        is_korean = target_lang.lower() in ("korean", "한국어")
        return _google_translate(text, "ko" if is_korean else "en")

    def search(
        self,
        query: str,
        top_k: int = DEFAULT_RECOMMENDATION_COUNT,
        image_bytes: bytes | None = None,
        image_mime_type: str | None = None,
        table_filter: str | None = None,
        category2_filter: str | None = None,
        category2_keyword_filter: str | None = None,
        provider: str | None = None,
        pipeline_method: str = DEFAULT_PIPELINE_METHOD,
    ) -> tuple[str, str, dict[str, Any], list[dict[str, Any]]]:
        requested_pipeline = pipeline_method.lower().strip() or DEFAULT_PIPELINE_METHOD
        if requested_pipeline not in {"attribute_text", "metadata", "intent"}:
            raise ValueError("pipeline_method must be intent.")

        effective_provider = (provider or self._default_provider).lower()
        raw_fallback = query.strip() or DEFAULT_IMAGE_ONLY_QUERY

        with ThreadPoolExecutor(max_workers=2) as executor:
            intent_future = executor.submit(
                extract_conservative_metadata,
                query=query,
                image_bytes=image_bytes,
                image_mime_type=image_mime_type,
            )
            reasoning_future = executor.submit(
                self._run_target_description_reasoning,
                query=query,
                raw_fallback=raw_fallback,
                image_bytes=image_bytes,
                image_mime_type=image_mime_type,
                provider=effective_provider,
            )
            intent_extraction = intent_future.result()
            reasoning_result, reasoning_provider, reasoning_status, warnings = (
                reasoning_future.result()
            )

        attribute_plan = build_attribute_text_search_plan(
            query=query,
            top_k=top_k,
            has_image=bool(image_bytes),
            extracted_attributes=(
                intent_extraction.attributes
                if intent_extraction and intent_extraction.status == "ok"
                else None
            ),
            extraction_metadata=(
                intent_extraction.to_metadata() if intent_extraction else None
            ),
            table_filter=table_filter,
            category2_filter=category2_filter,
            category2_keyword_filter=category2_keyword_filter,
        )
        pipeline_metadata = attribute_plan.to_dict()
        pipeline_metadata["parallel_execution"] = {
            "intent_and_target_description": True,
            "translation_and_embedding": True,
        }

        target_description = reasoning_result["Target Image Description"]
        retrieval_description = target_description
        pipeline_metadata["target_description_lanes"] = {
            "target_description_reasoning": target_description,
            "detail_target_description": attribute_plan.detail_target_description,
        }
        pipeline_metadata["target_description_reasoning"] = reasoning_result
        pipeline_metadata["target_description_request"] = query
        pipeline_metadata["retrieval_description"] = retrieval_description

        # fabric 속성이 있으면 gemini 임베딩으로 인코딩 (target description 임베딩과 병렬)
        fabric_text = (
            attribute_plan.parsed_attributes.fabric
            if attribute_plan.parsed_attributes.fabric
            else None
        )

        with ThreadPoolExecutor(max_workers=3) as executor:
            translation_future = executor.submit(
                self._translate,
                target_description,
                "Korean",
            )
            embedding_future = executor.submit(
                self.retriever.encode_text,
                [retrieval_description],
            )
            fabric_future = (
                executor.submit(self.retriever.encode_text, [fabric_text])
                if fabric_text
                else None
            )
            target_description_ko = translation_future.result()
            query_embedding = embedding_future.result()[0].tolist()
            fabric_embedding = (
                fabric_future.result()[0].tolist() if fabric_future else None
            )

        active_table_filter = attribute_plan.table_filter
        active_category2_filter = attribute_plan.category2_filter
        active_category2_keyword_filter = attribute_plan.category2_keyword_filter
        match_count = attribute_plan.prefetch_count
        results = None
        if _has_exact_metadata_filters(attribute_plan.parsed_attributes.to_dict()):
            try:
                strict_candidates = retrieve_candidates(
                    attribute_plan.parsed_attributes.to_dict(),
                    include_embeddings=True,
                )
                if strict_candidates:
                    results = _rank_stored_gemini_vectors(
                        embedding=query_embedding,
                        rows=strict_candidates,
                        top_k=top_k,
                        fabric_embedding=fabric_embedding,
                    )
                    pipeline_metadata["candidate_selection"] = {
                        "status": "applied",
                        "strategy": "intent_rest_prefilter_then_local_gemini_vector_rank",
                        "strict_candidate_count": len(strict_candidates),
                        "uses_stored_image_embeddings": True,
                        "fabric_weighted": fabric_embedding is not None,
                    }
                else:
                    pipeline_metadata["candidate_selection"] = {
                        "status": "fallback_no_strict_candidates",
                        "strategy": "rpc_vector_search",
                        "strict_candidate_count": 0,
                    }
            except Exception:
                logger.exception("Intent-based candidate prefilter failed")
                pipeline_metadata["candidate_selection"] = {
                    "status": "fallback_prefilter_error",
                    "strategy": "rpc_vector_search",
                    "error_code": "candidate_prefilter_failed",
                }

        if results is None:
            results = self._search_vectors(
                embedding=query_embedding,
                match_count=match_count,
                table_filter=active_table_filter,
                category2_filter=active_category2_filter,
                category2_keyword_filter=active_category2_keyword_filter,
                fabric_embedding=fabric_embedding,
            )

        results, result_strategy = refine_attribute_text_results(
            results,
            attribute_plan.parsed_attributes,
            top_k,
        )
        pipeline_metadata["result_strategy"] = result_strategy

        pipeline_metadata["stages"] = INTENT_RECOMMENDATION_STAGES
        pipeline_metadata["recommendation_count"] = top_k
        recommendation_explanation = generate_query_recommendation_explanation(
            query=query,
            parsed_attributes=pipeline_metadata.get("parsed_attributes"),
            target_description_ko=target_description_ko,
            detail_target_description=pipeline_metadata.get("detail_target_description"),
            target_description_reasoning=reasoning_result,
            has_reference_image=bool(image_bytes),
        )
        recommendation_reason = recommendation_explanation.recommendation_reason

        metadata = {
            "provider": reasoning_provider,
            "status": reasoning_status,
            "warnings": [warning.to_dict() for warning in warnings],
            "pipeline": pipeline_metadata,
            "recommendation_reason": recommendation_reason,
            "recommendation_explanation": recommendation_explanation.to_metadata(),
        }

        return target_description, target_description_ko, metadata, results

    def _run_target_description_reasoning(
        self,
        *,
        query: str,
        raw_fallback: str,
        image_bytes: bytes | None,
        image_mime_type: str | None,
        provider: str,
    ) -> tuple[dict[str, Any], str, str, list[ReasoningWarning]]:
        is_cloud_provider = provider not in ("qwen",)
        primary_client = self._get_reasoning_client(provider)
        warnings: list[ReasoningWarning] = []
        reasoning_provider = provider
        reasoning_status = "ok"

        try:
            reasoning_result = primary_client.run(
                manipulation_text=query,
                image_bytes=image_bytes,
                image_mime_type=image_mime_type,
            )
        except ReasoningProviderError as exc:
            warnings.append(exc.to_warning())

            if is_cloud_provider:
                try:
                    qwen_client = self._get_reasoning_client("qwen")
                    reasoning_result = qwen_client.run(
                        manipulation_text=query,
                        image_bytes=image_bytes,
                        image_mime_type=image_mime_type,
                    )
                    reasoning_provider = "qwen"
                    reasoning_status = "fallback"
                except (ReasoningProviderError, Exception):
                    reasoning_result = {"Target Image Description": raw_fallback}
                    reasoning_provider = "raw_query"
                    reasoning_status = "degraded"
            else:
                reasoning_result = {"Target Image Description": raw_fallback}
                reasoning_provider = "raw_query"
                reasoning_status = "degraded"
        except Exception:
            warnings.append(
                ReasoningWarning(
                    code="provider_inference_failed",
                    label="추론 오류",
                    message="추론에 실패해 원문으로 검색했습니다.",
                )
            )
            reasoning_result = {"Target Image Description": raw_fallback}
            reasoning_provider = "raw_query"
            reasoning_status = "degraded"

        return reasoning_result, reasoning_provider, reasoning_status, warnings

    def _search_vectors(
        self,
        embedding: list[float],
        match_count: int,
        table_filter: str | None,
        category2_filter: str | None,
        category2_keyword_filter: str | None,
        fabric_embedding: list[float] | None = None,
    ) -> list[dict[str, Any]]:
        if table_filter or category2_filter or category2_keyword_filter:
            return self.vector_search.search(
                embedding=embedding,
                match_count=match_count,
                table_filter=table_filter,
                category2_filter=category2_filter,
                category2_keyword_filter=category2_keyword_filter,
                fabric_embedding=fabric_embedding,
            )

        # Supabase 동시 연결 한도로 인해 순차 검색
        table_results = []
        failed_tables: list[str] = []
        for table in sorted(VALID_TABLES):
            try:
                rows = self.vector_search.search(
                    embedding=embedding,
                    match_count=match_count,
                    table_filter=table,
                    fabric_embedding=fabric_embedding,
                )
                table_results.append(rows)
            except Exception:
                logger.exception("Vector search failed for table %s", table)
                failed_tables.append(table)

        if failed_tables:
            raise RuntimeError(
                "일부 상품 카테고리 검색에 실패했습니다. 잠시 후 다시 시도해주세요."
            )

        merged = [row for rows in table_results for row in rows]
        if not merged:
            raise RuntimeError("모든 테이블 검색이 실패했습니다. 잠시 후 다시 시도해주세요.")
        merged.sort(key=lambda row: float(row.get("similarity") or 0), reverse=True)
        return merged[:match_count]


def needs_reference_image(query: str) -> bool:
    return bool(IMAGE_REFERENCE_QUERY_PATTERN.search(re.sub(r"\s+", " ", query)))


def _has_exact_metadata_filters(attributes: dict[str, Any]) -> bool:
    return any(
        value
        for field, value in attributes.items()
        if field not in {"category1", "color", "fabric"}
    )


def _rank_stored_gemini_vectors(
    embedding: list[float],
    rows: list[dict[str, Any]],
    top_k: int,
    fabric_embedding: list[float] | None = None,
    fabric_weight: float = 0.2,  # 최종 점수 = 0.8 × 이미지 유사도 + 0.2 × fabric 유사도
) -> list[dict[str, Any]]:
    image_weight = 1.0 - fabric_weight if fabric_embedding is not None else 1.0
    query = np.asarray(embedding, dtype=np.float32)
    vectors = np.asarray(
        [_parse_stored_vector(row.get("gemini_image_embedding_768")) for row in rows],
        dtype=np.float32,
    )
    query_norm = float(np.linalg.norm(query))
    row_norms = np.linalg.norm(vectors, axis=1)
    denom = row_norms * query_norm
    denom[denom == 0] = 1.0
    image_scores = (vectors @ query) / denom

    if fabric_embedding is not None:
        fq = np.asarray(fabric_embedding, dtype=np.float32)
        fq_norm = float(np.linalg.norm(fq))
        fabric_vectors = []
        for row in rows:
            raw = row.get("gemini_fabric_text_embedding_768")
            try:
                fabric_vectors.append(_parse_stored_vector(raw))
            except Exception:
                fabric_vectors.append([0.0] * len(fq))
        fv = np.asarray(fabric_vectors, dtype=np.float32)
        fv_norms = np.linalg.norm(fv, axis=1)
        fdenom = fv_norms * fq_norm
        fdenom[fdenom == 0] = 1.0
        fabric_scores = (fv @ fq) / fdenom
        final_scores = image_weight * image_scores + fabric_weight * fabric_scores
    else:
        final_scores = image_scores

    ranked_indices = np.argsort(final_scores)[::-1][:top_k]
    exclude = {"gemini_image_embedding_768", "gemini_fabric_text_embedding_768"}
    return [
        {
            **{k: v for k, v in rows[int(i)].items() if k not in exclude},
            "similarity": float(final_scores[int(i)]),
        }
        for i in ranked_indices
    ]


def _parse_stored_vector(value: Any) -> list[float]:
    if isinstance(value, list):
        return [float(item) for item in value]
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [float(item) for item in parsed]
    raise ValueError("gemini_image_embedding_768 is missing or invalid.")


__all__ = [
    "DEFAULT_PIPELINE_METHOD",
    "DEFAULT_RECOMMENDATION_COUNT",
    "DEFAULT_TOP_K",
    "FashionRecommendationPipeline",
    "MAX_TOP_K",
    "PIPELINE_MODE",
    "VALID_TABLES",
    "_google_translate",
    "_rank_stored_gemini_vectors",
    "needs_reference_image",
]
