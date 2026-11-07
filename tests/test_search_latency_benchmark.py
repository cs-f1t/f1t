from __future__ import annotations

import json

import pytest

from pipeline.benchmarks.search_latency import (
    HybridSearchRunner,
    QueryCase,
    load_query_cases,
    summarize_samples,
)


def test_load_query_cases_supports_description_and_query_fallback(tmp_path):
    path = tmp_path / "queries.json"
    path.write_text(
        json.dumps(
            [
                {
                    "id": "q1",
                    "query": "긴팔 상의",
                    "target_description": "a long-sleeve top",
                    "inferred_attributes": {"category1": "top", "sleeve": "long"},
                },
                {"id": "q2", "query": "출근룩 추천", "inferred_attributes": {}},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    cases = load_query_cases([path])

    assert [case.query_id for case in cases] == ["q1", "q2"]
    assert cases[0].target_description == "a long-sleeve top"
    assert cases[1].target_description == "출근룩 추천"
    assert cases[0].attributes["sleeve"] == "long"


def test_load_query_cases_rejects_duplicate_ids(tmp_path):
    path = tmp_path / "queries.json"
    path.write_text(
        json.dumps([{"id": "same", "query": "a"}, {"id": "same", "query": "b"}]),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicate query id"):
        load_query_cases([path])


def test_hybrid_runner_uses_filtered_candidates_before_hnsw():
    candidates = [
        {"id": "a", "gemini_image_embedding_768": [1.0, 0.0]},
        {"id": "b", "gemini_image_embedding_768": [0.0, 1.0]},
    ]
    fetch_calls = []

    def fetcher(attributes, **kwargs):
        fetch_calls.append((attributes, kwargs))
        return candidates

    class VectorClient:
        def search(self, **kwargs):
            raise AssertionError("HNSW should not be used when SQL candidates exist")

    runner = HybridSearchRunner(
        VectorClient(),
        top_k=1,
        max_candidates=20_000,
        page_size=1_000,
        candidate_fetcher=fetcher,
    )
    case = QueryCase(
        "q",
        "긴팔 상의",
        "long sleeve top",
        {"category1": "top", "sleeve": "long"},
        "test",
    )

    results, count, strategy = runner.search(case, [1.0, 0.0])

    assert results[0]["id"] == "a"
    assert count == 2
    assert strategy == "sql_prefilter_exact_cosine"
    assert fetch_calls[0][1]["max_rows"] == 20_000


def test_hybrid_runner_passes_fabric_embedding_to_hnsw_fallback():
    captured = {}

    class VectorClient:
        def search(self, **kwargs):
            captured.update(kwargs)
            return [{"id": "a", "similarity": 0.9}]

    runner = HybridSearchRunner(
        VectorClient(),
        top_k=1,
        max_candidates=20_000,
        page_size=1_000,
        candidate_fetcher=lambda *_args, **_kwargs: [],
    )
    case = QueryCase(
        "q",
        "울 재킷",
        "wool jacket",
        {"category1": "outer", "fabric": "wool"},
        "test",
    )

    results, count, strategy = runner.search(
        case,
        [1.0, 0.0],
        fabric_embedding=[0.0, 1.0],
    )

    assert results[0]["id"] == "a"
    assert count == 150
    assert strategy == "hnsw_fallback"
    assert captured["fabric_embedding"] == [0.0, 1.0]


def test_summarize_samples_reports_paired_latency_and_candidate_reduction():
    samples = [
        {
            "query_id": "q1",
            "repetition": 1,
            "method": "full_scan",
            "duration_ms": 100.0,
            "candidate_count": 100,
            "strategy": "database_full_scan",
            "error": None,
        },
        {
            "query_id": "q1",
            "repetition": 1,
            "method": "hybrid",
            "duration_ms": 25.0,
            "candidate_count": 20,
            "strategy": "sql_prefilter_exact_cosine",
            "error": None,
        },
        {
            "query_id": "q2",
            "repetition": 1,
            "method": "full_scan",
            "duration_ms": 120.0,
            "candidate_count": 100,
            "strategy": "database_full_scan",
            "error": None,
        },
        {
            "query_id": "q2",
            "repetition": 1,
            "method": "hybrid",
            "duration_ms": 30.0,
            "candidate_count": 10,
            "strategy": "hnsw_fallback",
            "error": None,
        },
    ]

    summary = summarize_samples(samples)

    assert summary["paired"]["pair_count"] == 2
    assert summary["paired"]["mean_saved_ms"] == 82.5
    assert summary["paired"]["mean_speedup"] == 4.0
    assert summary["candidates"]["reduction_pct"] == 85.0
