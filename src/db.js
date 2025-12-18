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

const mapSubmissionRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    respondentUid: row.respondent_uid,
    submittedAt: row.submitted_at
  };
};

const mapFeedbackRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    respondentUid: row.respondent_uid,
    recipientEmailLower: row.recipient_email_lower,
    strengths: row.strengths,
    improvements: row.improvements,
    score: row.score,
    submittedAt: row.submitted_at
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

export const listMemberGroups = async ({ uid, emailLower }) => {
  assertSupabase();
  const normalized = normalizeEmail(emailLower);

  // Prefer "redeemed invitation" membership; fall back to array membership for legacy/host use.
  const { data: inviteRows, error: inviteError } = await supabase
    .from("invitations")
    .select("group:groups(*)")
    .eq("redeemed_by_uid", uid);
  throwIfError(inviteError);

  const groupsFromInvites = (inviteRows || []).map((r) => r.group).filter(Boolean).map(mapGroupRow);

  if (groupsFromInvites.length > 0) return groupsFromInvites;

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
  const { data, error } = await supabase.from("submissions").select("*").eq("group_id", groupId);
  throwIfError(error);
  return (data || []).map(mapSubmissionRow);
};

export const submitGroupResponse = async ({ groupId, respondentUid, respondentEmailLower, feedbackItems }) => {
  assertSupabase();
  void respondentUid;
  void respondentEmailLower;
  const { error } = await supabase.rpc("submit_feedback", { group_id_input: groupId, items: feedbackItems });
  throwIfError(error);
  return true;
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
  void uid;
  const { data, error } = await supabase.rpc("redeem_invitation", {
    email_lower_input: normalizedEmail,
    temp_password_input: tempPassword
  });
  throwIfError(error);
  return mapInvitationRow(data);
};

export const deleteGroupCascade = async ({ groupId }) => {
  assertSupabase();
  const { error } = await supabase.from("groups").delete().eq("id", groupId);
  throwIfError(error);
};

export const listGroupFeedbackForRecipient = async ({ groupId, recipientEmailLower }) => {
  assertSupabase();
  const normalized = normalizeEmail(recipientEmailLower);
  const { data, error } = await supabase
    .from("feedback")
    .select("*")
    .eq("group_id", groupId)
    .eq("recipient_email_lower", normalized);
  throwIfError(error);
  return (data || []).map(mapFeedbackRow);
};
