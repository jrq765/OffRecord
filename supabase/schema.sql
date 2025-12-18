-- OffRecord (Supabase) schema
-- Run this in Supabase: SQL Editor

create extension if not exists pgcrypto;

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
create index if not exists invitations_redeemed_by_uid_idx on public.invitations (redeemed_by_uid);

-- Redeem an invitation without requiring an email-bearing auth user.
-- Members will authenticate anonymously, then redeem using (email + temp password).
create or replace function public.redeem_invitation(email_lower_input text, temp_password_input text)
returns public.invitations
language plpgsql
security definer
set search_path = public
as $$
declare inv public.invitations;
begin
  select *
    into inv
  from public.invitations
  where email_lower = lower(email_lower_input)
    and temp_password = temp_password_input
  limit 1;

  if not found then
    raise exception 'Invalid email or temporary password';
  end if;

  if inv.redeemed_by_uid is not null and inv.redeemed_by_uid <> auth.uid() then
    raise exception 'Invitation already redeemed';
  end if;

  if inv.redeemed_by_uid is null then
    update public.invitations
      set redeemed_by_uid = auth.uid(),
          redeemed_at = now()
      where id = inv.id
      returning * into inv;
  end if;

  return inv;
end;
$$;

grant execute on function public.redeem_invitation(text, text) to authenticated;

-- Submissions (one per respondent per group; used for progress without exposing feedback contents)
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  respondent_uid uuid not null references auth.users (id) on delete cascade,
  submitted_at timestamptz not null default now(),
  unique (group_id, respondent_uid)
);

create index if not exists submissions_group_id_idx on public.submissions (group_id);
create index if not exists submissions_respondent_uid_idx on public.submissions (respondent_uid);

-- Feedback (per-recipient rows; recipients can only read their own)
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  respondent_uid uuid not null references auth.users (id) on delete cascade,
  recipient_email_lower text not null,
  strengths text not null,
  improvements text not null,
  score integer not null,
  submitted_at timestamptz not null default now()
);

create index if not exists feedback_group_id_idx on public.feedback (group_id);
create index if not exists feedback_respondent_uid_idx on public.feedback (respondent_uid);
create index if not exists feedback_recipient_email_lower_idx on public.feedback (recipient_email_lower);

-- Submit feedback in one transaction
create or replace function public.submit_feedback(group_id_input uuid, items jsonb)
returns void
language plpgsql
as $$
declare item jsonb;
begin
  insert into public.submissions (group_id, respondent_uid)
  values (group_id_input, auth.uid());

  for item in select * from jsonb_array_elements(items)
  loop
    insert into public.feedback (
      group_id,
      respondent_uid,
      recipient_email_lower,
      strengths,
      improvements,
      score
    ) values (
      group_id_input,
      auth.uid(),
      lower(coalesce(item->>'recipientEmailLower', item->>'recipient_email_lower')),
      coalesce(item->>'strengths',''),
      coalesce(item->>'improvements',''),
      (coalesce(item->>'score','0'))::integer
    );
  end loop;
end;
$$;

grant execute on function public.submit_feedback(uuid, jsonb) to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.invitations enable row level security;
alter table public.submissions enable row level security;
alter table public.feedback enable row level security;

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
  or exists (
    select 1 from public.invitations i
    where i.group_id = groups.id
      and i.redeemed_by_uid = auth.uid()
  )
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
  or redeemed_by_uid = auth.uid()
);

create policy "invites_create_host"
on public.invitations for insert
to authenticated
with check (host_uid = auth.uid());

create policy "invites_update_host"
on public.invitations for update
to authenticated
using (host_uid = auth.uid())
with check (host_uid = auth.uid());

create policy "invites_delete_host"
on public.invitations for delete
to authenticated
using (host_uid = auth.uid());

-- Submissions policies (progress visibility)
create policy "submissions_read_host_or_member"
on public.submissions for select
to authenticated
using (
  exists (
    select 1 from public.groups g
    where g.id = submissions.group_id
      and (
        g.host_uid = auth.uid()
        or exists (
          select 1 from public.invitations i
          where i.group_id = g.id
            and i.redeemed_by_uid = auth.uid()
        )
      )
  )
);

create policy "submissions_create_member"
on public.submissions for insert
to authenticated
with check (
  respondent_uid = auth.uid()
  and exists (
    select 1 from public.invitations i
    where i.group_id = submissions.group_id
      and i.redeemed_by_uid = auth.uid()
  )
);

-- Feedback policies (privacy)
create policy "feedback_read_host"
on public.feedback for select
to authenticated
using (
  exists (
    select 1 from public.groups g
    where g.id = feedback.group_id
      and g.host_uid = auth.uid()
  )
);

create policy "feedback_read_recipient"
on public.feedback for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.email_lower = feedback.recipient_email_lower
  )
);

create policy "feedback_create_member"
on public.feedback for insert
to authenticated
with check (
  respondent_uid = auth.uid()
  and exists (
    select 1 from public.invitations i
    where i.group_id = feedback.group_id
      and i.redeemed_by_uid = auth.uid()
  )
);

create policy "feedback_delete_host"
on public.feedback for delete
to authenticated
using (
  exists (
    select 1 from public.groups g
    where g.id = feedback.group_id
      and g.host_uid = auth.uid()
  )
);
