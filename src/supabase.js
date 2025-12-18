import { createClient } from "@supabase/supabase-js";

const requiredKeys = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const missingKeys = requiredKeys.filter((k) => !import.meta.env[k]);

export const supabaseInitError =
  missingKeys.length > 0 ? new Error(`Missing Supabase env vars: ${missingKeys.join(", ")}`) : null;

const getTabId = () => {
  if (typeof window === "undefined") return "server";
  try {
    const key = "offrecord_tab_id";
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
};

export const supabase = supabaseInitError
  ? null
  : createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: {
        storage: typeof window === "undefined" ? undefined : window.sessionStorage,
        storageKey: `offrecord-auth-${getTabId()}`,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
