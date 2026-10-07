-- Pesquisa auditável. Aplicar após 001 e 002 no projeto Supabase ANV.
-- Não altera produtos antigos, contas, OAuth, pedidos ou políticas existentes.
begin;
create table if not exists public.anv_product_research (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  product_id uuid references public.anv_products(id) on delete set null,
  status text not null default 'FOTO_ENVIADA' check (status in (
    'FOTO_ENVIADA','PESQUISANDO','RESULTADOS_ENCONTRADOS','AGUARDANDO_CONFIRMACAO',
    'PRODUTO_CONFIRMADO','DADOS_IMPORTADOS','PRONTO_PARA_ANUNCIO','PUBLICADO','FALHA'
  )),
  original_image text not null,
  hints jsonb not null default '{}'::jsonb,
  queries jsonb not null default '[]'::jsonb,
  candidates jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  search_calls integer not null default 0,
  selected_candidate jsonb,
  imported_fields jsonb not null default '{}'::jsonb,
  source_url text,
  source_domain text,
  source_title text,
  source_confidence integer check (source_confidence between 0 and 100),
  matched_at timestamptz,
  matched_fields jsonb not null default '{}'::jsonb,
  status_history jsonb not null default '[]'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists anv_product_research_product_idx on public.anv_product_research(product_id,created_at desc);
create index if not exists anv_product_research_actor_idx on public.anv_product_research(actor_email,created_at desc);
alter table public.anv_product_research enable row level security;
revoke all on public.anv_product_research from public,anon,authenticated;
grant select,insert,update,delete on public.anv_product_research to service_role;

create or replace function public.anv_research_status_history() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    new.status_history=jsonb_build_array(jsonb_build_object('status',new.status,'at',now()));
  elsif new.status is distinct from old.status then
    new.status_history=old.status_history||jsonb_build_array(jsonb_build_object('status',new.status,'at',now()));
  end if;
  new.updated_at=now();
  return new;
end;
$$;
drop trigger if exists anv_research_status_history on public.anv_product_research;
create trigger anv_research_status_history before insert or update on public.anv_product_research
  for each row execute function public.anv_research_status_history();

-- Salva produto + foto original + vínculo com a pesquisa em uma transação.
-- Não perde a fonte se a gravação de uma das etapas falhar; retry retorna o mesmo produto.
create or replace function public.anv_save_researched_product(
  p_research_id uuid,p_actor_email text,p_product jsonb,p_product_id uuid default null
) returns jsonb
language plpgsql security invoker set search_path=public as $$
declare
  r public.anv_product_research%rowtype;
  p public.anv_products%rowtype;
begin
  select * into r from public.anv_product_research
    where id=p_research_id and actor_email=lower(trim(p_actor_email)) for update;
  if not found then raise exception 'research_not_found'; end if;
  if r.product_id is not null then
    if p_product_id is not null and p_product_id<>r.product_id then raise exception 'research_product_mismatch'; end if;
    select * into p from public.anv_products where id=r.product_id;
    return to_jsonb(p);
  end if;
  if r.status<>'DADOS_IMPORTADOS' or r.selected_candidate is null or coalesce(r.source_confidence,0)<80 then
    raise exception 'research_confirmation_required';
  end if;
  if p_product_id is null and coalesce(trim(p_product->>'name'),'')='' then raise exception 'product_name_required'; end if;
  -- API filters reviewed fields; source proof is retained separately in the research.
  if p_product_id is null then
    select * into p from jsonb_populate_record(null::public.anv_products,
      jsonb_build_object('cost_price',0,'sale_price',0,'minimum_price',0,'stock',0,'minimum_stock',5,'status','ativo')
      || (p_product - 'id' - 'created_at' - 'updated_at')
      || jsonb_build_object('id',gen_random_uuid(),'created_at',now(),'updated_at',now()));
    insert into public.anv_products select p.*;
  else
    select * into p from public.anv_products where id=p_product_id for update;
    if not found then raise exception 'product_not_found'; end if;
    select * into p from jsonb_populate_record(p,p_product - 'id' - 'created_at' - 'updated_at');
    update public.anv_products set
      code=p.code,sku=p.sku,gtin=p.gtin,name=p.name,brand=p.brand,model=p.model,category=p.category,
      gas_type=p.gas_type,voltage=p.voltage,color=p.color,material=p.material,application=p.application,
      compatibility=p.compatibility,description=p.description,technical_details=p.technical_details,
      package_length_cm=p.package_length_cm,package_width_cm=p.package_width_cm,package_height_cm=p.package_height_cm,
      package_weight_g=p.package_weight_g,ncm=p.ncm,cest=p.cest,fiscal_origin=p.fiscal_origin,
      cost_price=p.cost_price,sale_price=p.sale_price,minimum_price=p.minimum_price,stock=p.stock,
      minimum_stock=p.minimum_stock,status=p.status,updated_at=now() where id=p.id;
  end if;
  insert into public.anv_product_images(product_id,kind,position,is_main,url,mime)
    values(p.id,'source',99,false,r.original_image,
      split_part(split_part(r.original_image,';',1),':',2));
  update public.anv_product_research set product_id=p.id,updated_at=now() where id=r.id;
  return to_jsonb(p);
end;
$$;
revoke all on function public.anv_save_researched_product(uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.anv_save_researched_product(uuid,text,jsonb,uuid) to service_role;
-- Deriva estados do preparo/publicação, sem modificar o fluxo do marketplace.
create or replace function public.anv_research_listing_state() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  update public.anv_product_research set status=case when new.status='publicado' then 'PUBLICADO' else status end,
    updated_at=now() where product_id=new.id;
  return new;
end;
$$;
drop trigger if exists anv_research_listing_state on public.anv_products;
create trigger anv_research_listing_state after update of status on public.anv_products
  for each row when (new.status='publicado') execute function public.anv_research_listing_state();
commit;
