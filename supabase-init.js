// supabase-init.js

const SUPABASE_URL = 'https://ehupnvkselcupxqyofzy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cNXTZmBrYiYvd8SOI2ZGkQ_sWHLy_uf';

// IMPORTANT: use the global `supabase` from CDN, and store the client
window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: window.sessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

console.log('Tropang Tukmol: Supabase client initialized.');
