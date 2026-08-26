# 검색 지연 벤치마크

이 벤치마크는 동일한 검색용 설명문 임베딩으로 다음 두 검색 경로의 지연을 비교합니다.

- `full_scan`: HNSW와 bitmap scan을 끄고 세 상품 테이블의 모든 이미지 임베딩을 정확 코사인 비교
- `hybrid`: 명시 속성이 있으면 SQL로 후보를 줄인 뒤 정확 코사인 재정렬, 후보가 없으면 HNSW 검색

VLM 설명 생성과 Gemini 쿼리 임베딩 생성 시간은 측정에서 제외합니다. 쿼리 임베딩은 최초 한 번 생성해 캐시에 저장하며 두 방법이 같은 벡터를 사용합니다.

소재 조건이 있는 질의는 운영 검색과 동일하게 fabric 텍스트도 Gemini 임베딩으로 변환해 `hybrid` 경로에 전달합니다. SQL 후보 재정렬과 HNSW RPC 모두 `0.8 × 이미지 + 0.2 × fabric` 점수 정책을 그대로 사용합니다.

## 1. 전수 비교 RPC 준비

운영 DB가 아닌 동일 스펙의 벤치마크 DB에서 `pipeline/sql/benchmark_full_scan_fashion_items_768.sql`을 적용합니다. 이 함수의 scan 설정 변경은 해당 트랜잭션에만 적용됩니다.

## 2. 108개 입력 준비

JSON 배열 또는 JSONL을 사용할 수 있습니다. 각 항목은 다음 형태입니다.

```json
{
  "id": "q001",
  "query": "긴팔 검은색 상의를 찾아줘",
  "target_description": "A black long-sleeve top",
  "inferred_attributes": {
    "category1": "top",
    "sleeve": "long"
  }
}
```

`target_description`이 없으면 `query`를 임베딩하지만, 최종 실험에서는 실제 VLM이 생성했던 검색용 설명문을 넣어야 합니다. 입력 수를 임의 복제로 맞추지 않도록 `--strict-count`를 사용합니다.

```bash
python -m pipeline.benchmarks.search_latency \
  path/to/queries_108.json \
  --expected-count 108 \
  --strict-count \
  --dry-run
```

현재 저장소 스냅샷에 포함된 고유 쿼리는 54개입니다. 입력 파서만 확인하려면 다음 명령을 사용합니다.

```bash
python -m pipeline.benchmarks.search_latency \
  pipeline/tests/intent_analysis_results.json \
  pipeline/tests/simple_test/simple_test_results_gemini.json \
  pipeline/tests/simple_test/image_test_results_gemini.json \
  --expected-count 54 \
  --strict-count \
  --dry-run
```

[`results/preliminary_cpu_only_54.json`](results/preliminary_cpu_only_54.json)은 54개 고유 질의로 CPU 환경에서 실행한 예비 결과입니다. 운영 DB와 동일한 배포 환경, 반복 수, 108개 strict 입력을 갖춘 최종 운영 수치가 아니므로 포트폴리오의 성능 근거로는 사용하지 않습니다.

## 3. 측정 실행

```bash
python -m pipeline.benchmarks.search_latency \
  path/to/queries_108.json \
  --expected-count 108 \
  --strict-count \
  --repetitions 3 \
  --warmup-queries 3 \
  --output .omx/benchmarks/search_latency_108.json
```

한 쿼리의 두 방법은 번갈아 실행하고 전체 순서는 고정 seed로 섞습니다. 결과에는 다음 값이 저장됩니다.

- 방법별 평균, 중앙값, p95, 최솟값, 최댓값
- 같은 쿼리·반복끼리 비교한 평균 절감 시간과 배속
- 평균 비교 후보 수와 후보 축소율
- SQL 후보 축소와 HNSW 폴백 사용 횟수
- 개별 실행의 지연, 후보 수, 오류

JSON은 요약과 원본 표본을 함께 저장하고 같은 경로에 CSV도 생성합니다. 최종 보고에는 평균만 쓰지 말고 중앙값과 p95를 함께 제시합니다.

## 해석 시 주의점

- 두 방식 모두 클라이언트 요청 시작부터 결과 수신까지의 검색 지연을 측정합니다.
- `hybrid`의 SQL 후보 경로는 현재 애플리케이션처럼 후보 임베딩을 페이지 단위로 받아 로컬에서 정확 코사인을 계산하므로 DB 왕복과 전송 시간도 포함합니다.
- HNSW의 `candidate_count`는 RPC 정책상 탐색 후 재정렬 대상으로 요청된 수(테이블당 50~100개)입니다. HNSW 내부에서 방문한 모든 노드 수는 아닙니다.
- 실험 중 다른 DB 부하, 리전, 네트워크가 결과에 영향을 줄 수 있으므로 동일 시간대·동일 DB에서 paired 방식으로 실행하고 최소 3회 반복합니다.
- 정확한 결과 비교가 목적이면 전수 비교 Top-K와 hybrid Top-K의 recall@K도 별도 측정해야 합니다. 이 스크립트의 주 지표는 검색 지연과 후보 수입니다.
