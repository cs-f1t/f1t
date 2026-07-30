import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'

import {
  fetchCategoryRows,
  fetchProducts,
  getProductImageUrl,
  getProductThumbnailUrl,
  getSupabaseImageThumbnailUrl,
  hasSupabaseConfig,
} from './lib/supabaseRest'
import {
  fetchProviderModels,
  getBaselineImageUrl,
  hasBaselineSearchConfig,
  searchBaseline,
  warmBaselineSearch,
} from './lib/baselineSearch'
import type { BaselineSearchResponse, ProviderModels } from './lib/baselineSearch'
import type { CategoryRow } from './lib/supabaseRest'
import type { Product, ProductTable } from './types/product'

type CategoryGroup = {
  id: string
  label: string
  table: ProductTable
  category1?: string
  category2Keyword?: string
}

type ActiveCategory = {
  id: string
  label: string
  isAll?: boolean
  table?: ProductTable
  category2?: string
  category2Keyword?: string
}

type SelectedImage = {
  file: File
  previewUrl: string
}

type RecentSearchItem = {
  id: string
  query: string
  mode?: string
  submittedHadImage?: boolean
  categoryId?: string
  categoryLabel?: string
  products?: Product[]
  totalProductCount?: number | null
  baselineSearchResponse?: BaselineSearchResponse
}

type ReasoningBadge = {
  label: string
  title: string
  tone: 'neutral' | 'warning' | 'fallback'
}

type ModalPageId = 'about'
type NavItemId = 'home' | ModalPageId

const categoryGroups: CategoryGroup[] = [
  { id: 'tops', label: '상의', table: 'musinsa_top_clothes' },
  { id: 'pants', label: '바지', table: 'musinsa_pants' },
  {
    id: 'dresses',
    label: '원피스',
    table: 'musinsa_skirt_dress',
    category2Keyword: '원피스',
  },
  {
    id: 'skirts',
    label: '스커트',
    table: 'musinsa_skirt_dress',
    category2Keyword: '스커트',
  },
]

const PRODUCTS_PER_PAGE = 20
const SEARCH_PROGRESS_INTERVAL_MS = 2600
const allCategory: ActiveCategory = {
  id: 'all',
  label: '전체',
  isAll: true,
}
const imageReferenceQueryPattern =
  /(이\s*(이미지|사진|옷|상품|디자인|스타일|거|것)|이미지처럼|사진처럼|첨부|올린\s*(이미지|사진)|여기서|이거랑|이\s*옷이랑)/
const pageNavItems: { id: NavItemId; label: string }[] = [
  { id: 'home', label: '홈' },
  { id: 'about', label: '소개' },
]

const defaultRecentSearches: RecentSearchItem[] = [
  {
    id: 'sample-1',
    query: '이 이미지랑 비슷한 색으로 긴소매 셔츠 찾아줘',
  },
  {
    id: 'sample-2',
    query: '러닝할 때 입기 좋은 가벼운 바지 추천해줘',
  },
  {
    id: 'sample-3',
    query: '패턴 없는 미니멀한 원피스 찾아줘',
  },
]

const textSearchProgressSteps = [
  {
    title: '요청을 읽고 있어요',
    description:
      '색, 핏, 소재, 활용 상황 등 입력한 내용을 먼저 파악하고 있어요.',
  },
  {
    title: '핵심 조건을 고르고 있어요',
    description:
      '색, 핏, 소재, 활용 상황처럼 결과에 중요한 단서를 정리하고 있어요.',
  },
  {
    title: '후보 상품을 찾고 있어요',
    description:
      '요청에 맞는 후보들을 추리고 있어요.',
  },
]

const imageSearchProgressSteps = [
  {
    title: '이미지와 요청을 함께 보고 있어요',
    description:
      '첨부한 이미지에서 참고할 부분과 문장 속 조건을 나눠 읽고 있어요.',
  },
  {
    title: '이미지 디테일을 살펴보고 있어요',
    description:
      '색, 형태, 기장, 패턴처럼 검색에 필요한 단서를 잡고 있어요.',
  },
  {
    title: '조건을 맞춰보고 있어요',
    description:
      '이미지의 디테일과 입력한 조건을 함께 반영해 후보 기준을 정리하고 있어요.',
  },
  {
    title: '후보 상품을 찾고 있어요',
    description:
      '요청에 맞는 상품부터 확인할 수 있도록 결과를 추리고 있어요.',
  },
]

function getCategoryKey(category2: string) {
  return category2.toLowerCase()
}

function formatPrice(price: Product['price']) {
  if (price === null || price === undefined || price === '') {
    return ''
  }

  const numberPrice = Number(price)

  if (Number.isNaN(numberPrice)) {
    return String(price)
  }

  return `${numberPrice.toLocaleString('ko-KR')}원`
}

function handleImageFallback(event: SyntheticEvent<HTMLImageElement>) {
  const image = event.currentTarget
  const fallbackSrc = image.dataset.fallbackSrc

  if (!fallbackSrc || image.src === fallbackSrc) {
    return
  }

  image.removeAttribute('data-fallback-src')
  image.src = fallbackSrc
}

function _warningBelongsTo(code: string): string {
  if (code.startsWith('gemini_')) return 'gemini'
  if (code.startsWith('openai_')) return 'openai'
  if (code.startsWith('qwen_')) return 'qwen'
  return 'unknown'
}

function getReasoningBadges(
  reasoning?: BaselineSearchResponse['reasoning'],
  providerModels: ProviderModels = {},
  selectedProvider = 'gemini',
) {
  if (!reasoning) {
    return []
  }

  // qwen 선택 시 Gemini/OpenAI 관련 경고는 표시하지 않음
  const isLocalProvider = selectedProvider === 'qwen'
  const badges: ReasoningBadge[] = (reasoning.warnings ?? [])
    .filter((warning) => {
      if (!isLocalProvider) return true
      const belongs = _warningBelongsTo(warning.code)
      return belongs !== 'gemini' && belongs !== 'openai'
    })
    .map((warning) => ({
      label: warning.label,
      title: warning.message,
      tone: 'warning' as const,
    }))

  const providerLabel = reasoning.provider
    ? (providerModels[reasoning.provider] ?? reasoning.provider)
    : null

  if (providerLabel && (reasoning.status === 'ok' || reasoning.status === 'fallback')) {
    badges.push({
      label: providerLabel,
      title: reasoning.status === 'fallback'
        ? `${providerLabel}로 fallback 처리했습니다.`
        : `${providerLabel}로 요청을 해석했습니다.`,
      tone: reasoning.status === 'fallback' ? 'fallback' as const : 'neutral' as const,
    })
  }

  if (reasoning.provider === 'raw_query') {
    badges.push({
      label: '원문 fallback',
      title: '모델 해석을 건너뛰고 입력 문장으로 검색했습니다.',
      tone: 'fallback' as const,
    })
  }

  const seen = new Set<string>()
  return badges.filter((badge) => {
    if (seen.has(badge.label)) {
      return false
    }

    seen.add(badge.label)
    return true
  })
}

function getReasoningBadgeClass(tone: 'neutral' | 'warning' | 'fallback') {
  if (tone === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-700'
  }

  if (tone === 'fallback') {
    return 'border-sky-200 bg-sky-50 text-sky-700'
  }

  return 'border-slate-200 bg-white text-slate-500'
}

function getSearchModeLabel(
  mode?: string,
  pipeline?: BaselineSearchResponse['pipeline'],
  fallbackLabel?: string,
) {
  if (pipeline?.label) {
    return pipeline.label
  }

  if (mode === 'supabase_vector') {
    return 'Vector 검색'
  }

  if (mode === 'baseline') {
    return 'Baseline 검색'
  }

  return fallbackLabel ?? '상품 결과'
}

const attributeDisplayLabels: Record<string, string> = {
  sleeve: '소매',
  length: '기장',
  color: '색상',
  category1: '카테고리',
  sex: '성별',
  season: '시즌',
  stretch: '신축성',
  thickness: '두께',
  fit: '핏',
  fabric: '소재',
}

const intentDisplayLabels: Record<string, string> = {
  attribute: '속성 검색',
  attribute_with_tpo_context: 'TPO 포함 속성 검색',
  abstract_tpo: 'TPO 검색',
}

function getParsedAttributeItems(pipeline?: BaselineSearchResponse['pipeline']) {
  return Object.entries(pipeline?.parsed_attributes ?? {})
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => ({
      key,
      label: attributeDisplayLabels[key] ?? key,
      value,
    }))
}

function AboutPage() {
  return (
    <section>
      <p className="text-sm font-medium text-slate-500">About F1T</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 md:text-3xl">
        이미지와 말로 원하는 옷을 더 정확하게 찾습니다
      </h1>
      <p className="mt-5 text-base leading-7 text-slate-600">
        F1T는 마음에 든 이미지나 자연스러운 문장을 바탕으로 색, 핏, 패턴,
        소재, 활용 상황 등을 함께 반영해 패션 상품을 찾는 서비스입니다.
      </p>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-base font-semibold text-slate-950">
            이미지로 시작
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            참고하고 싶은 옷 사진을 올리고, 비슷하게 유지할 부분을 기준으로
            검색할 수 있습니다.
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-base font-semibold text-slate-950">
            말로 조건 추가
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            색을 바꾸거나, 패턴을 빼거나, 입을 상황을 더하는 식으로 원하는
            조건을 편하게 입력할 수 있습니다.
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-base font-semibold text-slate-950">
            AI 검색으로 후보 정렬
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            이미지와 문장에서 검색 의도를 정리한 뒤, 상품의 시각적 특징과
            속성을 함께 비교해 요청에 가까운 순서로 결과를 제공합니다.
          </p>
        </article>
      </div>

      <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-6">
        <h2 className="text-lg font-semibold text-slate-950">F1T 검색 방식</h2>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          F1T는 Supabase 상품 데이터와 멀티모달 검색 파이프라인을 연결해
          카테고리, 색상, 핏, 소재 같은 조건과 이미지의 분위기를 함께
          해석합니다. 단순 키워드 일치에 그치지 않고 사용자가 설명한 의도와
          가까운 상품을 찾아 비교할 수 있도록 돕습니다.
        </p>
      </div>
    </section>
  )
}

function PolicyModal({
  onClose,
}: {
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      onMouseDown={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl md:p-12"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2
            id="about-modal-title"
            className="text-sm font-semibold text-slate-400"
          >
            서비스 소개
          </h2>

          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-lg leading-none text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950"
            aria-label="팝업 닫기"
          >
            ×
          </button>
        </div>

        <AboutPage />
      </div>
    </div>
  )
}

function App() {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const resultsSectionRef = useRef<HTMLDivElement | null>(null)
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null)
  const categoryGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const sidebarAnchorRestoreTimeoutsRef = useRef<number[]>([])
  const pendingScrollAdjustRef = useRef<{
    groupId: string
    previousTop: number
  } | null>(null)
  const requestIdRef = useRef(0)
  const searchDelayRef = useRef<number | null>(null)
  const searchCompleteDelayRef = useRef<number | null>(null)
  const searchCompleteHideDelayRef = useRef<number | null>(null)
  const shouldShowSearchCompleteRef = useRef(false)
  const [activeModal, setActiveModal] = useState<ModalPageId | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [activeCategoryId, setActiveCategoryId] = useState('all')
  const [openCategoryIds, setOpenCategoryIds] = useState(() => new Set<string>())
  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>([])
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [submittedHadImage, setSubmittedHadImage] = useState(false)
  const [searchRunId, setSearchRunId] = useState(0)
  const [isUnderstandingRequest, setIsUnderstandingRequest] = useState(false)
  const [isSearchCompleteVisible, setIsSearchCompleteVisible] = useState(false)
  const [searchProgressIndex, setSearchProgressIndex] = useState(0)
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null)
  const [isImageDragging, setIsImageDragging] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState('gemini')
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false)
  const [providerModels, setProviderModels] = useState<ProviderModels>({
    gemini: 'gemini-3.5-flash',
    openai: 'gpt-5.4-nano',
    qwen: 'qwen3.5-0.8B',
  })
  const [baselineSearchResponse, setBaselineSearchResponse] =
    useState<BaselineSearchResponse | null>(null)
  const [recentSearches, setRecentSearches] = useState(defaultRecentSearches)
  const [likedItemIds, setLikedItemIds] = useState(() => new Set<string>())
  const [products, setProducts] = useState<Product[]>([])
  const [totalProductCount, setTotalProductCount] = useState<number | null>(null)
  const [selectedProductForDetail, setSelectedProductForDetail] = useState<Product | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const categoryTree = useMemo(
    () =>
      categoryGroups.map((group) => {
        const seenCategory2 = new Set<string>()
        const children = categoryRows
          .filter((row) => {
            if (row.table !== group.table) {
              return false
            }

            if (group.category1 && row.category1 !== group.category1) {
              return false
            }

            if (
              group.category2Keyword &&
              !row.category2.includes(group.category2Keyword)
            ) {
              return false
            }

            return true
          })
          .filter((row) => {
            const categoryKey = getCategoryKey(row.category2)

            if (seenCategory2.has(categoryKey)) {
              return false
            }

            seenCategory2.add(categoryKey)
            return true
          })
          .sort((a, b) => a.category2.localeCompare(b.category2, 'ko-KR'))

        return { ...group, children }
      }),
    [categoryRows],
  )

  const activeCategory: ActiveCategory = (() => {
    if (activeCategoryId === allCategory.id) {
      return allCategory
    }

    for (const group of categoryTree) {
      if (activeCategoryId === group.id) {
        return group
      }

      const child = group.children.find(
        (row) => `${group.id}-${row.category2}` === activeCategoryId,
      )

      if (child) {
        return {
          id: `${group.id}-${child.category2}`,
          label: child.category2,
          table: child.table,
          category2: child.category2,
        }
      }
    }

    return categoryGroups[0]
  })()

  const searchProgressSteps = selectedImage
    ? imageSearchProgressSteps
    : textSearchProgressSteps
  const currentSearchProgress =
    searchProgressSteps[
      Math.min(searchProgressIndex, searchProgressSteps.length - 1)
    ]
  const requestSummaryItems = useMemo(() => {
    const items: string[] = []

    if (activeCategory.label !== allCategory.label) {
      items.push(activeCategory.label)
    }

    if (submittedHadImage) {
      items.push('이미지 참고')
    }

    if (submittedQuery) {
      items.push(submittedQuery)
    }

    return items
  }, [activeCategory.label, submittedHadImage, submittedQuery])
  const baselineResults = baselineSearchResponse?.results ?? []
  const isBaselineSearch = Boolean(baselineSearchResponse)
  const hasSubmittedSearch = isBaselineSearch || Boolean(submittedQuery) || submittedHadImage
  const reasoningBadges = useMemo(
    () => getReasoningBadges(baselineSearchResponse?.reasoning, providerModels, selectedProvider),
    [baselineSearchResponse?.reasoning, providerModels, selectedProvider],
  )
  const parsedAttributeItems = useMemo(
    () => getParsedAttributeItems(baselineSearchResponse?.pipeline),
    [baselineSearchResponse?.pipeline],
  )
  const pipelineIntentLabel = baselineSearchResponse?.pipeline?.intent_type
    ? intentDisplayLabels[baselineSearchResponse.pipeline.intent_type] ??
      baselineSearchResponse.pipeline.intent_type
    : ''
  const detailTargetDescription =
    baselineSearchResponse?.pipeline?.detail_target_description ?? ''
  const shouldShowPipelineExtraction =
    isBaselineSearch &&
    (parsedAttributeItems.length > 0 ||
      Boolean(detailTargetDescription) ||
      Boolean(pipelineIntentLabel))

  useEffect(() => {
    void warmBaselineSearch()

    fetchProviderModels().then((models) => {
      if (Object.keys(models).length > 0) {
        setProviderModels(models)
      }
    })
  }, [])

  useEffect(() => {
    let ignore = false

    async function loadCategories() {
      if (!hasSupabaseConfig()) {
        return
      }

      try {
        const rows = (
          await Promise.all([
            fetchCategoryRows('musinsa_top_clothes'),
            fetchCategoryRows('musinsa_skirt_dress'),
            fetchCategoryRows('musinsa_pants'),
          ])
        ).flat()

        if (!ignore) {
          setCategoryRows(rows)
        }
      } catch {
        if (!ignore) {
          setCategoryRows([])
        }
      }
    }

    loadCategories()

    return () => {
      ignore = true
    }
  }, [])

  const loadProductPage = useCallback(
    async (offset: number, append: boolean, requestId = requestIdRef.current) => {
      if (!hasSupabaseConfig()) {
        setErrorMessage(
          'Supabase 연결을 위해 frontend/.env.local에 공개용 anon key를 설정해 주세요.',
        )
        return
      }

      setIsLoading(true)
      setErrorMessage('')

      if (!append) {
        setTotalProductCount(null)
      }

      try {
        let result: Awaited<ReturnType<typeof fetchProducts>>

        if (activeCategory.isAll) {
          const limitPerGroup = Math.ceil(
            PRODUCTS_PER_PAGE / categoryGroups.length,
          )
          const offsetPerGroup = Math.floor(offset / categoryGroups.length)
          const tableResults = await Promise.all(
            categoryGroups.map((group) =>
              fetchProducts({
                table: group.table,
                category1: group.category1,
                category2Keyword: group.category2Keyword,
                searchText: submittedQuery,
                offset: offsetPerGroup,
                limit: limitPerGroup,
              }),
            ),
          )

          result = {
            products: tableResults.flatMap(
              (tableResult) => tableResult.products,
            ),
            totalCount: tableResults.reduce(
              (sum, tableResult) => sum + tableResult.totalCount,
              0,
            ),
          }
        } else {
          result = await fetchProducts({
            table: activeCategory.table ?? 'musinsa_top_clothes',
            category2: activeCategory.category2,
            category2Keyword: activeCategory.category2Keyword,
            searchText: submittedQuery,
            offset,
            limit: PRODUCTS_PER_PAGE,
          })
        }

        if (requestId === requestIdRef.current) {
          setTotalProductCount(result.totalCount)
          setProducts((currentProducts) =>
            append ? [...currentProducts, ...result.products] : result.products,
          )

          if (!append && (submittedQuery || submittedHadImage)) {
            saveRecentSearchSnapshot({
              id: `catalog-${Date.now()}`,
              query: getSearchTitle(submittedQuery, submittedHadImage),
              mode: 'catalog',
              categoryId: activeCategoryId,
              categoryLabel: activeCategory.label,
              submittedHadImage,
              products: result.products,
              totalProductCount: result.totalCount,
            })
          }

          if (!append && shouldShowSearchCompleteRef.current) {
            shouldShowSearchCompleteRef.current = false
            setIsUnderstandingRequest(false)
            setIsSearchCompleteVisible(true)

            if (searchCompleteDelayRef.current) {
              window.clearTimeout(searchCompleteDelayRef.current)
            }

            if (searchCompleteHideDelayRef.current) {
              window.clearTimeout(searchCompleteHideDelayRef.current)
            }

            searchCompleteDelayRef.current = window.setTimeout(() => {
              resultsSectionRef.current?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
              })
            }, 300)

            searchCompleteHideDelayRef.current = window.setTimeout(() => {
              setIsSearchCompleteVisible(false)
            }, 700)
          }
        }
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : '상품을 불러오는 중 문제가 생겼습니다.',
          )
          setIsUnderstandingRequest(false)
          if (!append) {
            setProducts([])
            setTotalProductCount(null)
          }
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    },
    [
      activeCategory.category2,
      activeCategory.category2Keyword,
      activeCategory.isAll,
      activeCategory.table,
      activeCategory.label,
      activeCategoryId,
      submittedHadImage,
      submittedQuery,
    ],
  )

  useEffect(() => {
    if (baselineSearchResponse || submittedHadImage) {
      return
    }

    requestIdRef.current += 1
    const requestId = requestIdRef.current

    const loadTimer = window.setTimeout(() => {
      loadProductPage(0, false, requestId)
    }, 0)

    return () => window.clearTimeout(loadTimer)
  }, [
    activeCategoryId,
    baselineSearchResponse,
    categoryTree,
    loadProductPage,
    searchRunId,
    submittedHadImage,
    submittedQuery,
  ])

  const hasMoreProducts =
    totalProductCount === null || products.length < totalProductCount

  useEffect(() => {
    const sentinel = loadMoreRef.current

    if (
      !sentinel ||
      isLoading ||
      errorMessage ||
      products.length === 0 ||
      !hasMoreProducts
    ) {
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          loadProductPage(products.length, true)
        }
      },
      { rootMargin: '600px 0px' },
    )

    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [
    errorMessage,
    hasMoreProducts,
    isLoading,
    loadProductPage,
    products.length,
  ])

  useEffect(() => {
    return () => {
      if (selectedImage) {
        URL.revokeObjectURL(selectedImage.previewUrl)
      }
    }
  }, [selectedImage])

  useEffect(
    () => () => {
      if (searchDelayRef.current) {
        window.clearTimeout(searchDelayRef.current)
      }

      if (searchCompleteDelayRef.current) {
        window.clearTimeout(searchCompleteDelayRef.current)
      }

      if (searchCompleteHideDelayRef.current) {
        window.clearTimeout(searchCompleteHideDelayRef.current)
      }

      sidebarAnchorRestoreTimeoutsRef.current.forEach((timeoutId) =>
        window.clearTimeout(timeoutId),
      )
    },
    [],
  )

  useEffect(() => {
    if (!isUnderstandingRequest) {
      return
    }

    const progressInterval = window.setInterval(() => {
      setSearchProgressIndex((currentIndex) => {
        if (currentIndex >= searchProgressSteps.length - 1) return currentIndex
        return currentIndex + 1
      })
    }, SEARCH_PROGRESS_INTERVAL_MS)

    return () => window.clearInterval(progressInterval)
  }, [isUnderstandingRequest, searchProgressSteps.length])

  useEffect(() => {
    if (!activeModal) {
      return
    }

    function handleEscapeKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setActiveModal(null)
      }
    }

    window.addEventListener('keydown', handleEscapeKey)

    return () => window.removeEventListener('keydown', handleEscapeKey)
  }, [activeModal])

  // 카테고리 토글 후 헤더가 화면에서 같은 위치에 오도록 scrollTop 보정
  useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current
    if (!pending) return
    pendingScrollAdjustRef.current = null

    const headerEl = categoryGroupRefs.current.get(pending.groupId)
    const navEl = sidebarScrollRef.current
    if (!headerEl || !navEl) return

    sidebarAnchorRestoreTimeoutsRef.current.forEach((timeoutId) =>
      window.clearTimeout(timeoutId),
    )

    sidebarAnchorRestoreTimeoutsRef.current = [0, 40, 100, 180, 260].map(
      (delay) =>
        window.setTimeout(() => {
          const currentHeaderEl = categoryGroupRefs.current.get(pending.groupId)
          const currentNavEl = sidebarScrollRef.current

          if (!currentHeaderEl || !currentNavEl) {
            return
          }

          const topDiff =
            currentHeaderEl.getBoundingClientRect().top - pending.previousTop
          currentNavEl.scrollTop += topDiff
        }, delay),
    )
  }, [openCategoryIds])

  function toggleCategory(groupId: string) {
    const headerEl = categoryGroupRefs.current.get(groupId)

    if (headerEl) {
      pendingScrollAdjustRef.current = {
        groupId,
        previousTop: headerEl.getBoundingClientRect().top,
      }
    }

    setOpenCategoryIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(groupId)) nextIds.delete(groupId)
      else nextIds.add(groupId)
      return nextIds
    })
  }

  function handleCategorySelect(categoryId: string) {
    setBaselineSearchResponse(null)
    setActiveCategoryId(categoryId)
  }

  function getSearchTitle(queryText: string, hadImage: boolean) {
    if (queryText) {
      return queryText
    }

    return hadImage ? '이미지로 검색' : ''
  }

  function needsReferenceImage(queryText: string) {
    return imageReferenceQueryPattern.test(queryText.replace(/\s+/g, ' '))
  }

  function saveRecentSearchSnapshot(searchItem: RecentSearchItem) {
    if (!searchItem.query) {
      return
    }

    setRecentSearches((currentSearches) => [
      searchItem,
      ...currentSearches.filter((item) => item.query !== searchItem.query),
    ].slice(0, 5))
  }

  function restoreRecentSearch(searchItem: RecentSearchItem) {
    setQuery(searchItem.query)
    setErrorMessage('')

    if (!searchItem.baselineSearchResponse && !searchItem.products) {
      setIsSidebarOpen(false)
      return
    }

    if (searchItem.categoryId) {
      setActiveCategoryId(searchItem.categoryId)
    }

    if (searchItem.baselineSearchResponse) {
      setBaselineSearchResponse(searchItem.baselineSearchResponse)
      setProducts([])
      setTotalProductCount(searchItem.baselineSearchResponse.results.length)
    } else if (searchItem.products) {
      setBaselineSearchResponse(null)
      setProducts(searchItem.products)
      setTotalProductCount(searchItem.totalProductCount ?? searchItem.products.length)
    } else {
      setBaselineSearchResponse(null)
    }

    setSubmittedQuery(searchItem.query)
    setSubmittedHadImage(Boolean(searchItem.submittedHadImage))
    setIsSidebarOpen(false)
    setIsUnderstandingRequest(false)
    setIsSearchCompleteVisible(false)
    resultsSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  function toggleLikedItem(itemId: string) {
    setLikedItemIds((currentIds) => {
      const nextIds = new Set(currentIds)

      if (nextIds.has(itemId)) {
        nextIds.delete(itemId)
      } else {
        nextIds.add(itemId)
      }

      return nextIds
    })
  }

  async function runSubmittedSearch(
    queryText: string,
    imageFile: File | null,
    requestId: number,
  ) {
    const searchTitle = getSearchTitle(queryText, Boolean(imageFile))

    if (!queryText && !imageFile) {
      if (requestId !== requestIdRef.current) {
        return
      }

      setBaselineSearchResponse(null)
      setProducts([])
      setTotalProductCount(null)
      setErrorMessage('검색어를 입력하거나 이미지를 추가해 주세요.')
      setIsUnderstandingRequest(false)
      setIsSearchCompleteVisible(false)
      return
    }

    if (!hasBaselineSearchConfig()) {
      if (requestId !== requestIdRef.current) {
        return
      }

      setBaselineSearchResponse(null)
      setProducts([])
      setTotalProductCount(null)
      setErrorMessage(
        'Gemini 검색 API 주소가 설정되지 않았습니다. frontend/.env.local의 VITE_API_BASE_URL을 확인해 주세요.',
      )
      setIsUnderstandingRequest(false)
      setIsSearchCompleteVisible(false)
      return
    }

    try {
      const response = await searchBaseline({
        query: queryText,
        image: imageFile,
        topK: 10,
        table: activeCategory.isAll ? undefined : activeCategory.table,
        category2: activeCategory.isAll ? undefined : activeCategory.category2,
        category2Keyword: activeCategory.isAll
          ? undefined
          : activeCategory.category2Keyword,
        provider: selectedProvider,
      })

      if (requestId !== requestIdRef.current) {
        return
      }

      shouldShowSearchCompleteRef.current = false
      setSubmittedQuery(queryText)
      setSubmittedHadImage(Boolean(imageFile))
      setBaselineSearchResponse(response)
      setProducts([])
      setTotalProductCount(response.results.length)
      setErrorMessage('')
      setIsUnderstandingRequest(false)
      setIsSearchCompleteVisible(true)
      saveRecentSearchSnapshot({
        id: `baseline-${Date.now()}`,
        query: searchTitle,
        mode: response.mode,
        submittedHadImage: Boolean(imageFile),
        baselineSearchResponse: response,
      })

      if (searchCompleteDelayRef.current) {
        window.clearTimeout(searchCompleteDelayRef.current)
      }

      if (searchCompleteHideDelayRef.current) {
        window.clearTimeout(searchCompleteHideDelayRef.current)
      }

      searchCompleteDelayRef.current = window.setTimeout(() => {
        resultsSectionRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
      }, 900)

      searchCompleteHideDelayRef.current = window.setTimeout(() => {
        setIsSearchCompleteVisible(false)
      }, 1800)
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return
      }

      setSubmittedQuery(queryText)
      setSubmittedHadImage(Boolean(imageFile))
      setBaselineSearchResponse(null)
      setProducts([])
      setTotalProductCount(null)
      const message = error instanceof Error ? error.message : ''
      setErrorMessage(
        message && !message.toLowerCase().includes('failed to fetch')
          ? message
          : 'Gemini 검색 서버에 연결하지 못했습니다.',
      )
      setIsUnderstandingRequest(false)
      setIsSearchCompleteVisible(false)
    } finally {
      if (requestId === requestIdRef.current) {
        setIsUnderstandingRequest(false)
      }
    }
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()

    if (searchDelayRef.current) {
      window.clearTimeout(searchDelayRef.current)
    }

    if (searchCompleteDelayRef.current) {
      window.clearTimeout(searchCompleteDelayRef.current)
    }

    if (searchCompleteHideDelayRef.current) {
      window.clearTimeout(searchCompleteHideDelayRef.current)
    }

    setIsSearchCompleteVisible(false)
    setIsUnderstandingRequest(true)
    setSearchProgressIndex(0)
    const nextRequestId = requestIdRef.current + 1
    const queryText = query.trim()
    const imageFile = selectedImage?.file ?? null

    requestIdRef.current = nextRequestId

    if (queryText && !imageFile && needsReferenceImage(queryText)) {
      setBaselineSearchResponse(null)
      setProducts([])
      setTotalProductCount(null)
      setErrorMessage('이미지를 첨부하세요.')
      setIsUnderstandingRequest(false)
      return
    }

    void runSubmittedSearch(queryText, imageFile, nextRequestId)
  }

  function setImageFile(file: File) {
    setSelectedImage((currentImage) => {
      if (currentImage) {
        URL.revokeObjectURL(currentImage.previewUrl)
      }

      return {
        file,
        previewUrl: URL.createObjectURL(file),
      }
    })
  }

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file || !file.type.startsWith('image/')) {
      return
    }

    setImageFile(file)
  }

  function handleImageDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsImageDragging(true)
  }

  function handleImageDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsImageDragging(false)
    }
  }

  function handleImageDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsImageDragging(false)

    const file = event.dataTransfer.files?.[0]

    if (!file || !file.type.startsWith('image/')) {
      return
    }

    setImageFile(file)

    if (imageInputRef.current) {
      imageInputRef.current.value = ''
    }
  }

  function handleImageRemove(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    setSelectedImage((currentImage) => {
      if (currentImage) {
        URL.revokeObjectURL(currentImage.previewUrl)
      }

      return null
    })

    if (imageInputRef.current) {
      imageInputRef.current.value = ''
    }
  }

  function handleHomeClick() {
    if (searchDelayRef.current) {
      window.clearTimeout(searchDelayRef.current)
    }

    if (searchCompleteDelayRef.current) {
      window.clearTimeout(searchCompleteDelayRef.current)
    }

    if (searchCompleteHideDelayRef.current) {
      window.clearTimeout(searchCompleteHideDelayRef.current)
    }

    shouldShowSearchCompleteRef.current = false
    setActiveModal(null)
    setIsSidebarOpen(false)
    setActiveCategoryId(allCategory.id)
    setBaselineSearchResponse(null)
    setQuery('')
    setSubmittedQuery('')
    setSubmittedHadImage(false)
    setIsUnderstandingRequest(false)
    setIsSearchCompleteVisible(false)
    setSearchRunId((currentId) => currentId + 1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function handlePageClick(pageId: NavItemId) {
    if (pageId === 'home') {
      handleHomeClick()
      return
    }

    if (searchDelayRef.current) {
      window.clearTimeout(searchDelayRef.current)
    }

    if (searchCompleteDelayRef.current) {
      window.clearTimeout(searchCompleteDelayRef.current)
    }

    if (searchCompleteHideDelayRef.current) {
      window.clearTimeout(searchCompleteHideDelayRef.current)
    }

    shouldShowSearchCompleteRef.current = false
    setActiveModal(pageId)
    setIsSidebarOpen(false)
    setIsUnderstandingRequest(false)
    setIsSearchCompleteVisible(false)
  }

  const sidebarLabelClass = `whitespace-nowrap transition duration-200 ${
    isSidebarOpen
      ? 'translate-x-0 opacity-100 delay-100'
      : '-translate-x-2 opacity-0'
  }`
  const sidebarDetailClass = `transition duration-200 ${
    isSidebarOpen
      ? 'opacity-100 delay-100'
      : 'pointer-events-none opacity-0'
  }`

  const sidebarContent = (
    <div className="flex h-full min-h-0 flex-col px-4 py-6">
      <div
        className={`shrink-0 pb-5 ${
          isSidebarOpen ? 'border-b border-slate-200' : ''
        }`}
      >
        <div className="mb-8 flex h-12 items-center justify-between">
          <button
            type="button"
            onClick={() => setIsSidebarOpen((isOpen) => !isOpen)}
            className={`ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-white text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 ${
              isSidebarOpen
                ? 'border-slate-300 ring-2 ring-slate-200'
                : 'border-slate-200'
            }`}
            aria-label={isSidebarOpen ? '사이드바 닫기' : '사이드바 열기'}
          >
            <span className="flex w-4 flex-col gap-1">
              <span className="h-0.5 rounded-full bg-current" />
              <span className="h-0.5 rounded-full bg-current" />
              <span className="h-0.5 rounded-full bg-current" />
            </span>
          </button>

        </div>

        <div className="space-y-3">
          <button
            type="button"
            onClick={handleHomeClick}
            className="flex h-12 w-full items-center gap-4 overflow-hidden rounded-xl text-left text-sm font-semibold text-slate-700 transition hover:bg-white hover:text-slate-950 hover:shadow-sm"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-3xl font-light leading-none text-slate-500 transition group-hover:text-slate-950">
              +
            </span>
            <span className={sidebarLabelClass}>새 검색</span>
          </button>

        </div>
      </div>

      <div
        ref={sidebarScrollRef}
        className={`min-h-0 flex-1 overflow-y-auto py-5 pr-1 [overflow-anchor:none] ${sidebarDetailClass}`}
      >
        <section className="mb-7">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-950">
              이전 검색
            </h2>
            <span className="text-[11px] font-medium text-slate-400">
              임시 저장
            </span>
          </div>

          <div className="space-y-2">
            {recentSearches.map((recentSearch) => (
              <button
                key={recentSearch.id}
                type="button"
                onClick={() => restoreRecentSearch(recentSearch)}
                className="block w-full rounded-lg border border-transparent bg-white/60 px-3 py-2.5 text-left text-xs leading-5 text-slate-600 transition hover:border-slate-200 hover:bg-white hover:text-slate-950"
              >
                <span className="line-clamp-2">{recentSearch.query}</span>
                {recentSearch.mode && (
                  <span className="mt-1 block text-[11px] font-medium text-slate-400">
                    {getSearchModeLabel(
                      recentSearch.mode,
                      recentSearch.baselineSearchResponse?.pipeline,
                      recentSearch.categoryLabel ?? '상품 결과',
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>

        <nav className="space-y-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-950">
              카테고리
            </h2>
          </div>

          <button
            type="button"
            onClick={() => handleCategorySelect(allCategory.id)}
            className={`mb-4 flex min-h-10 w-full items-center rounded-lg px-3 text-left text-sm transition ${
              activeCategoryId === allCategory.id
                ? 'border border-slate-200 bg-white font-semibold text-slate-950 shadow-sm'
                : 'border border-transparent text-slate-700 hover:bg-white hover:text-slate-950'
            }`}
          >
            전체
          </button>

          {categoryTree.map((group) => {
            const isOpen = openCategoryIds.has(group.id)
            const isActive = activeCategoryId === group.id

            return (
              <div
                key={group.id}
                ref={(el) => {
                  if (el) categoryGroupRefs.current.set(group.id, el)
                  else categoryGroupRefs.current.delete(group.id)
                }}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleCategory(group.id)}
                    className="flex h-9 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-white hover:text-slate-950"
                    aria-label={`${group.label} 메뉴 ${isOpen ? '닫기' : '열기'}`}
                  >
                    <span
                      className={`h-2.5 w-2.5 border-b-2 border-r-2 border-current transition ${
                        isOpen ? 'rotate-45' : '-rotate-45'
                      }`}
                    />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleCategorySelect(group.id)}
                    className={`flex min-h-9 flex-1 items-center rounded-lg px-3 text-left text-sm transition ${
                      isActive
                        ? 'border border-slate-200 bg-white font-semibold text-slate-950 shadow-sm'
                        : 'border border-transparent text-slate-700 hover:bg-white hover:text-slate-950'
                    }`}
                  >
                    {group.label}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-1 space-y-1 pb-1 pl-9">
                    {group.children.length > 0 ? (
                      group.children.map((child) => {
                        const childId = `${group.id}-${child.category2}`
                        const isChildActive = activeCategoryId === childId

                        return (
                          <button
                            key={childId}
                            type="button"
                            onClick={() => handleCategorySelect(childId)}
                            className={`block w-full rounded-md px-3 py-2 text-left text-sm transition ${
                              isChildActive
                                ? 'bg-white font-medium text-slate-950 shadow-sm'
                                : 'text-slate-500 hover:bg-white hover:text-slate-950'
                            }`}
                          >
                            {child.category2}
                          </button>
                        )
                      })
                    ) : (
                      <p className="px-3 py-2 text-xs text-slate-400">
                        연결 후 표시됩니다
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </div>

      <div
        className={`shrink-0 pt-4 ${
          isSidebarOpen ? 'border-t border-slate-200' : ''
        }`}
      >
      </div>
    </div>
  )

  return (
    <main
      className={`min-h-screen bg-slate-50 text-slate-950 transition-[padding] duration-300 ${
        isSidebarOpen ? 'pl-20 lg:pl-[21rem]' : 'pl-20'
      }`}
    >
      <aside
        className={`fixed inset-y-0 left-0 z-50 overflow-hidden border-r border-slate-200 bg-slate-50 shadow-sm transition-[width,box-shadow] duration-300 ease-out ${
          isSidebarOpen ? 'w-[21rem] shadow-2xl' : 'w-20'
        }`}
      >
        {sidebarContent}
      </aside>

      {isSidebarOpen && (
        <button
          type="button"
          className="fixed inset-y-0 left-[21rem] right-0 z-30 bg-slate-950/15 lg:hidden"
          aria-label="사이드바 닫기"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <section
        className="mx-auto min-h-screen w-full max-w-6xl px-8 py-8"
      >
        <header className="relative flex h-16 items-center justify-between border-b border-slate-200">
          <div className="z-10 w-10" />

          <button
            type="button"
            onClick={handleHomeClick}
            className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition hover:text-slate-600"
            aria-label="홈으로 이동"
          >
            <span className="text-4xl font-semibold leading-none tracking-tight">
              F1T
            </span>
            <span className="mt-1 text-xs font-medium leading-none text-slate-500">
              Fashion Intention Translator
            </span>
          </button>

          <nav className="z-10 hidden items-center gap-1 text-sm font-medium md:flex">
            {pageNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePageClick(item.id)}
                className="rounded-lg px-3 py-2 text-slate-500 transition hover:bg-white/70 hover:text-slate-950"
              >
                {item.label}
              </button>
            ))}
          </nav>
        </header>

        <nav className="mt-3 flex justify-end gap-1 text-sm font-medium md:hidden">
          {pageNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handlePageClick(item.id)}
              className="rounded-lg px-3 py-2 text-slate-500 transition hover:bg-white/70 hover:text-slate-950"
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="pt-8">
          <section className="min-w-0">
            <div className="mb-7 max-w-4xl">
              <h1 className="mb-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                머릿속 스타일을 그대로 찾아보세요
              </h1>

              <p className="text-lg leading-8 text-slate-600">
                <span className="block">
                  입고 싶은 상황이나 원하는 색, 핏, 패턴을 편하게 말해보세요.
                </span>
                <span className="block">
                  마음에 든 이미지가 있다면 올리고, 바꾸고 싶은 디테일만 말해도
                  요청에 맞는 아이템을 찾아드립니다.
                </span>
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="grid items-start gap-4 md:grid-cols-[140px_1fr]">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageChange}
                />

                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => imageInputRef.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      imageInputRef.current?.click()
                    }
                  }}
                  onDragOver={handleImageDragOver}
                  onDragLeave={handleImageDragLeave}
                  onDrop={handleImageDrop}
                  className={`group relative flex aspect-[3/4] w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed text-center text-sm text-slate-500 transition hover:border-slate-400 hover:bg-slate-100 ${selectedImage ? '' : 'px-4 '}${
                    isImageDragging
                      ? 'border-slate-500 bg-slate-100 ring-2 ring-slate-200'
                      : 'border-slate-300 bg-slate-50'
                  }`}
                >
                  {selectedImage ? (
                    <>
                      <img
                        src={selectedImage.previewUrl}
                        alt="첨부한 이미지 미리보기"
                        className="h-full w-full object-contain"
                      />

                      <span className="absolute inset-x-0 bottom-0 bg-slate-950/65 px-2 py-2 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
                        이미지 바꾸기
                      </span>

                      <button
                        type="button"
                        onClick={handleImageRemove}
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-white"
                        aria-label="첨부한 이미지 삭제"
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition group-hover:border-slate-400">
                        <span className="relative h-4 w-4">
                          <span className="absolute left-1/2 top-0 h-4 w-0.5 -translate-x-1/2 rounded-full bg-current" />
                          <span className="absolute left-0 top-1/2 h-0.5 w-4 -translate-y-1/2 rounded-full bg-current" />
                        </span>
                      </span>

                      <span className="font-medium text-slate-700">
                        이미지 추가
                      </span>
                      <span className="text-[11px] leading-4 text-slate-400">
                        클릭 또는 드래그
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex min-h-[165px] flex-col">
                  <textarea
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        if (!isUnderstandingRequest && !isSearchCompleteVisible) {
                          event.currentTarget.form?.requestSubmit()
                        }
                      }
                    }}
                    className="min-h-32 flex-1 resize-none rounded-xl border border-slate-200 bg-white p-4 text-base outline-none transition placeholder:text-slate-400 focus:border-slate-400"
                    placeholder={
                      '예: 이 이미지와 비슷한 색으로 긴소매 셔츠 찾아줘\n예: 러닝할 때 입기 좋은 가볍고 신축성 있는 바지 추천해줘\n예: 이 원피스 느낌은 유지하고 패턴은 없는 걸로 찾아줘'
                    }
                  />

                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-sm text-slate-500">
                      찾고 싶은 옷을 편하게 말해주세요.
                    </p>

                    <div className="relative flex items-center gap-2">
                      {/* 모델 선택 */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setIsProviderMenuOpen((v) => !v)}
                          className="flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-800"
                        >
                          <span>
                            {providerModels[selectedProvider] ?? selectedProvider}
                          </span>
                          <svg aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>

                        {isProviderMenuOpen && (
                          <div className="absolute bottom-full right-0 mb-1.5 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                            {(
                              [
                                { value: 'gemini' },
                                { value: 'openai' },
                                { value: 'qwen' },
                              ] as const
                            ).map(({ value }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => {
                                  setSelectedProvider(value)
                                  setIsProviderMenuOpen(false)
                                }}
                                className="flex w-full items-center justify-between px-3 py-1.5 text-left transition hover:bg-slate-50"
                              >
                                <span className={`text-xs ${selectedProvider === value ? 'font-semibold text-slate-950' : 'text-slate-600'}`}>
                                  {providerModels[value] ?? value}
                                </span>
                                {selectedProvider === value && (
                                  <svg aria-hidden="true" className="h-3 w-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                    <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <button
                        type="submit"
                        disabled={isUnderstandingRequest || isSearchCompleteVisible}
                        className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isUnderstandingRequest
                          ? '파악 중'
                          : isSearchCompleteVisible
                            ? '완료'
                            : '검색하기'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {(isUnderstandingRequest || isSearchCompleteVisible) && (
                <div className="absolute inset-0 overflow-hidden rounded-2xl flex items-center justify-center bg-white/90 px-6 backdrop-blur-sm">
                  <div className="flex flex-col items-center text-center">
                    {isSearchCompleteVisible ? (
                      <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-full bg-slate-950 text-sm font-semibold text-white">
                        ✓
                      </div>
                    ) : (
                      <div className="mb-4 flex h-8 items-center gap-1.5">
                        <span className="typing-dot typing-dot-1 h-2 w-2 rounded-full bg-slate-950" />
                        <span className="typing-dot typing-dot-2 h-2 w-2 rounded-full bg-slate-950" />
                        <span className="typing-dot typing-dot-3 h-2 w-2 rounded-full bg-slate-950" />
                      </div>
                    )}
                    <p className="text-base font-semibold text-slate-950">
                      {isSearchCompleteVisible
                        ? '검색 완료'
                        : currentSearchProgress.title}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      {isSearchCompleteVisible
                        ? '요청에 맞춰 정리한 결과를 아래에서 확인해보세요.'
                        : currentSearchProgress.description}
                    </p>
                    {!isSearchCompleteVisible && (
                      <div className="mt-5 flex gap-1.5">
                        {searchProgressSteps.map((step, index) => (
                          <span
                            key={step.title}
                            className={`h-1.5 w-6 rounded-full transition ${
                              index <= searchProgressIndex
                                ? 'bg-slate-950'
                                : 'bg-slate-200'
                            }`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </form>

            <div ref={resultsSectionRef} className="mt-8 scroll-mt-8">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold">
                      {hasSubmittedSearch ? '검색 결과' : '전체 상품'}
                    </h2>
                    {baselineSearchResponse &&
                      reasoningBadges.map((badge) => (
                        <span
                          key={badge.label}
                          title={badge.title}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${getReasoningBadgeClass(
                            badge.tone,
                          )}`}
                        >
                          {badge.label}
                        </span>
                      ))}
	                  </div>
                  {submittedQuery ? (
                    <p className="mt-1 text-sm text-slate-500">
                      "{submittedQuery}" 검색 결과
                    </p>
                  ) : !hasSubmittedSearch ? (
                    <p className="mt-1 text-sm text-slate-500">
                      {activeCategory.label === allCategory.label
                        ? '전체 상품을 둘러보세요.'
                        : `${activeCategory.label} 상품을 둘러보세요.`}
                    </p>
                  ) : submittedHadImage ? (
                    <p className="mt-1 text-sm text-slate-500">
                      이미지 기반 검색 결과
                    </p>
                  ) : null}
                </div>

                <span className="text-sm text-slate-500">
                  {isBaselineSearch
                    ? `${baselineResults.length.toLocaleString('ko-KR')}개`
                    : isLoading && products.length > 0
                    ? '불러오는 중'
                    : products.length > 0
                      ? totalProductCount === null
                        ? `${products.length.toLocaleString('ko-KR')}개`
                        : `${products.length.toLocaleString(
                            'ko-KR',
                          )} / ${totalProductCount.toLocaleString('ko-KR')}개`
                      : ''}
                </span>
              </div>

              {requestSummaryItems.length > 0 && (
                <div className="mb-5 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-lg font-medium text-slate-500">
                    반영할 조건
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {requestSummaryItems.map((item) => (
                      <span
                        key={item}
                        className="rounded-md bg-slate-100 px-2.5 py-1.5 text-lg font-medium text-slate-700"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {shouldShowPipelineExtraction && (
                <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-lg font-semibold text-slate-500">
                      추론된 VLM 검색 속성
                    </p>
                    {parsedAttributeItems.length === 0 && pipelineIntentLabel === 'TPO 검색' && (
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-lg font-medium text-slate-600">
                        TPO 검색
                      </span>
                    )}
                  </div>

                  {parsedAttributeItems.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {parsedAttributeItems.map((item) => (
                        <span
                          key={item.key}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-lg text-slate-700"
                        >
                          <span className="font-medium text-slate-500">
                            {item.label}
                          </span>{' '}
                          {item.value}
                        </span>
                      ))}
                    </div>
                  )}

                </div>
              )}

              {errorMessage && !isBaselineSearch && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {errorMessage}
                </div>
              )}

              {isBaselineSearch && baselineSearchResponse?.target_description && (
                <div className="mb-5 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3.5">
                  <div>
                    <p className="text-lg font-semibold uppercase tracking-wide text-indigo-400">
                      Target description 원문
                    </p>
                    <p className="mt-1.5 break-words text-lg leading-relaxed text-slate-700">
                      {baselineSearchResponse.target_description}
                    </p>
                  </div>

                  {baselineSearchResponse.target_description_ko && (
                    <div className="mt-3 border-t border-indigo-100 pt-3">
                      <p className="text-lg font-semibold uppercase tracking-wide text-indigo-400">
                        번역
                      </p>
                      <p className="mt-1.5 break-words text-lg leading-relaxed text-slate-700">
                        {baselineSearchResponse.target_description_ko}
                      </p>
                    </div>
                  )}

                  {baselineSearchResponse.recommendation_reason && (
                    <div className="mt-3 border-t border-indigo-100 pt-3">
                      <p className="text-lg font-semibold uppercase tracking-wide text-indigo-400">
                        추천 이유
                      </p>
                      <p className="mt-1.5 break-words text-lg leading-relaxed text-slate-700">
                        {baselineSearchResponse.recommendation_reason}
                      </p>
                    </div>
                  )}

                </div>
              )}

              {isBaselineSearch && (
                <div className="grid grid-cols-5 gap-x-2 gap-y-6 sm:gap-x-3 md:gap-x-4 md:gap-y-8">
                  {baselineResults.map((result) => {
                    const resultImageUrl = getBaselineImageUrl(result)
                    const resultThumbnailUrl = resultImageUrl
                      ? getSupabaseImageThumbnailUrl(resultImageUrl)
                      : ''
                    const isPriorityImage = result.rank <= 5
                    const likedItemId = `search-${result.source_table ?? 'baseline'}-${result.id}`
                    const resultPrice = formatPrice(result.price)

                    return (
                      <article
                        key={`${result.source_table ?? 'baseline'}-${result.id}-${result.rank}`}
                        className="min-w-0 cursor-pointer"
                        onClick={() => setSelectedProductForDetail(result as unknown as Product)}
                      >
                        <div className="relative aspect-[3/4] overflow-hidden bg-slate-100">
                          {resultImageUrl ? (
                            <img
                              src={resultThumbnailUrl || resultImageUrl}
                              alt={result.name ?? `검색 결과 ${result.rank}`}
                              className="h-full w-full object-cover"
                              data-fallback-src={resultImageUrl}
                              decoding="async"
                              fetchPriority={isPriorityImage ? 'high' : 'low'}
                              loading={isPriorityImage ? 'eager' : 'lazy'}
                              onError={handleImageFallback}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-slate-400">
                              이미지 없음
                            </div>
                          )}
                        <button
                          type="button"
                          onClick={() => toggleLikedItem(likedItemId)}
                          className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-base shadow-sm transition hover:bg-white ${
                            likedItemIds.has(likedItemId)
                              ? 'text-rose-500'
                              : 'text-slate-400'
                          }`}
                          aria-label={
                            likedItemIds.has(likedItemId)
                              ? '관심 상품 해제'
                              : '관심 상품 선택'
                          }
                        >
                          ♥
                        </button>
                      </div>

                      <div className="mt-3">
                        <h3 className="line-clamp-2 min-h-8 text-[10px] font-medium leading-4 sm:text-xs md:min-h-10 md:text-sm md:leading-5">
                          {result.name ?? result.id}
                        </h3>
                        {resultPrice && (
                          <p className="mt-1 text-[10px] font-semibold text-slate-950 sm:text-xs md:text-sm">
                            {resultPrice}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] text-slate-500 sm:text-xs">
                          similarity {result.similarity.toFixed(4)}
                        </p>
                      </div>
                    </article>
                    )
                  })}
                </div>
              )}

              {!isBaselineSearch && isLoading && products.length === 0 && (
                <div className="grid grid-cols-5 gap-x-2 gap-y-6 sm:gap-x-3 md:gap-x-4 md:gap-y-8">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div key={i} className="min-w-0 animate-pulse">
                      <div className="aspect-[3/4] rounded bg-slate-200" />
                      <div className="mt-3 space-y-2">
                        <div className="h-3 rounded bg-slate-200" />
                        <div className="h-3 w-2/3 rounded bg-slate-200" />
                        <div className="h-3 w-1/3 rounded bg-slate-200" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!isBaselineSearch && !isLoading && !errorMessage && products.length === 0 && (
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
                  조건에 맞는 상품이 없습니다.
                </div>
              )}

              {!isBaselineSearch && products.length > 0 && (
                <>
                  <div
                    className={`grid grid-cols-5 gap-x-2 gap-y-6 transition-opacity sm:gap-x-3 md:gap-x-4 md:gap-y-8 ${
                      isLoading ? 'opacity-60' : 'opacity-100'
                    }`}
                  >
                    {products.map((product, index) => {
                      const productImageUrl = getProductImageUrl(product)
                      const productThumbnailUrl = getProductThumbnailUrl(product)
                      const isPriorityImage = index < 10

                      return (
                        <article
                          key={`${product._sourceTable}-${product.id}`}
                          className="min-w-0 cursor-pointer"
                          onClick={() => setSelectedProductForDetail(product)}
                        >
                          <div className="relative aspect-[3/4] overflow-hidden bg-slate-100">
                            <img
                              src={productThumbnailUrl || productImageUrl}
                              alt={product.name ?? '상품 이미지'}
                              className="h-full w-full object-cover"
                              data-fallback-src={productImageUrl || undefined}
                              decoding="async"
                              fetchPriority={isPriorityImage ? 'high' : 'low'}
                              loading={isPriorityImage ? 'eager' : 'lazy'}
                              onError={handleImageFallback}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                toggleLikedItem(`${product._sourceTable}-${product.id}`)
                              }
                              className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-base shadow-sm transition hover:bg-white ${
                                likedItemIds.has(
                                  `${product._sourceTable}-${product.id}`,
                                )
                                  ? 'text-rose-500'
                                  : 'text-slate-400'
                              }`}
                              aria-label={
                                likedItemIds.has(
                                  `${product._sourceTable}-${product.id}`,
                                )
                                  ? '관심 상품 해제'
                                  : '관심 상품 선택'
                              }
                            >
                              ♥
                            </button>
                          </div>

                          <div className="mt-3">
                            <h3 className="line-clamp-2 min-h-8 text-[10px] font-medium leading-4 sm:text-xs md:min-h-10 md:text-sm md:leading-5">
                              {product.name || product.id}
                            </h3>

                            {formatPrice(product.price) && (
                              <p className="mt-1 text-[10px] font-semibold sm:text-xs md:text-sm">
                                {formatPrice(product.price)}
                              </p>
                            )}
                          </div>
                        </article>
                      )
                    })}
                  </div>

                  <div
                    ref={loadMoreRef}
                    className="flex min-h-20 items-center justify-center py-8 text-sm text-slate-500"
                  >
                    {isLoading
                      ? '상품을 더 불러오는 중입니다.'
                      : hasMoreProducts
                        ? ''
                        : '마지막 상품까지 모두 불러왔습니다.'}
                  </div>
                </>
              )}

            </div>
          </section>
        </div>

        {activeModal && (
          <PolicyModal
            onClose={() => setActiveModal(null)}
          />
        )}

        {selectedProductForDetail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white">
              <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                <h2 className="text-xl font-semibold">{selectedProductForDetail.name}</h2>
                <button
                  type="button"
                  onClick={() => setSelectedProductForDetail(null)}
                  className="text-slate-500 hover:text-slate-700"
                  aria-label="닫기"
                >
                  ✕
                </button>
              </div>

              <div className="flex flex-col gap-6 p-6 md:flex-row">
                <div className="flex-1">
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm text-slate-500">브랜드</p>
                      <p className="text-lg font-medium">{selectedProductForDetail.brand || '-'}</p>
                    </div>

                    <div>
                      <p className="text-sm text-slate-500">가격</p>
                      <p className="text-lg font-semibold">
                        {formatPrice(selectedProductForDetail.price) || '-'}
                      </p>
                    </div>

                    <div>
                      <p className="text-sm text-slate-500">카테고리</p>
                      <p className="text-base">{selectedProductForDetail.category1 || '-'}</p>
                    </div>

                    {selectedProductForDetail.sleeve && (
                      <div>
                        <p className="text-sm text-slate-500">소매</p>
                        <p className="text-base">{selectedProductForDetail.sleeve}</p>
                      </div>
                    )}

                    {selectedProductForDetail.color && (
                      <div>
                        <p className="text-sm text-slate-500">색상</p>
                        <p className="text-base">{selectedProductForDetail.color}</p>
                      </div>
                    )}

                    {selectedProductForDetail.fit && (
                      <div>
                        <p className="text-sm text-slate-500">핏</p>
                        <p className="text-base">{selectedProductForDetail.fit}</p>
                      </div>
                    )}

                    <div className="border-t border-slate-200 pt-4">
                      <a
                        href={`https://www.musinsa.com/products/${selectedProductForDetail.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block rounded-lg bg-slate-950 px-6 py-2 text-white transition hover:bg-slate-800"
                      >
                        상품 페이지 보기
                    </a>
                    </div>
                  </div>
                </div>

                <div className="flex-1">
                  <img
                    src={getProductImageUrl(selectedProductForDetail)}
                    alt={selectedProductForDetail.name ?? '상품 이미지'}
                    className="aspect-[3/4] w-full rounded-lg object-cover"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
