import { useEffect, useRef, useState } from 'react'
import { PainterEngine, type Tool, type ZoneStats } from './painter'
import { ZONES } from './zones'

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'brush', label: 'Brush', hint: 'B' },
  { id: 'fill', label: 'Fill Part', hint: 'F' },
  { id: 'erase', label: 'Erase', hint: 'E' },
]

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<PainterEngine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const [tool, setTool] = useState<Tool>('brush')
  const [zone, setZone] = useState(0)
  const [brush, setBrush] = useState(0.055)
  const [stats, setStats] = useState<ZoneStats>({ faceCounts: {}, paintedFaces: 0, totalFaces: 0 })
  const [undoDepth, setUndoDepth] = useState(0)
  const [source, setSource] = useState('default')
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    const engine = new PainterEngine()
    engineRef.current = engine
    engine.onStats = setStats
    engine.onUndoDepth = setUndoDepth
    engine.mount(viewportRef.current!)
    if (import.meta.env.DEV) (window as unknown as { __painter?: PainterEngine }).__painter = engine
    return () => engine.dispose()
  }, [])

  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.tool = tool
    e.zoneIndex = zone
    e.brushRadius = brush
  }, [tool, zone, brush])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') {
        ev.preventDefault()
        engineRef.current?.undo()
        return
      }
      const k = ev.key.toLowerCase()
      if (k === 'b') setTool('brush')
      if (k === 'f') setTool('fill')
      if (k === 'e') setTool('erase')
      if (k === '[') setBrush((b) => Math.max(0.015, +(b - 0.01).toFixed(3)))
      if (k === ']') setBrush((b) => Math.min(0.2, +(b + 0.01).toFixed(3)))
      const zi = ZONES.findIndex((z) => z.key === ev.key)
      if (zi >= 0) {
        setZone(zi)
        setTool((t) => (t === 'erase' ? 'brush' : t))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  const exportZones = () => {
    const data = engineRef.current!.exportJSON()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'mannequin_zones.json'
    a.click()
    URL.revokeObjectURL(a.href)
    flash(`Exported ${Object.keys(data.face_zones).length} painted faces across ${Object.keys(data.zones).length} zones`)
  }

  const importZones = async (file: File) => {
    try {
      engineRef.current!.importJSON(JSON.parse(await file.text()))
      flash(`Imported ${file.name}`)
    } catch (err) {
      flash(`Import failed: ${(err as Error).message}`)
    }
  }

  const loadGLB = async (file: File) => {
    try {
      await engineRef.current!.loadGLB(await file.arrayBuffer(), file.name)
      setSource(file.name)
      flash(`Loaded ${file.name} — zones reset`)
    } catch (err) {
      flash(`GLB load failed: ${(err as Error).message}`)
    }
  }

  const pct = stats.totalFaces ? ((stats.paintedFaces / stats.totalFaces) * 100).toFixed(1) : '0.0'

  return (
    <div className="shell">
      <aside className="panel">
        <header className="masthead">
          <div className="masthead-glyph" aria-hidden>
            ◉
          </div>
          <div>
            <h1>ZONE PAINTER</h1>
            <p className="sub">hug rating machine · setup console</p>
          </div>
        </header>

        <section className="block">
          <h2 className="block-title">Tool</h2>
          <div className="seg">
            {TOOLS.map((t) => (
              <button key={t.id} className={`seg-btn ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)}>
                {t.label}
                <kbd>{t.hint}</kbd>
              </button>
            ))}
          </div>
          <label className="slider-row">
            <span>Brush radius</span>
            <input
              type="range"
              min={0.015}
              max={0.2}
              step={0.005}
              value={brush}
              onChange={(e) => setBrush(+e.target.value)}
            />
            <code>{(brush * 100).toFixed(1)}cm</code>
          </label>
        </section>

        <section className="block grow">
          <h2 className="block-title">Zones</h2>
          <ul className="zone-list">
            {ZONES.map((z, i) => {
              const count = stats.faceCounts[z.id] ?? 0
              return (
                <li key={z.id}>
                  <button
                    className={`zone-btn ${zone === i && tool !== 'erase' ? 'active' : ''}`}
                    onClick={() => {
                      setZone(i)
                      if (tool === 'erase') setTool('brush')
                    }}
                  >
                    <span className="swatch" style={{ background: z.color, boxShadow: `0 0 10px ${z.color}66` }} />
                    <span className="zone-name">{z.label}</span>
                    <span className={`zone-count ${count ? 'has' : ''}`}>{count || '—'}</span>
                    <kbd>{z.key}</kbd>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="block">
          <div className="coverage">
            <div className="coverage-head">
              <span>Coverage</span>
              <code>
                {stats.paintedFaces.toLocaleString()} / {stats.totalFaces.toLocaleString()} · {pct}%
              </code>
            </div>
            <div className="coverage-bar">
              <div className="coverage-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="actions">
            <button className="btn primary" onClick={exportZones} disabled={!stats.paintedFaces}>
              Export mannequin_zones.json
            </button>
            <div className="btn-row">
              <button className="btn" onClick={() => importRef.current?.click()}>
                Import JSON
              </button>
              <button className="btn" onClick={() => engineRef.current?.undo()} disabled={!undoDepth}>
                Undo ⌘Z
              </button>
            </div>
            <div className="btn-row">
              <button className="btn" onClick={() => fileRef.current?.click()}>
                Load .glb scan
              </button>
              <button className="btn danger" onClick={() => engineRef.current?.clearPaint()} disabled={!stats.paintedFaces}>
                Clear paint
              </button>
            </div>
            {source !== 'default' && (
              <button
                className="btn"
                onClick={() => {
                  engineRef.current?.resetMannequin()
                  setSource('default')
                  flash('Restored default mannequin')
                }}
              >
                Restore default mannequin
              </button>
            )}
          </div>
          <p className="mesh-src">
            mesh · <code>{source}</code>
          </p>
        </section>

        <input
          ref={fileRef}
          type="file"
          accept=".glb"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) loadGLB(f)
            e.target.value = ''
          }}
        />
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) importZones(f)
            e.target.value = ''
          }}
        />
      </aside>

      <main className="viewport" ref={viewportRef}>
        <div className="viewport-hints">
          <span>
            <b>drag mesh</b> paint
          </span>
          <span>
            <b>drag space / right-drag</b> orbit
          </span>
          <span>
            <b>scroll</b> zoom
          </span>
          <span>
            <b>[ ]</b> brush size
          </span>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </main>
    </div>
  )
}
