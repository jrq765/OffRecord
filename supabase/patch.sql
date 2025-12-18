-- OffRecord (Supabase) patch
-- Run this if you've already applied `supabase/schema.sql` and pulled a newer version of the repo.

-- Ensure required tables exist (safe to re-run)
create extension if not exists pgcrypto;

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  respondent_uid uuid not null references auth.users (id) on delete cascade,
  submitted_at timestamptz not null default now(),
  unique (group_id, respondent_uid)
);

create index if not exists submissions_group_id_idx on public.submissions (group_id);
create index if not exists submissions_respondent_uid_idx on public.submissions (respondent_uid);

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

alter table public.submissions enable row level security;
alter table public.feedback enable row level security;

-- Submit feedback in one transaction (RPC)
create or replace function public.submit_feedback(group_id_input uuid, items jsonb)
returns void
language plpgsql
as $$
declare item jsonb;
declare inserted_count integer;
begin
  insert into public.submissions (group_id, respondent_uid)
  values (group_id_input, auth.uid())
  on conflict (group_id, respondent_uid) do nothing;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    raise exception 'You have already submitted feedback for this group';
  end if;

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

-- Allow invite re-use (latest session wins)
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

  -- Allow re-redeeming from a new device/tab (latest session wins).
  if inv.redeemed_by_uid is null or inv.redeemed_by_uid <> auth.uid() then
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

-- Allow invite members to read their own invitation rows (works with anonymous auth)
alter table public.invitations enable row level security;
drop policy if exists "invites_read_host_or_invitee" on public.invitations;
create policy "invites_read_host_or_invitee"
on public.invitations for select
to authenticated
using (
  host_uid = auth.uid()
  or redeemed_by_uid = auth.uid()
);

-- Allow invite members to read their groups (works with anonymous auth: no email claim needed)
alter table public.groups enable row level security;
drop policy if exists "groups_read_host_or_member" on public.groups;
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

-- Allow participants to read submission progress
drop policy if exists "submissions_read_host_or_member" on public.submissions;
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

-- Let hosts submit feedback *only if* they are included in the group's members list.
drop policy if exists "submissions_create_member" on public.submissions;
create policy "submissions_create_member"
on public.submissions for insert
to authenticated
with check (
  respondent_uid = auth.uid()
  and (
    exists (
      select 1 from public.invitations i
      where i.group_id = submissions.group_id
        and i.redeemed_by_uid = auth.uid()
    )
    or exists (
      select 1 from public.groups g
      where g.id = submissions.group_id
        and g.host_uid = auth.uid()
        and g.member_emails @> array[lower(auth.jwt()->>'email')]
    )
  )
);

-- Members can read their feedback if they redeemed an invite for that email in that group.
drop policy if exists "feedback_read_recipient" on public.feedback;
create policy "feedback_read_recipient"
on public.feedback for select
to authenticated
using (
  exists (
    select 1 from public.invitations i
    where i.group_id = feedback.group_id
      and i.redeemed_by_uid = auth.uid()
      and i.email_lower = feedback.recipient_email_lower
  )
  or exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.email_lower = feedback.recipient_email_lower
  )
);

drop policy if exists "feedback_create_member" on public.feedback;
create policy "feedback_create_member"
on public.feedback for insert
to authenticated
with check (
  respondent_uid = auth.uid()
  and (
    exists (
      select 1 from public.invitations i
      where i.group_id = feedback.group_id
        and i.redeemed_by_uid = auth.uid()
    )
    or exists (
      select 1 from public.groups g
      where g.id = feedback.group_id
        and g.host_uid = auth.uid()
        and g.member_emails @> array[lower(auth.jwt()->>'email')]
    )
  )
);
