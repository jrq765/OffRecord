const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

const json = (statusCode, body) => {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
};

const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
};

const getEmailProvider = () => {
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (gmailUser && gmailAppPassword) return "gmail";
  if (process.env.RESEND_API_KEY) return "resend";
  return "none";
};

const sendResendEmail = async ({ apiKey, from, to, subject, text, html }) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${detail || res.statusText}`);
  }
  const payload = await res.json().catch(() => ({}));
  return { id: payload?.id || null };
};

const createGmailTransporter = ({ user, appPassword }) => {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    auth: { user, pass: appPassword }
  });
};

const runWithConcurrency = async ({ items, limit, handler }) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) break;
      results[i] = await handler(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!token) return json(401, { error: "Missing Authorization bearer token" });

    const { groupId, appUrl, emails } = JSON.parse(event.body || "{}");
    if (!groupId) return json(400, { error: "Missing groupId" });

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const provider = getEmailProvider();
    if (provider === "none") {
      return json(400, {
        error:
          "Email is not configured. Set either (GMAIL_USER + GMAIL_APP_PASSWORD) or RESEND_API_KEY in Netlify env vars."
      });
    }

    const resendApiKey = provider === "resend" ? requireEnv("RESEND_API_KEY") : null;
    const gmailUser = provider === "gmail" ? requireEnv("GMAIL_USER") : null;
    const gmailAppPassword = provider === "gmail" ? requireEnv("GMAIL_APP_PASSWORD") : null;

    const from =
      process.env.OFFRECORD_FROM_EMAIL ||
      (provider === "gmail" ? gmailUser : null) ||
      "onboarding@resend.dev";

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError) return json(401, { error: `Invalid session: ${userError.message}` });
    const user = userData?.user;
    if (!user) return json(401, { error: "Invalid session" });

    const { data: group, error: groupError } = await supabaseAdmin
      .from("groups")
      .select("*")
      .eq("id", groupId)
      .single();
    if (groupError) return json(400, { error: groupError.message });

    if (group.host_uid !== user.id) return json(403, { error: "Only the group host can send invites" });

    const { data: invites, error: inviteError } = await supabaseAdmin
      .from("invitations")
      .select("*")
      .eq("group_id", groupId);
    if (inviteError) return json(400, { error: inviteError.message });

    const groupName = group.name || "OffRecord group";
    const hostEmailLower = String(group.host_email_lower || "").toLowerCase();
    const members = Array.isArray(group.members) ? group.members : [];
    const hostName =
      members.find((m) => String(m.emailLower || "").toLowerCase() === hostEmailLower)?.name ||
      user.user_metadata?.first_name ||
      "A host";
    const origin = String(appUrl || "").trim() || (event.headers.origin ? String(event.headers.origin) : "");
    const signInUrl = origin ? `${origin}` : "your OffRecord site";

    const start = Date.now();

    let sent = 0;
    const failures = [];
    const results = [];

    const gmailTransporter =
      provider === "gmail"
        ? createGmailTransporter({ user: gmailUser, appPassword: gmailAppPassword })
        : null;

    let inviteList = invites || [];
    const emailFilter = Array.isArray(emails)
      ? new Set(
          emails
            .map((e) => String(e || "").trim().toLowerCase())
            .filter(Boolean)
        )
      : null;

    if (emailFilter && emailFilter.size > 0) {
      inviteList = inviteList.filter((inv) => emailFilter.has(String(inv.email_lower || "").trim().toLowerCase()));
    }
    const concurrency = provider === "gmail" ? 1 : 4;

    await runWithConcurrency({
      items: inviteList,
      limit: concurrency,
      handler: async (inv) => {
      const to = String(inv.email_lower || "").trim();
      if (!to) return { to: "", ok: false, error: "Missing invite email" };

      const inviteeName = String(inv.name || "").trim() || "there";
      const tempPassword = String(inv.temp_password || "").trim();

      const subject = `${hostName} invited you to OffRecord: ${groupName}`;
      const text =
        `Hi ${inviteeName},\n\n` +
        `${hostName} invited you to an anonymous feedback group called "${groupName}".\n\n` +
        `Sign in here: ${signInUrl}\n` +
        `Email: ${to}\n` +
        `Temporary Password: ${tempPassword}\n\n` +
        `Please fill it out when you can — it only takes a few minutes.\n\n` +
        `— OffRecord`;

      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #111;">
          <h2 style="margin: 0 0 12px;">You’ve been invited to OffRecord</h2>
          <p style="margin: 0 0 14px;">Hi ${inviteeName},</p>
          <p style="margin: 0 0 14px;">
            <strong>${hostName}</strong> invited you to an anonymous feedback group called
            <strong>“${groupName}”</strong>.
          </p>
          <div style="background:#f6f6f8;border:1px solid #e6e6ea;border-radius:12px;padding:16px;margin:18px 0;">
            <div style="font-weight:600;margin-bottom:8px;">Your sign-in details</div>
            <div><strong>Site:</strong> <a href="${signInUrl}">${signInUrl}</a></div>
            <div><strong>Email:</strong> ${to}</div>
            <div><strong>Temporary Password:</strong> <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${tempPassword}</span></div>
          </div>
          <p style="margin: 0 0 14px;">Please fill it out when you can — it only takes a few minutes.</p>
          <p style="margin: 24px 0 0; color:#666; font-size: 12px;">This feedback is anonymous. No names are attached to individual responses.</p>
        </div>
      `;

      try {
        if (provider === "gmail") {
          const info = await gmailTransporter.sendMail({
            from: from || gmailUser,
            to,
            subject,
            text,
            html
          });
          sent += 1;
          if (results.length < 20) {
            results.push({
              to,
              ok: true,
              messageId: info?.messageId || null,
              accepted: Array.isArray(info?.accepted) ? info.accepted : [],
              rejected: Array.isArray(info?.rejected) ? info.rejected : []
            });
          }
          return { to, ok: true, messageId: info?.messageId || null };
        } else {
          const info = await sendResendEmail({ apiKey: resendApiKey, from, to, subject, text, html });
          sent += 1;
          if (results.length < 20) {
            results.push({ to, ok: true, id: info?.id || null });
          }
          return { to, ok: true, id: info?.id || null };
        }
      } catch (err) {
        const error = String(err?.message || err);
        failures.push({ to, error });
        if (results.length < 20) results.push({ to, ok: false, error });
        return { to, ok: false, error };
      }
    }
    });

    return json(200, {
      ok: true,
      provider,
      from,
      sent,
      failed: failures.length,
      failures,
      results,
      durationMs: Date.now() - start
    });
  } catch (err) {
    return json(500, { error: String(err?.message || err) });
  }
};
