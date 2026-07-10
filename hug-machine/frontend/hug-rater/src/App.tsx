import { useEffect, useRef, useState } from 'react'
import { HeatmapScene } from './heatmap'
import { useHugSocket, type Frame, type LeaderRow, type Mannequin, type Profile } from './useHugSocket'
import { uploadHug, type HugFrame } from './supabase'

const COUNTDOWN_S = 3
const RECORD_S = 10

type Phase = 'idle' | 'countdown' | 'recording' | 'score'

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HeatmapScene | null>(null)
  const {
    status, frame, score, leaderboard, preview, mannequin, detecting, error,
    startHug, endHug, clearScore, setMannequin,
  } = useHugSocket()

  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(COUNTDOWN_S)
  const [progress, setProgress] = useState(0)
  const [name, setName] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const framesRef = useRef<HugFrame[]>([])
  const t0Ref = useRef<number | null>(null)
  const timersRef = useRef<number[]>([])

  // Manual marking: click the neck, then the torso base, in the camera panel.
  const [marking, setMarking] = useState<'neck' | 'base' | null>(null)
  const [neckPoint, setNeckPoint] = useState<[number, number] | null>(null)

  useEffect(() => {
    const scene = new HeatmapScene()
    sceneRef.current = scene
    scene.mount(viewportRef.current!)
    return () => scene.dispose()
  }, [])

  // The heatmap only paints while a hug is being recorded (or on the score
  // screen behind the reveal) — idle bystanders shouldn't light it up.
  useEffect(() => {
    if (!frame) return
    const live = phase === 'recording' || phase === 'score'
    sceneRef.current?.setIntensities(live ? frame.zones : {})
  }, [frame, phase])

  // Capture the parameter stream while recording — this is the payload the
  // space station replays on the robot.
  useEffect(() => {
    if (phase !== 'recording' || !frame) return
    if (t0Ref.current === null) t0Ref.current = frame.t_ms
    framesRef.current.push({
      t: frame.t_ms - t0Ref.current,
      s: frame.squeeze,
      r: frame.wrap_reach,
      c: frame.closing_velocity,
    })
  }, [frame, phase])

  // Backend scores the session after end_hug; that flips us to the score phase.
  useEffect(() => {
    if (score && phase === 'recording') setPhase('score')
  }, [score, phase])

  // Backend dropping mid-flow: bail back to idle.
  useEffect(() => {
    if (status !== 'open' && phase !== 'idle') resetToIdle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3200)
  }

  const clearTimers = () => {
    for (const t of timersRef.current) window.clearInterval(t)
    timersRef.current = []
  }

  const resetToIdle = () => {
    clearTimers()
    clearScore()
    setPhase('idle')
    setProgress(0)
  }

  const begin = () => {
    if (status !== 'open' || phase !== 'idle') return
    clearScore() // a stale score from the previous session must not end this one
    framesRef.current = []
    t0Ref.current = null
    setCount(COUNTDOWN_S)
    setPhase('countdown')
    let c = COUNTDOWN_S
    const iv = window.setInterval(() => {
      c -= 1
      if (c > 0) {
        setCount(c)
        return
      }
      window.clearInterval(iv)
      startHug(name.trim() || 'Anonymous')
      setPhase('recording')
      setProgress(0)
      const started = performance.now()
      const pv = window.setInterval(() => {
        const p = (performance.now() - started) / (RECORD_S * 1000)
        setProgress(Math.min(1, p))
        if (p >= 1) {
          window.clearInterval(pv)
          endHug()
        }
      }, 100)
      timersRef.current.push(pv)
    }, 1000)
    timersRef.current.push(iv)
  }

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

  const cls = frame?.classification
  const tracking = frame?.tracking ?? false
  const showLive = phase === 'recording' || phase === 'score'
  const remaining = Math.max(0, Math.ceil(RECORD_S * (1 - progress)))

  return (
    <div className="kiosk">
      <header className="kh">
        <span className="kh-glyph" aria-hidden>◉</span>
        <h1>PROXIMA</h1>
        <span className={`kh-status ${status} ${tracking ? 'tracking' : ''}`}>
          {status !== 'open' ? 'OFFLINE' : tracking ? 'TRACKING' : 'NO HUGGER'}
        </span>
      </header>

      {showLive && (
        <div className="meters-row">
          <BigMeter label="Squeeze" value={frame?.squeeze ?? 0} />
          <BigMeter label="Wrap Reach" value={frame?.wrap_reach ?? 0} />
          <BigMeter label="Closing Velocity" value={frame?.closing_velocity ?? 0} />
        </div>
      )}

      {phase === 'recording' && (
        <div className="rec-bar">
          <span className="rec-dot" /> RECORDING
          <div className="rec-progress">
            <div className="rec-progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <code>{remaining}s</code>
        </div>
      )}

      <main className="viewport" ref={viewportRef}>
        {phase === 'countdown' && (
          <div className="countdown" key={count}>
            {count}
          </div>
        )}

        {phase === 'idle' && (
          <div className="start-stack">
            <input
              className="name-input"
              placeholder="Hugger name…"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn primary start-btn" disabled={status !== 'open'} onClick={begin}>
              ● START HUG
            </button>
          </div>
        )}

        {phase === 'score' && score && (
          <ScoreReveal
            profile={score.profile}
            rank={score.rank}
            frames={framesRef.current}
            onDone={resetToIdle}
            onFlash={flash}
          />
        )}
      </main>

      {showLive && (
        <div className={`class-chips ${cls ? '' : 'dim'}`}>
          <span className="chip">{cls?.style ?? 'style'}</span>
          <span className="chip">{cls?.coordination ?? 'coordination'}</span>
          <span className="chip">{cls?.tightness ?? 'tightness'}</span>
        </div>
      )}

      <footer className="bottom-row">
        <div className="cam-cell">
          {preview ? (
            <CameraPreview
              preview={preview}
              frame={frame}
              mannequin={mannequin}
              marking={marking}
              neckPoint={neckPoint}
              onClickUV={onCamClick}
            />
          ) : (
            <div className="cam-placeholder">camera offline</div>
          )}
          <div className="mann-tools">
            <span className={`detect-status ${mannequin?.detected ? 'ok' : 'warn'}`}>
              {marking
                ? `click the ${marking === 'neck' ? 'NECK' : 'BASE'} in the camera view`
                : detecting
                  ? 'scanning…'
                  : mannequin?.detected
                    ? 'mannequin locked'
                    : 'mannequin not set'}
            </span>
            <button
              className="btn tiny"
              disabled={status !== 'open' || !preview || phase !== 'idle'}
              onClick={() => {
                if (marking) {
                  setMarking(null)
                  setNeckPoint(null)
                } else {
                  setMarking('neck')
                }
              }}
            >
              {marking ? 'cancel' : mannequin?.detected ? 're-mark' : 'mark'}
            </button>
            {error && <span className="detect-error">{error}</span>}
          </div>
        </div>
        <div className="board-cell">
          <h2 className="board-title">Leaderboard</h2>
          <Leaderboard rows={leaderboard} />
        </div>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function BigMeter({ label, value }: { label: string; value: number }) {
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
      {rows.slice(0, 6).map((r) => (
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

/** Webcam view with the hugger's detected skeleton and the mannequin's
 * zone anchors — doubles as the mark-mannequin surface. */
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
        {marking ? `click the ${marking === 'neck' ? 'neck' : 'torso base'}` : 'camera'}
      </span>
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

const DIMENSIONS: Array<{ key: keyof Profile['scoring'] & string; label: string }> = [
  { key: 'strength', label: 'Strength' },
  { key: 'style', label: 'Style' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'warmth', label: 'Warmth' },
]

function ScoreReveal({
  profile,
  rank,
  frames,
  onDone,
  onFlash,
}: {
  profile: Profile
  rank: number
  frames: HugFrame[]
  onDone: () => void
  onFlash: (msg: string) => void
}) {
  const s = profile.scoring
  const [shown, setShown] = useState(0)
  const [filled, setFilled] = useState(false)
  const [uploadState, setUploadState] = useState<'ready' | 'uploading' | 'sent'>('ready')

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

  const upload = async () => {
    if (uploadState !== 'ready') return
    setUploadState('uploading')
    try {
      await uploadHug({
        hugger_name: profile.metadata.hugger_name,
        overall: s.overall,
        strength: s.strength,
        style: s.style,
        coverage: s.coverage,
        warmth: s.warmth,
        hug_type: s.hug_type,
        duration_ms: profile.metadata.duration_ms,
        frames,
      })
      setUploadState('sent')
      onFlash('Hug sent to the space station ♥')
      window.setTimeout(onDone, 1800)
    } catch (err) {
      setUploadState('ready')
      onFlash(`Upload failed: ${(err as Error).message}`)
    }
  }

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
          RANK <b>#{rank}</b> · <code>{s.hug_type}</code>
        </p>
        <div className="reveal-dims">
          {DIMENSIONS.map((d, i) => (
            <div className="reveal-dim" key={d.key} style={{ animationDelay: `${0.4 + i * 0.25}s` }}>
              <span className="reveal-dim-label">{d.label}</span>
              <div className="reveal-dim-bar">
                <div
                  className="reveal-dim-fill"
                  style={{
                    width: filled ? `${(s[d.key] as number) * 10}%` : 0,
                    transitionDelay: `${0.5 + i * 0.25}s`,
                  }}
                />
              </div>
              <code>{(s[d.key] as number).toFixed(1)}</code>
            </div>
          ))}
        </div>
        <div className="reveal-actions">
          <button className="btn primary big" onClick={upload} disabled={uploadState !== 'ready'}>
            {uploadState === 'uploading' ? 'UPLOADING…' : uploadState === 'sent' ? 'SENT ✓' : '⇪ UPLOAD HUG'}
          </button>
          <button className="btn big" onClick={onDone}>
            NEXT HUGGER
          </button>
        </div>
      </div>
    </div>
  )
}
