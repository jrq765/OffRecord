# Feedback Circle

Anonymous peer feedback for small groups. This repo is a Vite + React + Tailwind app backed by Firebase (Auth + Firestore) so groups/invites/responses work across devices.

## Local development

```bash
cp .env.example .env
# fill in your Firebase env vars
npm install
npm run dev
```

## Firebase setup (one-time)

1. Create a Firebase project
2. Enable Authentication → Sign-in method → `Email/Password`
3. Create a Firestore database
4. Apply the security rules in `firebase/firestore.rules`
5. Copy your Firebase web app config into `.env` (Vite uses `VITE_`-prefixed env vars)

## Deploy to Netlify

- Build command: `npm run build`
- Publish directory: `dist`
- SPA routing is handled via `public/_redirects`.
- In Netlify → Site settings → Environment variables: set the same `VITE_FIREBASE_*` values from your `.env`.
- In Firebase → Authentication → Settings → Authorized domains: add your Netlify domain (and any custom domain).
