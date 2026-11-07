export type ProductTable =
  | 'musinsa_pants'
  | 'musinsa_top_clothes'
  | 'musinsa_skirt_dress'

export type Product = {
  id: string | number
  name?: string | null
  brand?: string | null
  image_url?: string | null
  category1?: string | null
  category2?: string | null
  price?: number | string | null
  color?: string | null
  sleeve?: string | null
  length?: string | null
  fit?: string | null
  fabric?: string | null
  _sourceTable?: ProductTable
}
