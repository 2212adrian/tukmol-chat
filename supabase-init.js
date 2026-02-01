// supabase-init.js

const SUPABASE_URL = 'https://ehupnvkselcupxqyofzy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cNXTZmBrYiYvd8SOI2ZGkQ_sWHLy_uf';
const AVATAR_BUCKET = 'profile-pictures';
const PUBLIC_BASE = `${SUPABASE_URL}/storage/v1/object/public/${AVATAR_BUCKET}`;

window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: window.sessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 20,
    },
  },
});
