import { useEffect, useRef } from 'react'
import { useStore } from '../store'

export function OsLog() {
  const logs = useStore(s => s.osLogs)
  const clear = useStore(s => s.clearOsLogs)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs])

  if (!logs.length) return null

  return (
    <div className="os-log">
      <div className="os-log-head">
        <span className="os-log-title">JARVIS OS LOG</span>
        <span className="os-log-count">{logs.length}</span>
        <button className="os-log-clear" onClick={clear} title="Clear">×</button>
      </div>
      <div ref={ref} className="os-log-body">
        {logs.slice(-20).map(l => (
          <div key={l.id} className="os-log-line">
            <span className="os-log-time">{new Date(l.at).toLocaleTimeString()}</span>
            <span className="os-log-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
