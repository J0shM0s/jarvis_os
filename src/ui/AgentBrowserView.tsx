import { useEffect } from 'react'
import { useStore } from '../store'

export function AgentBrowserView() {
  const img = useStore(s => s.agentBrowserImage)
  const active = useStore(s => s.agentBrowserActive)

  // Auto-activate when image arrives
  useEffect(() => {
    if (img && !active) useStore.getState().setAgentBrowserActive(true)
  }, [img, active])

  if (!active && !img) return null

  return (
    <div className="agent-browser-wrap">
      <div className="agent-browser-head">
        <span className="agent-browser-title">JARVIS BROWSER — Live</span>
        <span className="agent-browser-badge">{img ? 'LIVE' : 'IDLE'}</span>
        <button className="agent-browser-close" onClick={() => {
          useStore.getState().setAgentBrowserActive(false)
          useStore.getState().setAgentBrowserImage(null)
        }}>×</button>
      </div>
      <div className="agent-browser-body">
        {img ? (
          <img className="agent-browser-img" src={img} alt="agent browser live" />
        ) : (
          <div className="agent-browser-empty">Kein Bild — sage "gehe auf neal.fun in deinem Browser" und sieh live wie er spielt.</div>
        )}
      </div>
      <div className="agent-browser-foot">
        <span>Dein eigener Browser (Playwright) — bleibt eingeloggt, sichtbar auch als echtes Fenster. Captchas löst er visuell.</span>
      </div>
    </div>
  )
}
