import { useEffect, useState, useMemo } from 'react'
import { useStore } from '../store'

type Cmd = { id: string; label: string; desc: string; action: () => void; keys?: string }

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const workOpen = useStore(s => s.workOpen)
  const setWorkOpen = useStore(s => s.setWorkOpen)
  const setComposerOpen = useStore(s => s.setComposerOpen)
  const clearWork = useStore(s => s.clearWorkEvents)
  const clearOs = useStore(s => s.clearOsLogs)
  const businessMode = useStore(s => s.businessMode)
  const setBusinessMode = useStore(s => s.setBusinessMode)
  const workTask = useStore(s => s.workTask)
  const workCost = useStore(s => s.workCost)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const cmds: Cmd[] = useMemo(() => [
    { id: 'work', label: workOpen ? 'Work schließen' : 'Work öffnen', desc: `Workspace ${workTask ? '· ' + workTask.slice(0,30) : ''}`, action: () => { setWorkOpen(!workOpen); setOpen(false) }, keys: 'W' },
    { id: 'composer', label: 'Eingabe öffnen', desc: 'T / Enter', action: () => { setComposerOpen(true); setOpen(false) }, keys: 'T' },
    { id: 'business', label: businessMode ? 'Business → Privat' : 'Privat → Business', desc: `Modus wechseln`, action: () => { setBusinessMode(!businessMode); setOpen(false) }, keys: 'B' },
    { id: 'clearWork', label: 'Work leeren', desc: 'Events + Task-Baum leeren', action: () => { clearWork(); setOpen(false) } },
    { id: 'clearOs', label: 'OS Log leeren', desc: 'Maus/Tastatur Log', action: () => { clearOs(); setOpen(false) }, keys: 'O' },
    { id: 'detach', label: 'Work detached öffnen', desc: 'Separates Electron-Fenster', action: () => { const d:any=(window as any).jarvisDesktop; if(d?.openWorkWindow) d.openWorkWindow(); else window.open(location.pathname+'?work=1','jarvis-work','width=900,height=700'); setOpen(false) } },
    { id: 'cost', label: workCost!=null ? `Kosten $${workCost.toFixed(4)}` : 'Kosten anzeigen', desc: 'Letzter Task', action: () => setOpen(false) },
    { id: 'history', label: 'History anzeigen', desc: 'Work → HIST Filter', action: () => { setWorkOpen(true); setOpen(false) } },
  ], [workOpen, workTask, businessMode, workCost, setWorkOpen, setComposerOpen, setBusinessMode, clearWork, clearOs])

  const filtered = useMemo(() => {
    if (!q.trim()) return cmds
    const qq = q.toLowerCase()
    return cmds.filter(c => c.label.toLowerCase().includes(qq) || c.desc.toLowerCase().includes(qq)).slice(0, 8)
  }, [q, cmds])

  if (!open) return null
  return (
    <div className="cmd-palette-backdrop" onClick={() => setOpen(false)}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <div className="cmd-head">
          <span className="mono" style={{ fontSize: 9, letterSpacing: '0.16em', opacity: 0.6 }}>COMMAND</span>
          <input autoFocus placeholder="Tippe…  (Skills, Work, Business, History)" value={q} onChange={e => setQ(e.target.value)} className="cmd-input" />
          <span className="mono" style={{ fontSize: 8, opacity: 0.4 }}>ESC</span>
        </div>
        <div className="cmd-list">
          {filtered.map(c => (
            <button key={c.id} className="cmd-item" onClick={c.action}>
              <span className="cmd-label">{c.label}</span>
              <span className="cmd-desc">{c.desc}</span>
              {c.keys && <span className="cmd-keys mono">{c.keys}</span>}
            </button>
          ))}
          {filtered.length===0 && <div className="cmd-empty">Keine Treffer für "{q}"</div>}
        </div>
        <div className="cmd-foot mono" style={{ fontSize: 8, opacity: 0.4, padding: '6px 12px', borderTop: '1px solid #00e5ff14' }}>Ctrl+K toggle · ↑↓ navigieren · Enter ausführen</div>
      </div>
    </div>
  )
}
