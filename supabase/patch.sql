-- OffRecord (Supabase) patch
-- Run this if you've already applied `supabase/schema.sql` and pulled a newer version of the repo.

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

