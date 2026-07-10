// Shared cloud database between the Earth kiosk and the space-station UI.
// Both laptops make outbound connections to Supabase, so school-WiFi
// client isolation / VPNs never matter.
//
// Table setup (run once in the Supabase SQL editor):
//
//   create table public.hug_recordings (
//     id bigint generated always as identity primary key,
//     created_at timestamptz default now(),
//     hugger_name text not null,
//     overall real, strength real, style real, coverage real, warmth real,
//     hug_type text,
//     duration_ms integer,
//     frames jsonb not null,     -- [{t,s,r,c}] ms + squeeze/reach/closing
//     status text default 'sent' -- 'sent' -> 'played' once the robot runs it
//   );
//   alter table public.hug_recordings enable row level security;
//   create policy "demo anon access" on public.hug_recordings
//     for all to anon using (true) with check (true);

const SUPABASE_URL = 'https://dgjklhjtxomgbarboowg.supabase.co'
const SUPABASE_KEY = 'sb_publishable_pKAyK6SXF9XBJ3hGVSmkOA_Gr4yJfN3'

export interface HugFrame {
  t: number // ms since recording start
  s: number // squeeze 0..1
  r: number // wrap_reach 0..1
  c: number // closing velocity 0..1
}

export interface HugUpload {
  hugger_name: string
  overall: number
  strength: number
  style: number
  coverage: number
  warmth: number
  hug_type: string
  duration_ms: number
  frames: HugFrame[]
}

export async function uploadHug(hug: HugUpload): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/hug_recordings`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(hug),
  })
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
}
