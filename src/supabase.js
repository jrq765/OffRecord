import { createClient } from "@supabase/supabase-js";

const requiredKeys = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const missingKeys = requiredKeys.filter((k) => !import.meta.env[k]);

export const supabaseInitError =
  missingKeys.length > 0 ? new Error(`Missing Supabase env vars: ${missingKeys.join(", ")}`) : null;

export const supabase = supabaseInitError
  ? null
  : createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

