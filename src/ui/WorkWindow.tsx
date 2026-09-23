import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

function fmt(t: number) {
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function iconFor(type: string) {
  switch (type) {
    case 'thought': return '◐'
    case 'tool': return '⬢'
    case 'skill': return '✦'
    case 'delegate': return '↳'
    case 'team': return '⬣'
    case 'subagent': return '⬔'
    case 'status': return '●'
    default: return '·'
  }
}

export function WorkWindow() {
  const open = useStore(s => s.workOpen)
  const minimized = useStore(s => s.workMinimized)
  const task = useStore(s => s.workTask)
  const events = useStore(s => s.workEvents)
  const phase = useStore(s => s.phase)
  const cost = useStore(s => s.workCost)
  const duration = useStore(s => s.workDurationMs)
  const startedAt = useStore(s => s.workStartedAt)
  const setOpen = useStore(s => s.setWorkOpen)
  const setMin = useStore(s => s.setWorkMinimized)
  const clear = useStore(s => s.clearWorkEvents)
  const ref = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<'all'|'tools'|'agents'|'history'>('all')
  const [tree, setTree] = useState<{nodes:any[]}|null>(null)
  const [history, setHistory] = useState<any[]>([])
  const [expandedThoughts, setExpandedThoughts] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [events, tree])

  // Broadcast für detached Electron-Fenster
  useEffect(() => {
    const bc = new BroadcastChannel('jarvis-work')
    bc.postMessage({ type: 'workEvents', events })
    return () => bc.close()
  }, [events])

  // Live Task-Baum Polling via /ceo/tree (alle 2s wenn offen & arbeitet, sonst 5s)
  useEffect(() => {
    if (!open) return
    let alive = true
    let timer: number
    const poll = async () => {
      try {
        const r = await fetch('http://localhost:8787/ceo/tree')
        if (r.ok && alive) {
          const j = await r.json()
          if (j.nodes) setTree(j)
        }
        if (filter==='history' && alive) {
          const hr = await fetch('http://localhost:8787/ceo/history')
          if (hr.ok) setHistory(await hr.json())
        }
      } catch {}
      const isWorkingNow = useStore.getState().phase==='thinking' || useStore.getState().phase==='tooling'
      timer = window.setTimeout(poll, isWorkingNow ? 2000 : 5000) as unknown as number
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [open, filter])

  const toggleThought = (id:string) => {
    setExpandedThoughts(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const exportLog = () => {
    const payload = { task, phase, events, tree, at: new Date().toISOString() }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `jarvis-work-${Date.now()}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  if (!open) return null

  const visible = filter === 'all' ? events : filter === 'tools' ? events.filter(e => e.type==='tool'||e.type==='skill') : events.filter(e => e.type==='delegate'||e.type==='team'||e.type==='subagent')
  const isWorking = phase==='thinking'||phase==='tooling'

  return (
    <div className={`work-window ${minimized ? 'work-min' : ''}`}>
      <div className="work-head" onDoubleClick={() => setMin(!minimized)}>
        <div className="work-head-left">
          <span className={`work-dot ${isWorking ? 'work-dot-live' : ''}`} />
          <span className="work-title">JARVIS WORKSPACE</span>
          {task && <span className="work-task" title={task}>{task.slice(0, 60)}{task.length>60?'…':''}</span>}
        </div>
        <div className="work-head-actions">
          <span className="work-phase mono">{phase.toUpperCase()}</span>
          <span className="work-count mono">{events.length}{tree?.nodes?.length?` · ${tree.nodes.length} tasks`:''} {cost!=null?`· $${cost.toFixed(4)}`:''} {duration?`· ${(duration/1000).toFixed(1)}s`: startedAt ? `· ${((Date.now()-startedAt)/1000).toFixed(1)}s` : ''}</span>
          <button className="work-btn" onClick={() => {
            const d:any = (window as any).jarvisDesktop
            if (d?.openWorkWindow) d.openWorkWindow()
            else window.open(location.pathname + '?work=1', 'jarvis-work', 'width=900,height=700')
          }} title="Detach in eigenes Fenster">⧉</button>
          <button className="work-btn" onClick={exportLog} title="Export JSON">⤓</button>
          <button className="work-btn" onClick={() => setFilter(filter==='all'?'tools':filter==='tools'?'agents':filter==='history'?'all':'history')} title="Filter/History">{filter==='all'?'ALL':filter==='tools'?'TOOLS':filter==='agents'?'AGENTS':'HIST'}</button>
          <button className="work-btn" onClick={() => setMin(!minimized)} title={minimized?'Expand':'Minimize'}>{minimized?'□':'—'}</button>
          <button className="work-btn" onClick={clear} title="Clear">⌫</button>
          <button className="work-btn work-close" onClick={() => setOpen(false)} title="Close">×</button>
        </div>
      </div>

      {!minimized && (
        <>
          <div className="work-bar">
            <div className="work-bar-left">
              <span className="mono" style={{ opacity: 0.6, fontSize: 9 }}>CEO → SUB → SUB-SUB · Skills auto</span>
              {isWorking && <span className="work-live"><span className="spinner" style={{ width: 8, height: 8 }} /> arbeitet…</span>}
            </div>
            <div className="work-bar-right mono" style={{ fontSize: 8, opacity: 0.45 }}>CHAT zeigt nur Antwort · hier der Ablauf</div>
          </div>

          <div ref={ref} className="work-body">
            {filter==='history' ? (
              <div className="work-history">
                <div className="work-tree-title mono">HISTORY · letzte {history.length} Tasks (persistiert in ~/.jarvis/ceo/history)</div>
                {history.length===0 ? <div className="work-empty">Noch keine History — erster Task wird hier gespeichert.</div> : history.map((h:any)=>(
                  <div key={h.id} className="work-line work-status" style={{ cursor:'pointer' }} onClick={() => {
                    // Lade History-Detail als Events Replay (nur Anzeige)
                    if (h.task) alert(`Task: ${h.task}\nAnswer: ${(h.answer||'').slice(0,300)}\nCost: $${h.costUsd||'?'} · ${(h.durationMs? (h.durationMs/1000).toFixed(1)+'s' : '?')}`)
                  }}>
                    <span className="work-time mono">{h.at ? new Date(h.at).toLocaleTimeString() : ''}</span>
                    <span className="work-icon">◐</span>
                    <span className="work-agent mono">{h.costUsd?`$${Number(h.costUsd).toFixed(3)}`:'—'}</span>
                    <div className="work-content">
                      <div className="work-item-title">{h.task?.slice(0, 85)} <span style={{opacity:0.4, fontSize:9}}>· {h.durationMs? (h.durationMs/1000).toFixed(1)+'s':''} · {h.tools?.join(', ')?.slice(0,40)||''}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <>
            {/* CEO Task-Baum live */}
            {tree?.nodes?.length ? (
              <div className="work-tree">
                <div className="work-tree-title mono">TASK-BAUM · {tree.nodes.length} Delegationen {cost!=null?`· Kosten $${cost.toFixed(4)}`:''} {duration?`· Dauer ${(duration/1000).toFixed(1)}s`:''}</div>
                {tree.nodes.slice(-12).map((n:any) => (
                  <div key={n.id} className={`work-line work-${n.status==='done'?'status':n.status==='failed'?'tool':n.status==='delegated'?'delegate':'team'}`} style={{ paddingLeft: (n.parent==='CEO'?6:20) }}>
                    <span className="work-time mono">{n.at ? fmt(new Date(n.at).getTime()) : ''}</span>
                    <span className="work-icon">{n.status==='done'?'✓':n.status==='failed'?'✗':n.status==='retrying'?'↻':'↳'}</span>
                    <span className="work-agent mono">{(n.agent||'worker').slice(0,12)}</span>
                    <div className="work-content">
                      <div className="work-item-title">{n.task?.slice(0, 90)} {n.skill?`[${n.skill}]`:''} <span style={{opacity:0.45, fontSize:9}}>· {n.status}</span></div>
                      {n.result && <div className="work-item-detail" style={{color:'#3ef2a8'}}>{n.result.slice(0,180)}</div>}
                      {n.error && <div className="work-item-detail" style={{color:'#ff6b6b'}}>{n.error.slice(0,180)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {visible.length===0 && !tree?.nodes?.length && <div className="work-empty">Noch keine Events — warte auf Task…</div>}
            {visible.map(e => {
              const isLong = (e.detail && e.detail.length > 180) || e.title.length > 180
              const expanded = expandedThoughts.has(e.id)
              return (
                <div key={e.id} className={`work-line work-${e.type} ${e.type==='thought' && isLong ? 'work-clickable' : ''}`} style={{ paddingLeft: (e.level||0)*14 + 10 }} onClick={() => e.type==='thought' && isLong ? toggleThought(e.id) : undefined} title={isLong ? (expanded ? 'Zuklappen' : 'Aufklappen') : undefined}>
                  <span className="work-time mono">{fmt(e.at)}</span>
                  <span className="work-icon">{iconFor(e.type)}</span>
                  <span className="work-agent mono">{e.agent || (e.type==='delegate'?'SUB':e.type==='thought'?'CEO':'SYS')}</span>
                  <div className="work-content">
                    <div className="work-item-title">{expanded ? e.title : e.title.slice(0, 180)}{!expanded && e.title.length>180 ? '…' : ''} {isLong && e.type==='thought' && <span style={{opacity:0.45, fontSize:9}}>{expanded?' ▲': ' ▼'}</span>}</div>
                    {e.detail && <div className="work-item-detail">{expanded ? e.detail : e.detail.slice(0, 200)}{!expanded && e.detail.length>200 ? '…' : ''}</div>}
                  </div>
                </div>
              )
            })}
            {isWorking && <div className="work-line work-status"><span className="work-time mono">{fmt(Date.now())}</span><span className="work-icon">◐</span><span className="work-agent mono">CEO</span><div className="work-content"><div className="work-item-title" style={{ opacity: 0.7 }}>… arbeitet, verteilt an Sub-Agenten …</div></div></div>}
            </>
            )}
          </div>

          <div className="work-foot">
            <span className="mono" style={{ fontSize: 8, opacity: 0.5 }}>{visible.length}/{events.length} events · {filter.toUpperCase()} {(() => {
              const used = [...new Set(events.filter(e=>e.type==='skill'||e.type==='delegate').map(e=>e.detail?.match(/\[skill:([^\]]+)\]/)?.[1] || e.title.match(/skill[:\s]+([a-z0-9-_]+)/i)?.[1] || ((e.agent||'').includes('SKILL')?e.title:null)).filter(Boolean) as string[])].slice(0,4)
              return used.length ? `· Skills: ${used.join(', ')}` : ''
            })()}</span>
            <span className="mono" style={{ fontSize: 8, opacity: 0.5 }}>⧉ detach · Doppelklick = min · × = close</span>
          </div>
        </>
      )}
    </div>
  )
}
