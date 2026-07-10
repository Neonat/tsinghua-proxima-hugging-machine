-- Hug Rating Machine — shared cloud table between Earth kiosk and space station.
-- Run this ONCE in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table public.hug_recordings (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  hugger_name text not null,
  overall real,
  strength real,
  style real,
  coverage real,
  warmth real,
  hug_type text,
  duration_ms integer,
  -- The replayable hug: one entry per frame (~10 Hz),
  -- {t: ms since start, s: squeeze 0-1, r: wrap_reach 0-1, c: closing velocity 0-1}
  frames jsonb not null,
  -- 'sent' when uploaded from Earth; the space station marks it 'played'
  status text not null default 'sent'
);

alter table public.hug_recordings enable row level security;

-- Demo-grade access: the anon key may read/insert/update.
create policy "demo anon access" on public.hug_recordings
  for all to anon using (true) with check (true);

-- Space station listens for new hugs in realtime.
alter publication supabase_realtime add table public.hug_recordings;
