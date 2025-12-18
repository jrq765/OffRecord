import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";

const requiredKeys = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID"
];

const missingKeys = requiredKeys.filter((k) => !import.meta.env[k]);

export const firebaseInitError =
  missingKeys.length > 0
    ? new Error(`Missing Firebase env vars: ${missingKeys.join(", ")}`)
    : null;

export const firebaseApp = firebaseInitError
  ? null
  : initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID
    });

export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const db = firebaseApp
  ? initializeFirestore(firebaseApp, { experimentalAutoDetectLongPolling: true })
  : null;
