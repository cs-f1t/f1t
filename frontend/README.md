# F1T Frontend

Vite/React 기반의 패션 검색 UI입니다. 백엔드 API는 저장소 루트에서 `uvicorn backend.api:app --host 0.0.0.0 --port 8000`로 실행합니다.

운영 화면은 [https://f1t-clean-front.vercel.app/](https://f1t-clean-front.vercel.app/)에서 확인할 수 있습니다.

## 검색 연결 방식

1. 앱 진입 시 `/health`를 호출해 검색 백엔드를 미리 준비합니다.
2. 텍스트나 이미지를 제출하면 `multipart/form-data`로 백엔드의 `/search`를 호출합니다.
3. 일시적인 네트워크 오류 또는 `502`, `503`, `504` 응답에는 검색을 한 번만 재시도합니다.

검색 API를 사용할 수 없으면 오류 메시지를 표시합니다. 카테고리 탐색 화면의 상품 목록은 Supabase REST를 별도로 사용합니다.

`VITE_SUPABASE_ANON_KEY`는 RLS가 적용된 공개용 키만 사용합니다. Supabase `service_role` 키와 Gemini API 키는 브라우저 번들에 포함하지 않고 백엔드 환경변수로만 관리합니다.

## 환경 설정

프론트엔드 폴더에서 처음 한 번만 의존성을 설치하고 로컬 환경변수 파일을 만듭니다.

```bash
cd frontend
npm install
cp .env.example .env.local
```

`frontend/.env.local`에는 Vercel 대시보드에도 넣을 공개 설정값을 채웁니다.

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_BASE_URL=http://localhost:8000
```

## 실행

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

브라우저에서는 `http://127.0.0.1:5173/`로 접속합니다.

## 개발 명령

```bash
npm run lint
npm run build
npm run preview
```
