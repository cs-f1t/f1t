-- 운영 검색에서 사용하지 않는 구형 CLIP/Qwen 임베딩을 제거합니다.
-- 현재 검색에 필요한 Gemini 이미지·소재 벡터와 HNSW 인덱스는 유지합니다.
-- 실행 전 애플리케이션, 함수, 뷰의 컬럼 참조가 없는지 확인해야 합니다.

alter table public.musinsa_top_clothes
  drop column if exists clip_image_embedding_768,
  drop column if exists qwen_image_embedding_768,
  drop column if exists qwen_color_embedding_768,
  drop column if exists qwen_fabric_embedding_768;

alter table public.musinsa_pants
  drop column if exists clip_image_embedding_768,
  drop column if exists qwen_image_embedding_768,
  drop column if exists qwen_color_embedding_768,
  drop column if exists qwen_fabric_embedding_768;

alter table public.musinsa_skirt_dress
  drop column if exists clip_image_embedding_768,
  drop column if exists qwen_image_embedding_768,
  drop column if exists qwen_color_embedding_768,
  drop column if exists qwen_fabric_embedding_768;

-- DROP COLUMN은 공간을 즉시 운영체제에 반환하지 않습니다.
-- 아래 명령은 트랜잭션 밖에서 테이블별로 하나씩 실행합니다.
-- VACUUM FULL 중에는 대상 테이블에 배타 잠금이 걸립니다.
-- vacuum (full, analyze) public.musinsa_top_clothes;
-- vacuum (full, analyze) public.musinsa_pants;
-- vacuum (full, analyze) public.musinsa_skirt_dress;
