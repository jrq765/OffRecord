-- OffRecord (Supabase) schema
-- Run this in Supabase: SQL Editor

-- Profiles (user metadata)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email_lower text not null,
  first_name text not null,
  role text not null check (role in ('host','member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_uidx on public.profiles (email_lower);

-- Groups
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host_uid uuid not null references auth.users (id) on delete cascade,
  host_email_lower text not null,
  members jsonb not null default '[]'::jsonb, -- [{emailLower,name}]
  member_emails text[] not null default '{}'::text[],
  created_at timestamptz not null default now()
);

create index if not exists groups_host_uid_idx on public.groups (host_uid);
create index if not exists groups_member_emails_gin on public.groups using gin (member_emails);

-- Invitations (email + temp password)
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  host_uid uuid not null references auth.users (id) on delete cascade,
  host_email_lower text not null,
  email_lower text not null,
  name text not null,
  temp_password text not null,
  redeemed_by_uid uuid null references auth.users (id) on delete set null,
  redeemed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists invitations_group_id_idx on public.invitations (group_id);
create index if not exists invitations_email_lower_idx on public.invitations (email_lower);

-- Responses
create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  respondent_uid uuid not null references auth.users (id) on delete cascade,
  respondent_email_lower text not null,
  feedback_items jsonb not null default '[]'::jsonb,
  submitted_at timestamptz not null default now()
);

create index if not exists responses_group_id_idx on public.responses (group_id);
create index if not exists responses_respondent_uid_idx on public.responses (respondent_uid);

-- RLS
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.invitations enable row level security;
alter table public.responses enable row level security;

-- Profiles policies
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using (id = auth.uid());

create policy "profiles_upsert_own"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- Groups policies
create policy "groups_read_host_or_member"
on public.groups for select
to authenticated
using (
  host_uid = auth.uid()
  or member_emails @> array[lower(auth.jwt()->>'email')]
);

create policy "groups_create_host"
on public.groups for insert
to authenticated
with check (host_uid = auth.uid());

create policy "groups_update_delete_host"
on public.groups for update
to authenticated
using (host_uid = auth.uid())
with check (host_uid = auth.uid());

create policy "groups_delete_host"
on public.groups for delete
to authenticated
using (host_uid = auth.uid());

-- Invitations policies
create policy "invites_read_host_or_invitee"
on public.invitations for select
to authenticated
using (
  host_uid = auth.uid()
  or email_lower = lower(auth.jwt()->>'email')
);

create policy "invites_create_host"
on public.invitations for insert
to authenticated
with check (host_uid = auth.uid());

create policy "invites_update_host_or_invitee_redeem"
on public.invitations for update
to authenticated
using (
  host_uid = auth.uid()
  or (email_lower = lower(auth.jwt()->>'email') and redeemed_by_uid = auth.uid())
)
with check (
  host_uid = auth.uid()
  or (email_lower = lower(auth.jwt()->>'email') and redeemed_by_uid = auth.uid())
);

create policy "invites_delete_host"
on public.invitations for delete
to authenticated
using (host_uid = auth.uid());

-- Responses policies
create policy "responses_read_group_host_or_member"
on public.responses for select
to authenticated
using (
  exists (
    select 1 from public.groups g
    where g.id = responses.group_id
      and (
        g.host_uid = auth.uid()
        or g.member_emails @> array[lower(auth.jwt()->>'email')]
      )
  )
);

create policy "responses_create_self"
on public.responses for insert
to authenticated
with check (respondent_uid = auth.uid());

create policy "responses_delete_host"
on public.responses for delete
to authenticated
using (
  exists (
    select 1 from public.groups g
    where g.id = responses.group_id
      and g.host_uid = auth.uid()
  )
);

