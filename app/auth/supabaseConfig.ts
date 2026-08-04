// Public Supabase configuration for the browser auth client. Both values are
// public knowledge and safe to commit — access control happens server-side.
export const SUPABASE_URL = "https://vullhduhswcnlpgnlrtp.supabase.co";

// Paste the PUBLIC publishable key from Supabase Dashboard → Settings → API
// keys. While this placeholder stays empty, authAvailable is false, the whole
// account UI stays hidden and demo/offline/local play works unchanged.
export const SUPABASE_PUBLISHABLE_KEY = "";

export const authAvailable = SUPABASE_PUBLISHABLE_KEY.length > 0;

// Sign in with Apple stays hidden until the paid Apple Developer Program
// membership is confirmed (flip to true only after the provider is configured
// in the Supabase dashboard).
export const APPLE_ENABLED = false;
