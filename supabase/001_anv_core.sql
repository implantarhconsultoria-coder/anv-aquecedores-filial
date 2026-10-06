-- ANV FILIAL DIGITAL — Core database schema
-- Aplicar somente em um projeto Supabase exclusivo do ANV.
-- Segurança: todas as tabelas operacionais têm RLS ativo e nenhum acesso anon/authenticated.
-- O backend usa uma chave secreta Supabase (server-side only).

create extension if not exists pgcrypto;

create table if not exists public.anv_products (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  sku text,
  gtin text,
  name text not null,
  brand text,
  model text,
  category text,
  gas_type text,
  voltage text,
  color text,
  material text,
  application text,
  compatibility text,
  description text,
  technical_details text,
  package_length_cm numeric(12,2),
  package_width_cm numeric(12,2),
  package_height_cm numeric(12,2),
  package_weight_g numeric(12,2),
  ncm text,
  cest text,
  fiscal_origin text,
  cost_price numeric(14,2) not null default 0,
  sale_price numeric(14,2) not null default 0,
  minimum_price numeric(14,2) not null default 0,
  stock integer not null default 0,
  minimum_stock integer not null default 5,
  status text not null default 'ativo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anv_products_stock_check check (stock >= 0),
  constraint anv_products_min_stock_check check (minimum_stock >= 0)
);

create index if not exists anv_products_sku_idx on public.anv_products (sku);
create index if not exists anv_products_name_idx on public.anv_products using gin (to_tsvector('portuguese', coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(model,'')));

create table if not exists public.anv_product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.anv_products(id) on delete cascade,
  kind text not null default 'original',
  position integer not null default 0,
  is_main boolean not null default false,
  storage_path text,
  url text,
  mime text,
  width integer,
  height integer,
  generation_prompt_hash text,
  source_image_id uuid references public.anv_product_images(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists anv_product_images_product_idx on public.anv_product_images(product_id, position);

create table if not exists public.anv_marketplace_accounts (
  provider text primary key,
  provider_user_id text,
  nickname text,
  email text,
  seller_mode text,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  status text not null default 'DESCONECTADO',
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.anv_oauth_states (
  state text primary key,
  code_verifier text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists anv_oauth_states_exp_idx on public.anv_oauth_states(expires_at);

create table if not exists public.anv_marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mercado_livre',
  product_id uuid not null references public.anv_products(id) on delete cascade,
  item_id text unique,
  user_product_id text,
  category_id text,
  title text,
  family_name text,
  permalink text,
  seller_mode text,
  listing_type_id text,
  status text,
  price numeric(14,2),
  available_quantity integer,
  last_sync_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists anv_marketplace_listings_product_idx on public.anv_marketplace_listings(product_id);
create index if not exists anv_marketplace_listings_user_product_idx on public.anv_marketplace_listings(user_product_id);

create table if not exists public.anv_orders (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'mercado_livre',
  provider_order_id text not null unique,
  pack_id text,
  shipment_id text,
  buyer_nickname text,
  total_amount numeric(14,2),
  currency_id text,
  marketplace_status text,
  shipping_status text,
  operational_status text not null default 'NOVO',
  fiscal_status text,
  invoice_number text,
  invoice_key text,
  date_created timestamptz,
  date_closed timestamptz,
  last_marketplace_update_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists anv_orders_status_idx on public.anv_orders(operational_status, created_at desc);
create index if not exists anv_orders_shipment_idx on public.anv_orders(shipment_id);

create table if not exists public.anv_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.anv_orders(id) on delete cascade,
  provider_item_id text not null,
  product_id uuid references public.anv_products(id) on delete set null,
  seller_sku text,
  title text,
  quantity integer not null default 1,
  unit_price numeric(14,2),
  status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id, provider_item_id)
);
create index if not exists anv_order_items_product_idx on public.anv_order_items(product_id);

create table if not exists public.anv_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.anv_products(id) on delete cascade,
  type text not null,
  quantity integer not null,
  delta integer not null,
  balance_before integer not null,
  balance_after integer not null,
  reason text,
  idempotency_key text unique,
  provider_order_id text,
  actor text,
  created_at timestamptz not null default now(),
  constraint anv_stock_movements_quantity_check check (quantity > 0)
);
create index if not exists anv_stock_movements_product_idx on public.anv_stock_movements(product_id, created_at desc);

create table if not exists public.anv_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text,
  topic text,
  resource text,
  provider_user_id text,
  payload jsonb,
  status text not null default 'received',
  error text,
  correlation_id uuid not null default gen_random_uuid(),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);
create index if not exists anv_webhook_events_status_idx on public.anv_webhook_events(status, received_at desc);

create table if not exists public.anv_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  severity text not null default 'warning',
  title text not null,
  message text,
  entity_type text,
  entity_id text,
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists anv_alerts_open_idx on public.anv_alerts(resolved, created_at desc);

create table if not exists public.anv_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  message text,
  entity_type text,
  entity_id text,
  channel text not null default 'in_app',
  status text not null default 'pending',
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists anv_notifications_pending_idx on public.anv_notifications(status, created_at desc);

-- Todas as tabelas ficam inacessíveis diretamente pelo navegador. O backend usa secret key.
do $$
declare
  t text;
begin
  foreach t in array array[
    'anv_products','anv_product_images','anv_marketplace_accounts','anv_oauth_states',
    'anv_marketplace_listings','anv_orders','anv_order_items','anv_stock_movements',
    'anv_webhook_events','anv_alerts','anv_notifications'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- Baixa/estorno atômico e idempotente. SECURITY INVOKER: usa privilégios do backend.
create or replace function public.anv_apply_stock_movement(
  p_product_id uuid,
  p_type text,
  p_quantity integer,
  p_idempotency_key text default null,
  p_reason text default null,
  p_provider_order_id text default null,
  p_actor text default 'system',
  p_allow_negative boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_product public.anv_products%rowtype;
  v_existing public.anv_stock_movements%rowtype;
  v_delta integer;
  v_after integer;
  v_movement_id uuid;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing from public.anv_stock_movements where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'duplicate', true,
        'movement_id', v_existing.id,
        'balance_after', v_existing.balance_after
      );
    end if;
  end if;

  select * into v_product
  from public.anv_products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'product_not_found';
  end if;

  v_delta := case upper(p_type)
    when 'ENTRADA' then p_quantity
    when 'DEVOLUCAO' then p_quantity
    when 'ESTORNO' then p_quantity
    when 'CANCELAMENTO' then p_quantity
    when 'LIBERACAO_RESERVA' then p_quantity
    when 'SAIDA' then -p_quantity
    when 'VENDA' then -p_quantity
    when 'RESERVA' then -p_quantity
    when 'AJUSTE_POSITIVO' then p_quantity
    when 'AJUSTE_NEGATIVO' then -p_quantity
    else null
  end;

  if v_delta is null then
    raise exception 'movement_type_invalid';
  end if;

  v_after := v_product.stock + v_delta;
  if v_after < 0 and not p_allow_negative then
    raise exception 'insufficient_stock';
  end if;

  insert into public.anv_stock_movements(
    product_id, type, quantity, delta, balance_before, balance_after,
    reason, idempotency_key, provider_order_id, actor
  ) values (
    p_product_id, upper(p_type), p_quantity, v_delta, v_product.stock, v_after,
    p_reason, p_idempotency_key, p_provider_order_id, p_actor
  )
  returning id into v_movement_id;

  update public.anv_products
  set stock = greatest(v_after, 0), updated_at = now()
  where id = p_product_id;

  if v_after <= v_product.minimum_stock then
    if not exists (
      select 1 from public.anv_alerts
      where kind = 'LOW_STOCK'
        and entity_type = 'product'
        and entity_id = p_product_id::text
        and resolved = false
    ) then
      insert into public.anv_alerts(kind, severity, title, message, entity_type, entity_id)
      values (
        'LOW_STOCK',
        case when v_after <= 0 then 'critical' else 'warning' end,
        'Estoque baixo: ' || v_product.name,
        'Saldo atual: ' || greatest(v_after,0)::text || ' | mínimo: ' || v_product.minimum_stock::text,
        'product',
        p_product_id::text
      );

      insert into public.anv_notifications(kind, title, message, entity_type, entity_id)
      values (
        'LOW_STOCK',
        'Reposição necessária',
        v_product.name || ' chegou a ' || greatest(v_after,0)::text || ' unidade(s).',
        'product',
        p_product_id::text
      );
    end if;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'movement_id', v_movement_id,
    'balance_before', v_product.stock,
    'balance_after', greatest(v_after,0)
  );
exception
  when unique_violation then
    if p_idempotency_key is not null then
      select * into v_existing from public.anv_stock_movements where idempotency_key = p_idempotency_key;
      return jsonb_build_object(
        'duplicate', true,
        'movement_id', v_existing.id,
        'balance_after', v_existing.balance_after
      );
    end if;
    raise;
end;
$$;

revoke all on function public.anv_apply_stock_movement(uuid,text,integer,text,text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.anv_apply_stock_movement(uuid,text,integer,text,text,text,text,boolean) to service_role;
