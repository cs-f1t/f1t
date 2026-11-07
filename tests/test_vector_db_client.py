import pytest

from pipeline.vector_db_client import SupabaseVectorSearchClient


def test_rpc_for_gemini_embedding_dimension() -> None:
    assert SupabaseVectorSearchClient._rpc_for_dim(768) == "match_fashion_items_768"


def test_rpc_rejects_unsupported_embedding_dimension() -> None:
    with pytest.raises(ValueError, match="768-dimensional"):
        SupabaseVectorSearchClient._rpc_for_dim(512)
