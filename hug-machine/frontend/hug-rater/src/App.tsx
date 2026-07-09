import { useEffect, useRef, useState } from 'react'
import { HeatmapScene } from './heatmap'
import { useHugSocket, type Frame, type LeaderRow, type Mannequin, type Profile } from './useHugSocket'

const ZONE_LABELS: Record<string, string> = {
  chest: 'Chest',
  left_shoulder: 'L Shoulder',
  right_shoulder: 'R Shoulder',
  left_upper_arm: 'L Up Arm',
  right_upper_arm: 'R Up Arm',
  left_lower_arm: 'L Lo Arm',
  right_lower_arm: 'R Lo Arm',
  upper_back: 'Up Back',
  lower_back: 'Lo Back',
}

function fmtMs(ms: number) {
  return (ms / 1000).toFixed(1) + 's'
}

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HeatmapScene | null>(null)
  const {
    status, frame, score, leaderboard, preview, mannequin, detecting, error,
    startHug, endHug, clearScore, setMannequin,
  } = useHugSocket()
  const [name, setName] = useState('')
  // Manual marking: click the neck, then the torso base, in the camera panel.
  const [marking, setMarking] = useState<'neck' | 'base' | null>(null)
  const [neckPoint, setNeckPoint] = useState<[number, number] | null>(null)

  const onCamClick = (uv: [number, number]) => {
    if (marking === 'neck') {
      setNeckPoint(uv)
      setMarking('base')
    } else if (marking === 'base' && neckPoint) {
      setMannequin(neckPoint, uv)
      setMarking(null)
      setNeckPoint(null)
    }
  }

  useEffect(() => {
    const scene = new HeatmapScene()
    sceneRef.current = scene
    scene.mount(viewportRef.current!)
    return () => scene.dispose()
  }, [])

  useEffect(() => {
    if (frame) sceneRef.current?.setIntensities(frame.zones)
  }, [frame])

  const active = frame?.session.active ?? false
  const tracking = frame?.tracking ?? false
  const cls = frame?.classification

  return (
    <div className="shell">
      <aside className="panel">
        <header className="masthead">
          <div className="masthead-glyph" aria-hidden>
            ◉
          </div>
          <div>
            <h1>HUG RATING MACHINE</h1>
            <p className="sub">operator console · do not show the hugger</p>
          </div>
        </header>

        <section className="block">
          <h2 className="block-title">Session</h2>
          {!active ? (
            <div className="session-idle">
              <input
                className="name-input"
                placeholder="Hugger name…"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') startHug(name.trim() || 'Anonymous')
                }}
              />
              <button
                className="btn primary big"
                disabled={status !== 'open'}
                onClick={() => startHug(name.trim() || 'Anonymous')}
              >
                ● START HUG
              </button>
            </div>
          ) : (
            <div className="session-live">
              <div className="session-meta">
                <span className="live-dot" /> <b>{frame?.session.name}</b>
                <code>{fmtMs(frame?.session.elapsed_ms ?? 0)}</code>
              </div>
              <button className="btn danger big" onClick={endHug}>
                ■ END HUG &amp; SCORE
              </button>
            </div>
          )}
        </section>

        <section className="block">
          <h2 className="block-title">Live Signals</h2>
          <Meter label="Squeeze" value={frame?.squeeze ?? 0} />
          <Meter label="Wrap reach" value={frame?.wrap_reach ?? 0} />
          <Meter label="Closing vel." value={frame?.closing_velocity ?? 0} />
          <div className="elbows">
            <span>
              elbows <code>{frame?.elbow_angle_deg.left?.toFixed(0) ?? '—'}°</code> L ·{' '}
              <code>{frame?.elbow_angle_deg.right?.toFixed(0) ?? '—'}°</code> R · depth{' '}
              <code
                title="hugger size vs mannequin size — ~1.0 means standing at the mannequin"
                className={
                  frame?.depth_ratio != null && (frame.depth_ratio < 0.75 || frame.depth_ratio > 1.4)
                    ? 'depth-off'
                    : undefined
                }
              >
                {frame?.depth_ratio != null ? `×${frame.depth_ratio.toFixed(2)}` : '—'}
              </code>
            </span>
          </div>
          <div className={`class-chips ${cls ? '' : 'dim'}`}>
            <span className="chip">{cls?.style ?? 'style'}</span>
            <span className="chip">{cls?.coordination ?? 'coordination'}</span>
            <span className="chip">{cls?.tightness ?? 'tightness'}</span>
          </div>
        </section>

        <section className="block">
          <h2 className="block-title">Zone Contact</h2>
          <div className="zone-grid">
            {Object.entries(ZONE_LABELS).map(([id, label]) => {
              const v = frame?.zones[id] ?? 0
              return (
                <div key={id} className="zone-cell">
                  <span className="zone-cell-label">{label}</span>
                  <div className="zone-cell-bar">
                    <div className="zone-cell-fill" style={{ width: `${Math.round(v * 100)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="block">
          <h2 className="block-title">Mannequin</h2>
          <div className="detect">
            <p className={`detect-status ${mannequin?.detected ? 'ok' : 'warn'}`}>
              {marking
                ? `click the ${marking === 'neck' ? 'NECK' : 'BASE of the torso'} in the camera panel →`
                : detecting
                  ? 'scanning for mannequin…'
                  : mannequin?.detected
                    ? `locked · ${Object.keys(mannequin.anchors).length} zone anchors`
                    : 'not set — mark it in the camera panel'}
            </p>
            <button
              className={`btn ${marking ? 'danger' : ''}`}
              disabled={status !== 'open' || !preview || detecting}
              onClick={() => {
                if (marking) {
                  setMarking(null)
                  setNeckPoint(null)
                } else {
                  setMarking('neck')
                }
              }}
            >
              {marking ? 'CANCEL MARKING' : mannequin?.detected ? 'RE-MARK MANNEQUIN' : 'MARK MANNEQUIN'}
            </button>
            {error && <p className="detect-error">{error}</p>}
          </div>
        </section>

        <section className="block grow">
          <h2 className="block-title">Leaderboard</h2>
          <Leaderboard rows={leaderboard} />
        </section>
      </aside>

      <main className="viewport" ref={viewportRef}>
        <div className={`status-pill ${status} ${tracking ? 'tracking' : ''}`}>
          {status !== 'open' ? (
            <>backend offline — start backend/main.py</>
          ) : tracking ? (
            <>tracking · {frame?.fps.toFixed(0)} fps</>
          ) : (
            <>no hugger in frame</>
          )}
        </div>
        {preview && (
          <CameraPreview
            preview={preview}
            frame={frame}
            mannequin={mannequin}
            marking={marking}
            neckPoint={neckPoint}
            onClickUV={onCamClick}
          />
        )}
        {score && <ScoreReveal profile={score.profile} rank={score.rank} onDone={clearScore} />}
      </main>
    </div>
  )
}

const SKELETON_BONES: Array<[string, string]> = [
  ['l_shoulder', 'r_shoulder'],
  ['l_shoulder', 'l_elbow'],
  ['l_elbow', 'l_wrist'],
  ['r_shoulder', 'r_elbow'],
  ['r_elbow', 'r_wrist'],
]

/** Webcam view with the hugger's detected skeleton and the mannequin's
 * detected zone anchors — the operator's aiming aid. */
function CameraPreview({
  preview,
  frame,
  mannequin,
  marking,
  neckPoint,
  onClickUV,
}: {
  preview: string
  frame: Frame | null
  mannequin: Mannequin | null
  marking: 'neck' | 'base' | null
  neckPoint: [number, number] | null
  onClickUV: (uv: [number, number]) => void
}) {
  const pose = frame?.tracking ? frame.pose : null
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={`cam ${marking ? 'marking' : ''} ${expanded ? 'expanded' : ''}`}
      onClick={(e) => {
        if (!marking) {
          setExpanded((x) => !x)
          return
        }
        const rect = e.currentTarget.getBoundingClientRect()
        onClickUV([(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height])
      }}
    >
      <img src={`data:image/jpeg;base64,${preview}`} alt="webcam" />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none">
        {mannequin?.detected &&
          Object.entries(mannequin.anchors).map(([zone, [u, v]]) => (
            <circle key={zone} cx={u} cy={v} r={0.012} className="cam-anchor" />
          ))}
        {pose &&
          SKELETON_BONES.map(([a, b]) =>
            pose[a] && pose[b] ? (
              <line
                key={`${a}-${b}`}
                x1={pose[a][0]}
                y1={pose[a][1]}
                x2={pose[b][0]}
                y2={pose[b][1]}
                className="cam-bone"
              />
            ) : null,
          )}
        {pose &&
          Object.entries(pose).map(([joint, [u, v]]) => (
            <circle key={joint} cx={u} cy={v} r={0.014} className="cam-joint" />
          ))}
        {neckPoint && <circle cx={neckPoint[0]} cy={neckPoint[1]} r={0.018} className="cam-mark" />}
        {frame?.sticker && (
          <circle cx={frame.sticker[0]} cy={frame.sticker[1]} r={0.016} className="cam-sticker" />
        )}
      </svg>
      <span className="cam-label">
        {marking
          ? `click the ${marking === 'neck' ? 'neck' : 'torso base'}`
          : `${pose ? 'camera · tracking' : 'camera · no pose'} · click to ${expanded ? 'shrink' : 'expand'}`}
      </span>
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <code>{value.toFixed(2)}</code>
      </div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  )
}

function Leaderboard({ rows }: { rows: LeaderRow[] }) {
  if (!rows.length) return <p className="empty">No hugs yet. Be the first.</p>
  return (
    <ol className="board">
      {rows.slice(0, 12).map((r) => (
        <li key={r.rank} className={`board-row ${r.rank === 1 ? 'gold' : ''}`}>
          <span className="board-rank">{r.rank}</span>
          <span className="board-name">
            {r.name}
            <em>{r.hug_type}</em>
          </span>
          <span className="board-score">{r.overall.toFixed(1)}</span>
        </li>
      ))}
    </ol>
  )
}

const DIMENSIONS: Array<{ key: keyof Profile['scoring'] & string; label: string }> = [
  { key: 'strength', label: 'Strength' },
  { key: 'style', label: 'Style' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'warmth', label: 'Warmth' },
]

function ScoreReveal({ profile, rank, onDone }: { profile: Profile; rank: number; onDone: () => void }) {
  const s = profile.scoring
  const [shown, setShown] = useState(0) // animated overall counter
  const [filled, setFilled] = useState(false) // bars transition from 0 after mount

  useEffect(() => {
    const t = window.setTimeout(() => setFilled(true), 60)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const DURATION = 2200
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / DURATION)
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(s.overall * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [s.overall])

  return (
    <div className="reveal">
      <div className="reveal-card">
        <p className="reveal-kicker">HUG ANALYSIS COMPLETE</p>
        <h2 className="reveal-name">{profile.metadata.hugger_name}</h2>
        <div className="reveal-overall">
          <span className="reveal-number">{shown.toFixed(1)}</span>
          <span className="reveal-outof">/ 10</span>
        </div>
        <p className="reveal-rank">
          RANK <b>#{rank}</b> · {fmtMs(profile.metadata.duration_ms)} · <code>{s.hug_type}</code>
        </p>
        <div className="reveal-dims">
          {DIMENSIONS.map((d, i) => (
            <div className="reveal-dim" key={d.key} style={{ animationDelay: `${0.4 + i * 0.25}s` }}>
              <span className="reveal-dim-label">{d.label}</span>
              <div className="reveal-dim-bar">
                <div
                  className="reveal-dim-fill"
                  style={{ width: filled ? `${(s[d.key] as number) * 10}%` : 0, transitionDelay: `${0.5 + i * 0.25}s` }}
                />
              </div>
              <code>{(s[d.key] as number).toFixed(1)}</code>
            </div>
          ))}
        </div>
        <button className="btn primary big" onClick={onDone}>
          NEXT HUGGER
        </button>
      </div>
    </div>
  )
}
