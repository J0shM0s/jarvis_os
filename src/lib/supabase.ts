import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || `https://${import.meta.env.VITE_SUPABASE_ID || 'tohyzgioxainsknknkqu'}.supabase.co`
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvaHl6Z2lveGFpbnNrbmtua3F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MzczMTQsImV4cCI6MjEwNTMxMzMxNH0.nHdd4OSpUJW9ZSiwXewml97gVC4asCBf05t_P9EGSoo'

if (!url || !anonKey) console.warn('[supabase] URL oder ANON_KEY fehlt')

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'sb-tohyzgioxainsknknkqu-auth-token',
  }
})

// Health check — wirft nie, gibt immer {ok:true/false}
export async function supabaseHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('_health_dummy').select('id').limit(1).maybeSingle()
    // PGRST116 = table not found ist ok — Verbindung steht
    if (error && !error.message.includes('does not exist') && error.code !== 'PGRST116' && error.code !== '42P01') {
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
