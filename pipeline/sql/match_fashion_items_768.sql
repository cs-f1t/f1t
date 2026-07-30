-- Canonical definition of the live Supabase vector-search RPC.
-- Apply through a reviewed Supabase migration before production use.

create or replace function public.match_fashion_items_768(
  p_query_embedding extensions.vector,
  p_match_count integer default 10,
  p_table_filter text default null,
  p_category2_filter text default null,
  p_category2_keyword_filter text default null,
  p_fabric_embedding extensions.vector default null
)
returns table(
  id text,
  source_table text,
  name text,
  brand text,
  image_url text,
  category1 text,
  category2 text,
  price numeric,
  color text,
  sleeve text,
  length text,
  sex text,
  season text,
  stretch text,
  thickness text,
  fit text,
  fabric text,
  similarity double precision
)
language plpgsql
volatile
security invoker
set search_path = public, extensions
set statement_timeout = '30s'
as $function$
begin
  -- pgvector defaults to ef_search=40. This RPC needs up to 100 image
  -- candidates, so widen the HNSW search only for the current transaction.
  perform set_config('hnsw.ef_search', '100', true);

  return query
  with params as (
    select
      result_count,
      least(greatest(result_count * 5, 50), 100) as candidate_count
    from (
      select least(greatest(coalesce(p_match_count, 10), 1), 100) as result_count
    ) bounds
  ),
  top_clothes as (
    select
      t.id::text,
      'musinsa_top_clothes'::text as source_table,
      t.name::text,
      t.brand::text,
      t.image_url::text,
      t.category1::text,
      t.category2::text,
      t.price::numeric,
      t.color::text,
      t.sleeve::text,
      null::text as length,
      t.sex::text,
      t.season::text,
      t.stretch::text,
      t.thickness::text,
      t.fit::text,
      t.fabric::text,
      case
        when p_fabric_embedding is null then
          (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))::double precision
        else
          (
            0.8 * (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))
            + 0.2 * coalesce(
                1 - (t.gemini_fabric_text_embedding_768 <=> p_fabric_embedding),
                0
              )
          )::double precision
      end as similarity
    from public.musinsa_top_clothes t
    where t.gemini_image_embedding_768 is not null
      and (p_table_filter is null or p_table_filter = 'musinsa_top_clothes')
      and (p_category2_filter is null or t.category2 = p_category2_filter)
      and (
        p_category2_keyword_filter is null
        or t.category2 ilike '%' || p_category2_keyword_filter || '%'
      )
    order by t.gemini_image_embedding_768 <=> p_query_embedding
    limit (select candidate_count from params)
  ),
  pants as (
    select
      t.id::text,
      'musinsa_pants'::text as source_table,
      t.name::text,
      t.brand::text,
      t.image_url::text,
      t.category1::text,
      t.category2::text,
      t.price::numeric,
      t.color::text,
      null::text as sleeve,
      t.length::text,
      t.sex::text,
      t.season::text,
      t.stretch::text,
      t.thickness::text,
      t.fit::text,
      t.fabric::text,
      case
        when p_fabric_embedding is null then
          (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))::double precision
        else
          (
            0.8 * (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))
            + 0.2 * coalesce(
                1 - (t.gemini_fabric_text_embedding_768 <=> p_fabric_embedding),
                0
              )
          )::double precision
      end as similarity
    from public.musinsa_pants t
    where t.gemini_image_embedding_768 is not null
      and (p_table_filter is null or p_table_filter = 'musinsa_pants')
      and (p_category2_filter is null or t.category2 = p_category2_filter)
      and (
        p_category2_keyword_filter is null
        or t.category2 ilike '%' || p_category2_keyword_filter || '%'
      )
    order by t.gemini_image_embedding_768 <=> p_query_embedding
    limit (select candidate_count from params)
  ),
  skirt_dress as (
    select
      t.id::text,
      'musinsa_skirt_dress'::text as source_table,
      t.name::text,
      t.brand::text,
      t.image_url::text,
      t.category1::text,
      t.category2::text,
      t.price::numeric,
      t.color::text,
      t.sleeve::text,
      t.length::text,
      t.sex::text,
      t.season::text,
      t.stretch::text,
      t.thickness::text,
      t.fit::text,
      t.fabric::text,
      case
        when p_fabric_embedding is null then
          (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))::double precision
        else
          (
            0.8 * (1 - (t.gemini_image_embedding_768 <=> p_query_embedding))
            + 0.2 * coalesce(
                1 - (t.gemini_fabric_text_embedding_768 <=> p_fabric_embedding),
                0
              )
          )::double precision
      end as similarity
    from public.musinsa_skirt_dress t
    where t.gemini_image_embedding_768 is not null
      and (p_table_filter is null or p_table_filter = 'musinsa_skirt_dress')
      and (p_category2_filter is null or t.category2 = p_category2_filter)
      and (
        p_category2_keyword_filter is null
        or t.category2 ilike '%' || p_category2_keyword_filter || '%'
      )
    order by t.gemini_image_embedding_768 <=> p_query_embedding
    limit (select candidate_count from params)
  ),
  candidates as (
    select * from top_clothes
    union all
    select * from pants
    union all
    select * from skirt_dress
  )
  select *
  from candidates
  order by candidates.similarity desc
  limit (select result_count from params);
end;
$function$;

comment on function public.match_fashion_items_768(
  extensions.vector, integer, text, text, text, extensions.vector
) is 'Backend-only Gemini retrieval. Sets HNSW ef_search to 100, selects 50-100 image candidates, then applies optional 80/20 image/fabric reranking.';

revoke all on function public.match_fashion_items_768(
  extensions.vector, integer, text, text, text, extensions.vector
) from public, anon, authenticated;

grant execute on function public.match_fashion_items_768(
  extensions.vector, integer, text, text, text, extensions.vector
) to service_role;
