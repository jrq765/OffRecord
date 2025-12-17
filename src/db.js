import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { db } from "./firebase";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const assertDb = () => {
  if (!db) throw new Error("Firebase is not configured (missing VITE_FIREBASE_* env vars).");
};

export const createGroup = async ({ name, hostUid, hostEmail, members }) => {
  assertDb();
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

  const groupRef = doc(collection(db, "groups"));

  const memberEmails = normalizedMembers.map((m) => m.emailLower);
  await setDoc(groupRef, {
    name: groupName,
    hostUid,
    hostEmailLower: normalizeEmail(hostEmail),
    members: normalizedMembers.map(({ emailLower, name }) => ({ emailLower, name })),
    memberEmails,
    createdAt: serverTimestamp()
  });

  const invitesCollection = collection(db, "invitations");
  const createdInvites = [];
  for (const invite of normalizedMembers) {
    const inviteRef = doc(invitesCollection);
    const inviteDoc = {
      groupId: groupRef.id,
      hostUid,
      hostEmailLower: normalizeEmail(hostEmail),
      emailLower: invite.emailLower,
      name: invite.name,
      tempPassword: invite.tempPassword,
      redeemedByUid: null,
      redeemedAt: null,
      createdAt: serverTimestamp()
    };
    await setDoc(inviteRef, inviteDoc);
    createdInvites.push({ id: inviteRef.id, ...inviteDoc });
  }

  return {
    group: {
      id: groupRef.id,
      name: groupName,
      hostUid,
      hostEmailLower: normalizeEmail(hostEmail),
      members: normalizedMembers.map(({ emailLower, name }) => ({ emailLower, name })),
      memberEmails
    },
    invitations: createdInvites
  };
};

export const listHostedGroups = async ({ hostUid }) => {
  assertDb();
  const q = query(collection(db, "groups"), where("hostUid", "==", hostUid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

export const listMemberGroups = async ({ emailLower }) => {
  assertDb();
  const q = query(collection(db, "groups"), where("memberEmails", "array-contains", normalizeEmail(emailLower)));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

export const listGroupInvitations = async ({ groupId }) => {
  assertDb();
  const q = query(collection(db, "invitations"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

export const listGroupResponses = async ({ groupId }) => {
  assertDb();
  const q = query(collection(db, "responses"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

export const submitGroupResponse = async ({ groupId, respondentUid, respondentEmailLower, feedbackItems }) => {
  assertDb();
  const responsesCollection = collection(db, "responses");
  const docRef = await addDoc(responsesCollection, {
    groupId,
    respondentUid,
    respondentEmailLower: normalizeEmail(respondentEmailLower),
    submittedAt: serverTimestamp(),
    feedbackItems
  });
  return docRef.id;
};

export const upsertUserProfile = async ({ uid, emailLower, firstName, role }) => {
  assertDb();
  const userRef = doc(db, "users", uid);
  await setDoc(
    userRef,
    {
      emailLower: normalizeEmail(emailLower),
      firstName: String(firstName || "").trim(),
      role: role || "member",
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
};

export const getUserProfile = async ({ uid }) => {
  assertDb();
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
};

export const redeemInvitationForUser = async ({ uid, emailLower, tempPassword }) => {
  assertDb();
  const normalizedEmail = normalizeEmail(emailLower);
  const q = query(collection(db, "invitations"), where("emailLower", "==", normalizedEmail));
  const snap = await getDocs(q);
  const match = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((inv) => inv.tempPassword === tempPassword);

  if (!match) throw new Error("Invalid email or temporary password");
  if (match.redeemedByUid && match.redeemedByUid !== uid) throw new Error("Invitation already redeemed");

  if (!match.redeemedByUid) {
    await updateDoc(doc(db, "invitations", match.id), {
      redeemedByUid: uid,
      redeemedAt: serverTimestamp()
    });
  }

  return match;
};

export const deleteGroupCascade = async ({ groupId }) => {
  assertDb();
  const batch = writeBatch(db);

  batch.delete(doc(db, "groups", groupId));

  const invitesSnap = await getDocs(query(collection(db, "invitations"), where("groupId", "==", groupId)));
  invitesSnap.forEach((d) => batch.delete(d.ref));

  const responsesSnap = await getDocs(query(collection(db, "responses"), where("groupId", "==", groupId)));
  responsesSnap.forEach((d) => batch.delete(d.ref));

  await batch.commit();
};
