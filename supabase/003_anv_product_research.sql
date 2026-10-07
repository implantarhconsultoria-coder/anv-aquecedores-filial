-- ANV FILIAL DIGITAL — procedência e cache da identificação de produto por imagem
-- Idempotente: produção já pode conter parte destas colunas.

alter table public.anv_products
  add column if not exists source_url text,
  add column if not exists source_domain text,
  add column if not exists research_status text,
  add column if not exists research_confidence numeric,
  add column if not exists research_meta jsonb not null default '{}'::jsonb,
  add column if not exists researched_at timestamptz;

create index if not exists anv_products_gtin_idx
  on public.anv_products (gtin)
  where gtin is not null;

create index if not exists anv_products_research_status_idx
  on public.anv_products (research_status, researched_at desc)
  where research_status is not null;

comment on column public.anv_products.source_url is 'URL pública confirmada usada como fonte do produto.';
comment on column public.anv_products.source_domain is 'Domínio da fonte confirmada.';
comment on column public.anv_products.research_status is 'Status da identificação: CONFIRMADO ou pendência de pesquisa.';
comment on column public.anv_products.research_confidence is 'Confiança do matching normalizada entre 0 e 1.';
comment on column public.anv_products.research_meta is 'Evidências, identificadores, candidatos, queries e imagens da pesquisa.';
comment on column public.anv_products.researched_at is 'Data/hora da última pesquisa de identificação confirmada.';
