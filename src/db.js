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

export const createGroup = async ({ name, hostUid, hostEmail, hostName, members }) => {
  assertSupabase();
  const groupName = String(name || "").trim();
  if (!groupName) throw new Error("Group name is required");

  const hostEmailLower = normalizeEmail(hostEmail);
  const hostDisplayName = String(hostName || "").trim() || (hostEmailLower ? hostEmailLower.split("@")[0] : "Host");

  const normalizedMembers = (members || [])
    .map((m) => ({
      emailLower: normalizeEmail(m.email),
      name: String(m.name || "").trim(),
      tempPassword: String(m.tempPassword || "").trim()
    }))
    .filter((m) => m.emailLower && m.name && m.tempPassword);

  const emails = normalizedMembers.map((m) => m.emailLower);
  if (emails.includes(hostEmailLower)) throw new Error("You don't need to add yourself as a member");
  if (new Set(emails).size !== emails.length) throw new Error("Each member must have a unique email");

  const membersForGroup = [
    { emailLower: hostEmailLower, name: hostDisplayName },
    ...normalizedMembers.map(({ emailLower, name }) => ({ emailLower, name }))
  ];
  const memberEmails = membersForGroup.map((m) => m.emailLower);

  const { data: groupRow, error: groupError } = await supabase
    .from("groups")
    .insert({
      name: groupName,
      host_uid: hostUid,
      host_email_lower: hostEmailLower,
      members: membersForGroup,
      member_emails: memberEmails
    })
    .select("*")
    .single();
  throwIfError(groupError);

  let inviteRows = [];
  if (normalizedMembers.length > 0) {
    const invitesInsert = normalizedMembers.map((m) => ({
      group_id: groupRow.id,
      host_uid: hostUid,
      host_email_lower: hostEmailLower,
      email_lower: m.emailLower,
      name: m.name,
      temp_password: m.tempPassword,
      redeemed_by_uid: null,
      redeemed_at: null
    }));

    const res = await supabase.from("invitations").insert(invitesInsert).select("*");
    throwIfError(res.error);
    inviteRows = res.data || [];
  }

  return {
    group: mapGroupRow(groupRow),
    invitations: (inviteRows || []).map(mapInvitationRow)
  };
};

export const createGroupInvitations = async ({ groupId, hostUid, hostEmailLower, members }) => {
  assertSupabase();
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) throw new Error("groupId is required");

  const hostEmail = normalizeEmail(hostEmailLower);
  if (!hostEmail) throw new Error("hostEmailLower is required");

  const normalizedMembers = (members || [])
    .map((m) => ({
      emailLower: normalizeEmail(m.emailLower || m.email),
      name: String(m.name || "").trim(),
      tempPassword: String(m.tempPassword || "").trim()
    }))
    .filter((m) => m.emailLower && m.name && m.tempPassword);

  const emails = normalizedMembers.map((m) => m.emailLower);
  if (emails.includes(hostEmail)) throw new Error("Don't create an invitation for the host email");
  if (new Set(emails).size !== emails.length) throw new Error("Each member must have a unique email");

  if (normalizedMembers.length === 0) return [];

  const invitesInsert = normalizedMembers.map((m) => ({
    group_id: normalizedGroupId,
    host_uid: hostUid,
    host_email_lower: hostEmail,
    email_lower: m.emailLower,
    name: m.name,
    temp_password: m.tempPassword,
    redeemed_by_uid: null,
    redeemed_at: null
  }));

  const { data, error } = await supabase.from("invitations").insert(invitesInsert).select("*");
  throwIfError(error);
  return (data || []).map(mapInvitationRow);
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

  // Prefer "redeemed invitation" membership; avoid embedded selects (they can fail silently if the relationship isn't cached).
  const { data: inviteRows, error: inviteError } = await supabase
    .from("invitations")
    .select("group_id")
    .eq("redeemed_by_uid", uid);
  throwIfError(inviteError);

  const groupIds = Array.from(new Set((inviteRows || []).map((r) => r.group_id).filter(Boolean)));
  if (groupIds.length > 0) {
    const { data, error } = await supabase.from("groups").select("*").in("id", groupIds);
    throwIfError(error);
    const groups = (data || []).map(mapGroupRow);
    if (groups.length > 0) return groups;
    throw new Error(
      "Your invite was redeemed, but your database is blocking group reads (RLS). Run supabase/patch.sql in Supabase, then reload schema."
    );
  }

  // Fall back to email-based membership for hosts / legacy groups.
  if (!normalized) return [];
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

export const getMemberIdentityFromInvites = async ({ uid }) => {
  assertSupabase();
  const { data, error } = await supabase
    .from("invitations")
    .select("email_lower,name,redeemed_at")
    .eq("redeemed_by_uid", uid)
    .order("redeemed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  throwIfError(error);
  if (!data) return null;
  return {
    emailLower: data.email_lower,
    firstName: data.name
  };
};

export const deleteGroupCascade = async ({ groupId }) => {
  assertSupabase();
  const { error } = await supabase.from("groups").delete().eq("id", groupId);
  throwIfError(error);
};

export const updateGroupMembers = async ({ groupId, members }) => {
  assertSupabase();
  const normalizedMembers = (members || [])
    .map((m) => ({
      emailLower: normalizeEmail(m.emailLower || m.email),
      name: String(m.name || "").trim()
    }))
    .filter((m) => m.emailLower && m.name);

  const memberEmails = normalizedMembers.map((m) => m.emailLower);

  const { data, error } = await supabase
    .from("groups")
    .update({ members: normalizedMembers, member_emails: memberEmails })
    .eq("id", groupId)
    .select("*")
    .single();
  throwIfError(error);
  return mapGroupRow(data);
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
