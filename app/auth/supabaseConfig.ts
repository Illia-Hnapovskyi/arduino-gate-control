// Public Supabase configuration for the browser auth client. Both values are
// public knowledge and safe to commit — access control happens server-side.
export const SUPABASE_URL = "https://vullhduhswcnlpgnlrtp.supabase.co";

// The PUBLIC publishable key from Supabase Dashboard → Settings → API keys.
// Supabase states these "can be safely shared publicly"; the sb_publishable_
// prefix marks it. Never put a secret/service_role key here.
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HPs8PPP-soq1AcmSZnnczA_ZjO8o0EQ";

export const authAvailable = SUPABASE_PUBLISHABLE_KEY.length > 0;

// Sign in with Apple stays hidden until the paid Apple Developer Program
// membership is confirmed (flip to true only after the provider is configured
// in the Supabase dashboard).
export const APPLE_ENABLED = false;
