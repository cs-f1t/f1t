from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from backend import api
from pipeline.recommendation_service import FashionRecommendationPipeline


def make_upload(content: bytes, content_type: str = "image/jpeg") -> UploadFile:
    return UploadFile(
        file=BytesIO(content),
        filename="sample.jpg",
        headers=Headers({"content-type": content_type}),
    )


def test_image_upload_rejects_non_image_content() -> None:
    with pytest.raises(HTTPException) as exc_info:
        api.read_image_upload(make_upload(b"plain text", "text/plain"))

    assert exc_info.value.status_code == 400


def test_invalid_upload_limit_falls_back_to_safe_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAX_IMAGE_BYTES", "8mb")

    assert api.max_image_bytes_from_env() == api.DEFAULT_MAX_IMAGE_BYTES


def test_image_upload_rejects_oversized_content(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api, "MAX_IMAGE_BYTES", 4)

    with pytest.raises(HTTPException) as exc_info:
        api.read_image_upload(make_upload(b"12345"))

    assert exc_info.value.status_code == 413


def test_analyze_removes_temporary_image(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_path: Path | None = None

    def fake_analyze(_text: str, image_path: str | None) -> dict[str, str]:
        nonlocal captured_path
        captured_path = Path(image_path or "")
        assert captured_path.exists()
        return {"category": "outer"}

    monkeypatch.setattr(api, "analyze_fashion_intent", fake_analyze)

    response = api.analyze("find a jacket", make_upload(b"image-bytes"))

    assert response["status"] == "success"
    assert captured_path is not None
    assert not captured_path.exists()


def test_analyze_hides_internal_error_details(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_analysis(_text: str, _image_path: str | None) -> None:
        raise RuntimeError("private provider credential detail")

    monkeypatch.setattr(api, "analyze_fashion_intent", fail_analysis)

    with pytest.raises(HTTPException) as exc_info:
        api.analyze("find a jacket", None)

    assert exc_info.value.status_code == 500
    assert "private provider" not in str(exc_info.value.detail)


def test_multi_table_search_fails_when_any_required_table_is_unavailable() -> None:
    class PartiallyFailingSearch:
        def search(self, *, table_filter: str, **_kwargs: object) -> list[dict[str, object]]:
            if table_filter == "musinsa_pants":
                raise RuntimeError("database detail")
            return [{"similarity": 0.9, "source_table": table_filter}]

    pipeline = FashionRecommendationPipeline.__new__(FashionRecommendationPipeline)
    pipeline.vector_search = PartiallyFailingSearch()

    with pytest.raises(RuntimeError, match="일부 상품 카테고리"):
        pipeline._search_vectors(
            embedding=[0.1],
            match_count=3,
            table_filter=None,
            category2_filter=None,
            category2_keyword_filter=None,
        )
