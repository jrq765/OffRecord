import { supabase, supabaseInitError } from "./supabase";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const assertSupabase = () => {
  if (supabaseInitError || !supabase) {
    throw new Error("Supabase is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
  }
};

const throwIfError = (error) => {
  if (!error) return;
  const message = error?.message || "Request failed";
  throw new Error(message);
};

const mapGroupRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostUid: row.host_uid,
    hostEmailLower: row.host_email_lower,
    members: Array.isArray(row.members) ? row.members : [],
    memberEmails: Array.isArray(row.member_emails) ? row.member_emails : []
  };
};

const mapInvitationRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    hostUid: row.host_uid,
    hostEmailLower: row.host_email_lower,
    emailLower: row.email_lower,
    name: row.name,
    tempPassword: row.temp_password,
    redeemedByUid: row.redeemed_by_uid,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at
  };
};

const mapResponseRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    respondentUid: row.respondent_uid,
    respondentEmailLower: row.respondent_email_lower,
    submittedAt: row.submitted_at,
    feedbackItems: Array.isArray(row.feedback_items) ? row.feedback_items : row.feedback_items || []
  };
};

export const createGroup = async ({ name, hostUid, hostEmail, members }) => {
  assertSupabase();
  const groupName = String(name || "").trim();
  if (!groupName) throw new Error("Group name is required");

  const normalizedMembers = (members || [])
    .map((m) => ({
      emailLower: normalizeEmail(m.email),
      name: String(m.name || "").trim(),
      tempPassword: String(m.tempPassword || "").trim()
    }))
    .filter((m) => m.emailLower && m.name && m.tempPassword);

  if (normalizedMembers.length < 3) throw new Error("You need at least 3 members");

  const emails = normalizedMembers.map((m) => m.emailLower);
  if (new Set(emails).size !== emails.length) throw new Error("Each member must have a unique email");

  const memberEmails = normalizedMembers.map((m) => m.emailLower);
  const membersForGroup = normalizedMembers.map(({ emailLower, name }) => ({ emailLower, name }));

  const { data: groupRow, error: groupError } = await supabase
    .from("groups")
    .insert({
      name: groupName,
      host_uid: hostUid,
      host_email_lower: normalizeEmail(hostEmail),
      members: membersForGroup,
      member_emails: memberEmails
    })
    .select("*")
    .single();
  throwIfError(groupError);

  const invitesInsert = normalizedMembers.map((m) => ({
    group_id: groupRow.id,
    host_uid: hostUid,
    host_email_lower: normalizeEmail(hostEmail),
    email_lower: m.emailLower,
    name: m.name,
    temp_password: m.tempPassword,
    redeemed_by_uid: null,
    redeemed_at: null
  }));

  const { data: inviteRows, error: inviteError } = await supabase
    .from("invitations")
    .insert(invitesInsert)
    .select("*");
  throwIfError(inviteError);

  return {
    group: mapGroupRow(groupRow),
    invitations: (inviteRows || []).map(mapInvitationRow)
  };
};

export const listHostedGroups = async ({ hostUid }) => {
  assertSupabase();
  const { data, error } = await supabase.from("groups").select("*").eq("host_uid", hostUid);
  throwIfError(error);
  return (data || []).map(mapGroupRow);
};

export const listMemberGroups = async ({ emailLower }) => {
  assertSupabase();
  const normalized = normalizeEmail(emailLower);
  const { data, error } = await supabase.from("groups").select("*").contains("member_emails", [normalized]);
  throwIfError(error);
  return (data || []).map(mapGroupRow);
};

export const listGroupInvitations = async ({ groupId }) => {
  assertSupabase();
  const { data, error } = await supabase.from("invitations").select("*").eq("group_id", groupId);
  throwIfError(error);
  return (data || []).map(mapInvitationRow);
};

export const listGroupResponses = async ({ groupId }) => {
  assertSupabase();
  const { data, error } = await supabase.from("responses").select("*").eq("group_id", groupId);
  throwIfError(error);
  return (data || []).map(mapResponseRow);
};

export const submitGroupResponse = async ({ groupId, respondentUid, respondentEmailLower, feedbackItems }) => {
  assertSupabase();
  const { data, error } = await supabase
    .from("responses")
    .insert({
      group_id: groupId,
      respondent_uid: respondentUid,
      respondent_email_lower: normalizeEmail(respondentEmailLower),
      feedback_items: feedbackItems
    })
    .select("id")
    .single();
  throwIfError(error);
  return data.id;
};

export const upsertUserProfile = async ({ uid, emailLower, firstName, role }) => {
  assertSupabase();
  const { error } = await supabase.from("profiles").upsert(
    {
      id: uid,
      email_lower: normalizeEmail(emailLower),
      first_name: String(firstName || "").trim(),
      role: role || "member",
      updated_at: new Date().toISOString()
    },
    { onConflict: "id" }
  );
  throwIfError(error);
};

export const getUserProfile = async ({ uid }) => {
  assertSupabase();
  const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
  throwIfError(error);
  if (!data) return null;
  return {
    id: data.id,
    emailLower: data.email_lower,
    firstName: data.first_name,
    role: data.role
  };
};

export const redeemInvitationForUser = async ({ uid, emailLower, tempPassword }) => {
  const normalizedEmail = normalizeEmail(emailLower);
  assertSupabase();
  const { data: invite, error } = await supabase
    .from("invitations")
    .select("*")
    .eq("email_lower", normalizedEmail)
    .eq("temp_password", tempPassword)
    .maybeSingle();
  throwIfError(error);

  if (!invite) throw new Error("Invalid email or temporary password");
  if (invite.redeemed_by_uid && invite.redeemed_by_uid !== uid) throw new Error("Invitation already redeemed");

  if (!invite.redeemed_by_uid) {
    const { data: updated, error: updateError } = await supabase
      .from("invitations")
      .update({ redeemed_by_uid: uid, redeemed_at: new Date().toISOString() })
      .eq("id", invite.id)
      .select("*")
      .single();
    throwIfError(updateError);
    return mapInvitationRow(updated);
  }

  return mapInvitationRow(invite);
};

export const deleteGroupCascade = async ({ groupId }) => {
  assertSupabase();
  const { error } = await supabase.from("groups").delete().eq("id", groupId);
  throwIfError(error);
};
