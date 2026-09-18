import { useEffect } from 'react'
import { useStore } from '../store'

export function SandboxView() {
  const img = useStore(s => s.sandboxImage)
  const active = useStore(s => s.sandboxActive)
  const logs = useStore(s => s.osLogs)

  useEffect(() => {
    if (!active) return
    // Auto-scroll handled by OsLog
  }, [active])

  if (!active && !img) return null

  return (
    <div className="sandbox-wrap">
      <div className="sandbox-head">
        <span className="sandbox-title">JARVIS SANDBOX — Live Desktop</span>
        <span className="sandbox-badge">{active ? 'LIVE' : 'IDLE'}</span>
        <button className="sandbox-close" onClick={() => useStore.getState().setSandboxActive(false)}>×</button>
      </div>
      <div className="sandbox-body">
        {img ? (
          <img className="sandbox-img" src={img} alt="sandbox desktop" />
        ) : (
          <div className="sandbox-empty">Kein Bild — capture_screen wird beim nächsten OS-Befehl live.</div>
        )}
        <div className="sandbox-log-mini">
          {logs.slice(-3).map(l => (
            <div key={l.id} className="sandbox-log-line">{l.text}</div>
          ))}
        </div>
      </div>
      <div className="sandbox-foot">
        <span>Dein echter Desktop bleibt frei — JARVIS arbeitet im Sandbox-Fenster (virtuell). Drücke O zum Löschen, erneut Sandbox öffnen via Sprache: "öffne Sandbox".</span>
      </div>
    </div>
  )
}
