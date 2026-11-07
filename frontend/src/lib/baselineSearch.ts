const baselineApiBaseUrl = normalizeLocalApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL as string | undefined,
)
const TEXT_SEARCH_TIMEOUT_MS = 75_000
const IMAGE_SEARCH_TIMEOUT_MS = 180_000
const API_WARMUP_TIMEOUT_MS = 20_000
const RETRYABLE_SEARCH_STATUS_CODES = new Set([502, 503, 504])

let baselineWarmupPromise: Promise<void> | null = null

export type BaselineSearchResult = {
  rank: number
  id: string
  filename?: string
  similarity: number
  image_url?: string
  source_table?: string
  name?: string | null
  brand?: string | null
  category1?: string | null
  category2?: string | null
  price?: number | string | null
  color?: string | null
  sleeve?: string | null
  length?: string | null
  sex?: string | string[] | null
  season?: string | string[] | null
  stretch?: string | string[] | null
  thickness?: string | string[] | null
  fit?: string | string[] | null
  fabric?: string | null
}

export type BaselineReasoningWarning = {
  code: string
  label: string
  message: string
}

export type BaselineReasoningMetadata = {
  provider: 'gemini' | 'qwen3_5_0_8b' | 'qwen3_vl_2b' | 'raw_query' | string
  status: 'ok' | 'fallback' | 'degraded' | string  // fallback = cloud provider failed, Qwen took over
  warnings: BaselineReasoningWarning[]
  pipeline?: SearchPipelineMetadata
}

export type SearchPipelineMetadata = {
  query_type: 'text_only' | 'image_only' | 'text_image' | string
  id: string
  label: string
  baseline: boolean
  retrieval_strategy: string
  intent_type?: string
  parsed_attributes?: Record<string, string>
  analysis_lanes?: Record<string, unknown>
  detail_target_description?: string | null
  target_description_lanes?: Record<string, string | null | undefined>
  target_description_request?: string
  retrieval_description?: string
  text_attribute_fields?: string[]
  constrained_text_attributes?: Record<string, string[]>
  exact_filter_fields?: string[]
  semantic_filter_fields?: string[]
  soft_text_rerank_fields?: string[]
  applied_filters?: Record<string, string>
  user_filter_overrides?: Record<string, string>
  prefetch_count?: number
  result_strategy?: Record<string, unknown>
  notes?: string[]
}

export type BaselineSearchResponse = {
  mode: 'baseline' | 'supabase_vector' | string
  provider: string
  pipeline?: SearchPipelineMetadata
  target_description: string
  target_description_ko?: string
  recommendation_reason?: string
  reasoning?: BaselineReasoningMetadata
  results: BaselineSearchResult[]
}

type SearchBaselineOptions = {
  query: string
  image?: File | null
  topK?: number
  table?: string
  category2?: string
  category2Keyword?: string
  provider?: string
}

function normalizeLocalApiBaseUrl(apiBaseUrl?: string) {
  const trimmedApiBaseUrl = apiBaseUrl?.trim()

  if (!trimmedApiBaseUrl) {
    return undefined
  }

  try {
    const url = new URL(trimmedApiBaseUrl)

    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1'
    }

    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmedApiBaseUrl.replace(/\/$/, '')
  }
}

export function hasBaselineSearchConfig() {
  return Boolean(baselineApiBaseUrl)
}

export function warmBaselineSearch() {
  if (!baselineApiBaseUrl) {
    return Promise.resolve()
  }

  if (!baselineWarmupPromise) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      API_WARMUP_TIMEOUT_MS,
    )

    baselineWarmupPromise = fetch(`${baselineApiBaseUrl}/health`, {
      signal: controller.signal,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timeoutId))
  }

  return baselineWarmupPromise
}

export type ProviderModels = Record<string, string>

export async function fetchProviderModels(): Promise<ProviderModels> {
  if (!baselineApiBaseUrl) return {}

  await warmBaselineSearch()

  try {
    const res = await fetch(`${baselineApiBaseUrl.replace(/\/$/, '')}/models`)
    if (!res.ok) return {}
    return (await res.json()) as ProviderModels
  } catch {
    return {}
  }
}

export function getBaselineImageUrl(result: BaselineSearchResult) {
  if (result.image_url) {
    return result.image_url
  }

  if (!baselineApiBaseUrl) {
    return ''
  }

  if (!result.filename) {
    return ''
  }

  return `${baselineApiBaseUrl.replace(/\/$/, '')}/baseline-images/${result.filename}`
}

export async function searchBaseline({
  query,
  image,
  topK = 10,
  table,
  category2,
  category2Keyword,
  provider,
}: SearchBaselineOptions) {
  if (!baselineApiBaseUrl) {
    throw new Error('VITE_API_BASE_URL is not configured.')
  }

  await warmBaselineSearch()

  const trimmedQuery = query.trim()
  const timeoutMs = image ? IMAGE_SEARCH_TIMEOUT_MS : TEXT_SEARCH_TIMEOUT_MS

  function createFormData() {
    const formData = new FormData()

    if (trimmedQuery) formData.append('query', trimmedQuery)
    if (image) formData.append('image', image)

    formData.append('top_k', String(topK))

    if (table) formData.append('table', table)
    if (category2) formData.append('category2', category2)
    if (category2Keyword) {
      formData.append('category2_keyword', category2Keyword)
    }
    if (provider) formData.append('provider', provider)

    return formData
  }

  let response: Response | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      response = await fetch(`${baselineApiBaseUrl}/search`, {
        method: 'POST',
        body: createFormData(),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(
          '검색 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.',
          { cause: error },
        )
      }

      if (attempt === 0) {
        continue
      }

      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }

    if (!RETRYABLE_SEARCH_STATUS_CODES.has(response.status) || attempt === 1) {
      break
    }
  }

  if (!response) {
    throw new Error('검색 서버에 연결하지 못했습니다.')
  }

  if (!response.ok) {
    let detail = `Baseline search failed. (${response.status})`

    try {
      const body = (await response.json()) as { detail?: string }

      if (body.detail) {
        detail = body.detail
      }
    } catch {
      // Keep the generic status message.
    }

    throw new Error(detail)
  }

  return (await response.json()) as BaselineSearchResponse
}
