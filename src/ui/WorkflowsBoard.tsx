import { useEffect, useState } from 'react'
import { loadWorkflows } from '../lib/workflows'
import { listMemories } from '../lib/memory'

export function WorkflowsBoard() {
  const [open, setOpen] = useState(false)
  const [workflows, setWorkflows] = useState<Record<string,string>>({})
  const [mem, setMem] = useState<Record<string,any>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'w' || e.key === 'W') && e.ctrlKey) {
        e.preventDefault()
        setOpen(o => !o)
        setWorkflows(loadWorkflows())
        setMem(listMemories('general'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  return (
    <div className="workflows-board">
      <div className="workflows-head">
        <span>SKILLS — Workflows & Memory (Ctrl+W)</span>
        <button onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="workflows-body">
        <div>
          <h4>Workflows ({Object.keys(workflows).length})</h4>
          {Object.keys(workflows).length === 0 ? <div className="dim">Keine — Stimme: "create workflow named inbox making check Gmail"</div> :
            Object.entries(workflows).map(([k,v]) => <div key={k} className="wf-row"><b>{k}</b>: {v}</div>)}
        </div>
        <div>
          <h4>Memory general ({Object.keys(mem).length})</h4>
          {Object.keys(mem).length === 0 ? <div className="dim">Leer — "merke dir mein Gmail ist ..."</div> :
            Object.entries(mem).slice(0,6).map(([k,v]:any) => <div key={k} className="wf-row"><b>{k}</b>: {String(v.value).slice(0,60)}</div>)}
        </div>
        <div className="wf-hint">Tip: Workflows + Memory sind auch via Sprache steuerbar. Business-Memory mit B-Mode getrennt.</div>
      </div>
    </div>
  )
}
