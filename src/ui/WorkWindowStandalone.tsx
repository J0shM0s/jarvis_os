import { useEffect, useState } from 'react'

export function WorkWindowStandalone() {
  const [tree, setTree] = useState<any>(null)
  const [events, setEvents] = useState<any[]>([])

  useEffect(() => {
    let alive = true
    const bc = new BroadcastChannel('jarvis-work')
    bc.onmessage = (e) => {
      if (e.data?.type === 'workEvents' && alive) setEvents(e.data.events.slice(-80))
    }
    const poll = async () => {
      try {
        const r = await fetch('http://localhost:8787/ceo/tree')
        if (r.ok && alive) setTree(await r.json())
      } catch {}
      if (alive) setTimeout(poll, 2000)
    }
    poll()
    return () => { alive = false; bc.close() }
  }, [])

  return (
    <div style={{ background: '#01060c', color: '#00e5ff', minHeight: '100vh', padding: 16, fontFamily: 'JetBrains Mono, monospace' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, borderBottom: '1px solid #00e5ff33', paddingBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3ef2a8', boxShadow: '0 0 10px #3ef2a8' }} />
        <span style={{ letterSpacing: '0.2em', fontWeight: 600 }}>JARVIS WORKSPACE — DETACHED</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5 }}>{tree?.nodes?.length || 0} tasks · {events.length} events</span>
      </div>
      {tree?.nodes?.length ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.16em', marginBottom: 6 }}>TASK-BAUM LIVE</div>
          {tree.nodes.slice(-20).map((n:any) => (
            <div key={n.id} style={{ display: 'flex', gap: 8, padding: '4px 8px', borderLeft: `2px solid ${n.status==='done'?'#3ef2a8':n.status==='failed'?'#ff6b6b':'#00e5ff33'}`, marginBottom: 2, background: 'rgba(0,229,255,0.04)', fontSize: 11 }}>
              <span style={{ opacity: 0.5 }}>{n.status}</span>
              <span style={{ opacity: 0.7 }}>{n.agent}</span>
              <span style={{ flex: 1 }}>{n.task?.slice(0, 90)}</span>
              {n.skill && <span style={{ opacity: 0.6, fontSize: 9 }}>[{n.skill}]</span>}
            </div>
          ))}
        </div>
      ) : <div style={{ opacity: 0.5, fontSize: 11, padding: 12 }}>Warte auf Task-Baum… Hauptfenster muss laufen.</div>}
      <div style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.16em', marginBottom: 6, borderTop: '1px solid #00e5ff14', paddingTop: 10 }}>LIVE EVENTS (aus Hauptfenster)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '50vh', overflowY: 'auto' }}>
        {events.length===0 ? <div style={{ opacity: 0.4, fontSize: 11, padding: 8 }}>Keine Events — Hauptfenster sendet via BroadcastChannel sobald Task läuft.</div> : events.map((e:any)=>(
          <div key={e.id} style={{ display: 'flex', gap: 8, padding: '4px 8px', fontSize: 11, borderLeft: '2px solid #00e5ff22' }}>
            <span style={{ opacity: 0.4 }}>{new Date(e.at).toLocaleTimeString()}</span>
            <span style={{ minWidth: 80, opacity: 0.7 }}>{e.agent}</span>
            <span>{e.title.slice(0, 100)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
