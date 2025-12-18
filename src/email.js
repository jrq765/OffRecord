import { supabase, supabaseInitError } from "./supabase";

export const sendGroupInviteEmails = async ({ groupId }) => {
  if (supabaseInitError || !supabase) {
    throw new Error("Supabase is not configured.");
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data?.session?.access_token;
  if (!token) throw new Error("Missing auth session");

  const res = await fetch("/.netlify/functions/send-invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      groupId,
      appUrl: typeof window === "undefined" ? "" : window.location.origin
    })
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Failed to send emails");
  }
  return payload;
};

