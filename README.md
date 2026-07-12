# F1T — Fashion Intention Translator

> 자연어 요청과 참고 이미지를 함께 해석해, 사용자가 원하는 조건에 가까운 패션 상품과 추천 이유를 제공하는 멀티모달 검색 시스템입니다.

<p align="center">
  <img src="https://img.shields.io/badge/기간-2026.03--2026.06-4C6EF5" alt="프로젝트 기간: 2026.03–2026.06" />
  <img src="https://img.shields.io/badge/공학종합설계-우수작_선정-FF922B" alt="공학종합설계 우수작 선정" />
  <img src="https://img.shields.io/badge/Gemini-3.5_Flash-8E75B2" alt="Gemini 3.5 Flash" />
  <img src="https://img.shields.io/badge/Supabase-pgvector-3ECF8E" alt="Supabase pgvector" />
</p>

---

## 👗 프로젝트 소개

기존 패션 검색은 사용자가 상품명이나 카테고리를 정확히 알고 있다는 전제에 가깝습니다. F1T는 “출근할 때 입을 단정한 옷”, “이 사진과 비슷하지만 검은색인 재킷”처럼 **상황·스타일·참고 이미지가 섞인 요청**을 검색 가능한 조건으로 변환합니다.

- **텍스트 검색:** 자연어에서 사용자가 직접 언급한 카테고리, 색상, 소재, 스타일 등의 조건을 추출합니다.
- **이미지 + 텍스트 검색:** 참고 이미지의 시각적 특징과 추가 요청을 통합하되, 두 정보가 충돌하면 사용자가 명시한 텍스트 조건을 우선합니다.
- **19,833개 상품 검색:** 정형 메타데이터로 후보군을 먼저 줄인 뒤 임베딩 유사도로 순위를 계산합니다.
- **VLM 과잉 추론 억제:** 모델이 언급되지 않은 속성을 임의로 채우지 않도록 ‘언급 속성 식별’과 ‘속성값 추출’을 분리했습니다.

## 🏆 주요 결과

| 항목 | 결과 |
| --- | ---: |
| 공학종합설계 | 우수작 선정 |
| 패션 상품 데이터 | 19,833개 |
| 평가 질의 | 102개 |
| Top-1 완전 적합 | 80건 (78.4%) |
| Top-1 부분 적합 포함 | 97건 (95.1%) |
| 평균 검색 후보 | 19,833개 → 2,707개 |
| 후보 축소율 | 86.35% |

> 정량 결과는 102개 질의에 대한 **Top-1 수동 적합도 평가**입니다. 완전 적합 80건, 부분 적합 17건, 실패 5건으로 분류했습니다.

## 🔄 추천 파이프라인

```mermaid
flowchart LR
    A["사용자 입력<br/>자연어 · 참고 이미지"]

    subgraph P1["정형 조건 검색"]
        B["보수적 의도 추출"]
        C["Supabase 테이블 라우팅<br/>메타데이터 후보 축소"]
        B --> C
    end

    subgraph P2["의미 기반 검색"]
        D["Target Description 생성"]
        E["Gemini 텍스트 임베딩"]
        D --> E
    end

    F["소재 조건이 있을 때<br/>소재 임베딩 생성"]
    G["후보군과 임베딩 결합"]
    H["가중 유사도 랭킹<br/>이미지 0.8 + 소재 0.2"]
    I["Top 10 상품"]
    J["한국어 추천 이유 생성"]

    A --> B
    A --> D
    B -. 소재 조건 .-> F
    C --> G
    E --> G
    F --> G
    G --> H --> I --> J
```

의도 추출과 Target Description 생성을 병렬로 수행하고, 정형 필터링과 임베딩 검색 결과를 결합해 최종 순위를 계산합니다.

## 🧠 핵심 기술 설계

### 1. 명시된 속성만 추출하는 2단계 의도 분석

VLM에 모든 속성값을 한 번에 생성하게 하면 사용자가 말하지 않은 색상·소재·스타일까지 추정하는 문제가 발생합니다. 이를 줄이기 위해 먼저 질의에 **명시된 속성의 종류**를 찾고, 다음 단계에서 해당 속성의 값만 추출합니다. 카테고리는 검색 테이블 선택에 필요하므로 문맥상 명확할 때만 제한적으로 도출합니다.

- 구현: [`pipeline/intent/intent_extraction.py`](pipeline/intent/intent_extraction.py)

### 2. 정형 메타데이터 기반 후보 축소

추출한 의도를 상품 DB의 카테고리별 Supabase 테이블과 연결합니다. 카테고리, 색상, 소재, 소매 등 정형 속성을 쿼리에 적용해 전체 상품을 직접 벡터 비교하지 않고 검색 대상부터 줄입니다.

- 구현: [`pipeline/retrieval/candidate_selection.py`](pipeline/retrieval/candidate_selection.py)

### 3. 텍스트 우선 멀티모달 Target Description

참고 이미지에서 보이는 특징과 자연어 요청을 하나의 검색 문장인 **Target Description**으로 통합합니다. 이미지와 텍스트가 충돌하면 “검은색으로 바꿔줘”처럼 사용자가 명시한 텍스트를 우선하고, 이미지에서 확인할 수 없는 특징은 임의로 추가하지 않습니다.

이 설계는 [Reason-before-Retrieve](https://openaccess.thecvf.com/content/CVPR2025/html/Tang_Reason-before-Retrieve_One-Stage_Reflective_Chain-of-Thoughts_for_Training-Free_Zero-Shot_Composed_Image_Retrieval_CVPR_2025_paper.html)의 검색 전 의미 재구성 아이디어를 참고했으며, 패션 속성 추출과 상품 검색 구조에 맞게 프롬프트와 파이프라인을 확장했습니다.

- 구현: [`pipeline/target_description/target_description_generation.py`](pipeline/target_description/target_description_generation.py)

### 4. 이미지·소재 임베딩 가중 랭킹

후보 상품의 이미지 임베딩과 Target Description 임베딩의 유사도를 기본 점수로 사용합니다. 소재 조건이 있는 경우에는 별도 소재 임베딩 유사도를 추가해 **이미지–Target Description 유사도 0.8 + 소재 유사도 0.2**로 최종 점수를 계산합니다. 소재 조건이 없으면 이미지 유사도만 사용합니다.

- 구현: [`pipeline/recommendation_service.py`](pipeline/recommendation_service.py), [`pipeline/retrieval/target_description_retrieval.py`](pipeline/retrieval/target_description_retrieval.py)

### 5. 검색 근거를 보여주는 한국어 추천 이유

최종 상품 목록만 반환하지 않고 원문 질의, 추출 속성, Target Description, 상품 정보를 함께 사용해 한국어 추천 이유를 생성합니다. 사용자는 어떤 조건이 상품 선택에 반영됐는지 결과 화면에서 확인할 수 있습니다.

- 구현: [`pipeline/target_description/recommendation_explanation.py`](pipeline/target_description/recommendation_explanation.py)

## 📊 평가 방식

평가 질의 102개를 텍스트 질의와 이미지 포함 질의로 구성하고, 각 검색 결과의 첫 번째 상품이 요청 조건을 얼마나 충족하는지 수동으로 판정했습니다.

| 판정 | 기준 | 결과 |
| --- | --- | ---: |
| 완전 적합 | 핵심 조건을 모두 충족 | 80건 |
| 부분 적합 | 주요 조건은 충족하지만 일부 속성이 다름 | 17건 |
| 실패 | 핵심 조건을 충족하지 못함 | 5건 |

정형 필터링으로 평균 후보 수를 19,833개에서 2,707개로 줄여, 전체 상품을 매번 비교하지 않으면서도 부분 적합을 포함한 Top-1 적합률 95.1%를 기록했습니다.

## 👥 팀 구성 및 역할

| 이름 | 역할 | 담당 업무 |
| --- | --- | --- |
| **허원준** | **Team Leader** | 전체 코드 관리, Target Description 생성, 최종 검색·랭킹 및 추천 이유 파이프라인, 비용 관리 |
| 김상훈 | Team Member | 문서 관리, 테스트 질의 구성·시각 평가, 상품 데이터 크롤링 |
| 김재혁 | Team Member | 상품 DB 구축·관리, 메타데이터 정리, 이미지·소재 임베딩 구축 |
| 박주현 | Team Member | VLM 메타데이터 추출, 의도 기반 후보 필터링 설계, 프로젝트 진행 관리 |

## 🛠️ 기술 스택

| 영역 | 기술 |
| --- | --- |
| VLM · 생성 모델 | Gemini 3.5 Flash |
| 임베딩 | Gemini Embedding 2 (768차원) |
| 데이터베이스 | Supabase, PostgreSQL, pgvector |
| 백엔드 | Python, FastAPI, Uvicorn |
| 프론트엔드 | React, TypeScript, Vite, Tailwind CSS |

## 📁 저장소 구조

```text
f1t_clean_publish/
├── backend/                    # FastAPI 엔드포인트와 요청·응답 처리
├── pipeline/
│   ├── intent/                 # 자연어 의도 및 명시 속성 추출
│   ├── retrieval/              # 후보 필터링과 임베딩 검색
│   ├── target_description/     # 검색 문장과 추천 이유 생성
│   └── recommendation_service.py  # 전체 추천 파이프라인 오케스트레이션
└── frontend/                   # React 기반 검색·결과 화면
```

배포용 스냅샷에는 런타임에 필요하지 않은 실험·원천 데이터 디렉터리가 포함되지 않습니다.

## ▶️ 실행 방법

### 1. 저장소 받기

```bash
cd <프로젝트를 받을 상위 폴더>
git clone https://github.com/cs-f1t/f1t_clean.git
cd f1t_clean
```

### 2. 백엔드 환경 구성

```bash
conda create -n f1t python=3.11 -y
conda activate f1t
pip install -r backend/requirements.txt
cp pipeline/.env.example pipeline/.env
```

[`pipeline/.env`](pipeline/.env.example)에 다음 환경변수를 설정합니다.

```env
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
FRONTEND_ORIGINS=http://localhost:5173
```

### 3. 프론트엔드 환경 구성

```bash
cd frontend
npm install
cp .env.example .env.local
cd ..
```

[`frontend/.env.local`](frontend/.env.example)에 다음 공개 설정값을 입력합니다.

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_BASE_URL=http://localhost:8000
```

### 4. 서버 실행

백엔드:

```bash
conda activate f1t
uvicorn backend.api:app --host 0.0.0.0 --port 8000
```

프론트엔드:

```bash
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

브라우저에서 `http://127.0.0.1:5173/`로 접속합니다. 모든 명령은 저장소 루트에서 시작한다고 가정합니다.

## 📚 참고 연구

- [Reason-before-Retrieve: One-Stage Reflective Chain-of-Thoughts for Training-Free Zero-Shot Composed Image Retrieval (CVPR 2025)](https://openaccess.thecvf.com/content/CVPR2025/html/Tang_Reason-before-Retrieve_One-Stage_Reflective_Chain-of-Thoughts_for_Training-Free_Zero-Shot_Composed_Image_Retrieval_CVPR_2025_paper.html)
