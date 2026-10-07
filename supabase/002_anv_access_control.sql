-- ANV Filial Digital — controle de acesso comercial por usuário
-- Proprietário continua via ANV_LOGIN_EMAIL/ANV_LOGIN_PASSWORD (Vercel env).
-- Usuários cliente ficam nesta tabela e podem ser liberados/travados sem novo deploy.

create table if not exists public.anv_access_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  password_hash text not null,
  role text not null default 'client',
  access_status text not null default 'AGUARDANDO_LIBERACAO',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anv_access_users_role_check check (role in ('client','owner')),
  constraint anv_access_users_status_check check (access_status in ('AGUARDANDO_LIBERACAO','LIBERADO','BLOQUEADO')),
  constraint anv_access_users_email_lower_check check (email = lower(email))
);

create index if not exists anv_access_users_status_idx
  on public.anv_access_users(access_status, active);

alter table public.anv_access_users enable row level security;
revoke all on table public.anv_access_users from anon, authenticated;
grant select, insert, update, delete on table public.anv_access_users to service_role;
