# OffRecord

Anonymous peer feedback for small groups. This repo is a Vite + React + Tailwind app backed by Supabase (Auth + Postgres) so groups/invites/responses work across devices.

## Local development

```bash
cp .env.example .env
# fill in your Supabase env vars
npm install
npm run dev
```

## Supabase setup (one-time)

1. Create a Supabase project: https://supabase.com
2. In Supabase → SQL Editor: run `supabase/schema.sql`
3. In Supabase → Authentication → Providers: enable `Email` (email/password) and `Anonymous` (for invite-code join)
4. In Supabase → Project settings → API: copy:
   - Project URL → `VITE_SUPABASE_URL`
   - `anon` public key → `VITE_SUPABASE_ANON_KEY`
5. Recommended for this app’s current flow: disable email confirmations (Supabase Auth → Email confirmations)

## Supabase updates (when pulling new code)

- If you've already run `supabase/schema.sql` before, run `supabase/patch.sql` in Supabase → SQL Editor to apply policy/function updates.

## Deploy to Netlify

- Build command: `npm run build`
- Publish directory: `dist`
- SPA routing is handled via `public/_redirects`.
- In Netlify → Site settings → Environment variables: set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- In Supabase → Authentication → URL Configuration: add your Netlify domain to allowed redirect URLs.

## Invite emails (optional, recommended)

OffRecord can automatically email invite codes to members via a Netlify Function + Resend.

In Netlify → Site settings → Environment variables, set:

- `SUPABASE_URL` (same as `VITE_SUPABASE_URL`, but server-side)
- `SUPABASE_SERVICE_ROLE_KEY` (Supabase Project Settings → API → service_role key) **do not expose to client**
- `RESEND_API_KEY` (from https://resend.com)
- `OFFRECORD_FROM_EMAIL` (optional; defaults to `onboarding@resend.dev`)

## If you see a white screen on Netlify

1. Open DevTools Console: if you see “Missing Supabase env vars…”, add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in Netlify and redeploy.
2. Check Netlify deploy logs: confirm the site is publishing `dist` (not the repo root).
3. Confirm your Supabase project is reachable and your Netlify domain is allowed in Supabase Auth URL configuration.
