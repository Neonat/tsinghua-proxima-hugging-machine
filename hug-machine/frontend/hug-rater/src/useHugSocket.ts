import { useCallback, useEffect, useRef, useState } from 'react'

export interface Frame {
  t_ms: number
  tracking: boolean
  fps: number
  squeeze: number
  closing_velocity: number
  elbow_angle_deg: { left?: number; right?: number }
  zones: Record<string, number>
  classification: { style: string; coordination: string; tightness: string; label: string } | null
  pose: Record<string, [number, number]>
  sticker: [number, number] | null
  depth_ratio: number | null
  wrap_reach: number
  session: { active: boolean; name: string | null; elapsed_ms: number }
}

export interface Profile {
  metadata: { hugger_name: string; timestamp: string; duration_ms: number }
  scoring: {
    strength: number
    style: number
    coverage: number
    warmth: number
    overall: number
    hug_type: string
  }
  zone_peaks: Record<string, number>
}

export interface LeaderRow {
  rank: number
  name: string
  overall: number
  strength: number
  style: number
  coverage: number
  warmth: number
  hug_type: string
  timestamp: string
}

export type Status = 'connecting' | 'open' | 'closed'

export interface Mannequin {
  detected: boolean
  anchors: Record<string, [number, number]>
}

const WS_URL = 'ws://localhost:8765'

export function useHugSocket() {
  const [status, setStatus] = useState<Status>('connecting')
  const [frame, setFrame] = useState<Frame | null>(null)
  const [score, setScore] = useState<{ profile: Profile; rank: number } | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([])
  const [preview, setPreview] = useState<string | null>(null) // base64 jpeg
  const [mannequin, setMannequin] = useState<Mannequin | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let dead = false
    let retry: number | undefined

    const connect = () => {
      if (dead) return
      setStatus('connecting')
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => setStatus('open')
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'frame') setFrame(msg)
        else if (msg.type === 'score') setScore({ profile: msg.profile, rank: msg.rank })
        else if (msg.type === 'leaderboard') setLeaderboard(msg.rows)
        else if (msg.type === 'preview') setPreview(msg.jpeg_b64)
        else if (msg.type === 'hello') setMannequin(msg.mannequin)
        else if (msg.type === 'detecting') {
          setDetecting(true)
          setError(null)
        } else if (msg.type === 'mannequin') {
          setMannequin({ detected: true, anchors: msg.anchors })
          setDetecting(false)
        } else if (msg.type === 'error') {
          setError(msg.message)
          setDetecting(false)
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        setFrame(null)
        setPreview(null)
        retry = window.setTimeout(connect, 1500)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      dead = true
      window.clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  const send = useCallback((payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload))
  }, [])

  return {
    status,
    frame,
    score,
    leaderboard,
    preview,
    mannequin,
    detecting,
    error,
    startHug: (name: string) => send({ type: 'start_hug', name }),
    endHug: () => send({ type: 'end_hug' }),
    clearScore: () => setScore(null),
    detectMannequin: () => send({ type: 'detect_mannequin' }),
    setMannequin: (neck: [number, number], base: [number, number]) =>
      send({ type: 'set_mannequin', neck, base }),
  }
}
