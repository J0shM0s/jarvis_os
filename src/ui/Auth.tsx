import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState<any>(null)
  const [mode, setMode] = useState<'signin'|'signup'>('signin')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (user) {
    return (
      <div className="auth-bar">
        <span className="auth-user">✓ {user.email}</span>
        <button className="auth-btn" onClick={async () => { await supabase.auth.signOut(); setMsg('Abgemeldet') }}>Logout</button>
      </div>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg('')
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setMsg('Registriert — prüfe Mails falls Bestätigung nötig, sonst direkt anmelden')
        setMode('signin')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        setMsg('Angemeldet')
      }
    } catch (err: any) {
      setMsg(err.message || String(err))
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div className="auth-tabs">
        <button type="button" className={mode==='signin'?'active':''} onClick={() => setMode('signin')}>Anmelden</button>
        <button type="button" className={mode==='signup'?'active':''} onClick={() => setMode('signup')}>Registrieren</button>
      </div>
      <input className="auth-input" placeholder="E-Mail" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
      <input className="auth-input" placeholder="Passwort" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
      <button className="auth-submit" type="submit">{mode==='signin'?'Anmelden':'Registrieren'}</button>
      {msg && <div className="auth-msg">{msg}</div>}
      <div className="auth-hint">Session wird gespeichert — bleibst angemeldet nach Reload.</div>
    </form>
  )
}
