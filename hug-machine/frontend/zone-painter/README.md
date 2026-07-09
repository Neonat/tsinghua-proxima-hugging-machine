# Zone Painter

One-time setup tool for the Hug Rating Machine: paint named contact zones onto
the mannequin's digital twin and export them as `mannequin_zones.json` for the
CV backend's contact-zone mapping.

```sh
npm install
npm run dev
```

## Using it

- **Brush** (`B`) — left-drag on the mesh paints faces within the brush radius
  (`[` / `]` to resize). Left-drag on empty space or right-drag orbits; scroll zooms.
- **Fill Part** (`F`) — one click paints an entire body part (torso, upper arm, …).
  Handy for arms and shoulders; use the brush to split the torso into
  chest vs. upper/lower back.
- **Erase** (`E`) — brush that removes paint.
- Zones select with `1`–`9`, undo with `⌘Z`.
- **Load .glb scan** swaps the default mannequin for a LiDAR scan
  (e.g. Scaniverse export). The mesh is normalized to ~1.75 m standing on the
  origin. Face indices change, so zones reset.
- **Export** downloads `mannequin_zones.json` — save it to `hug-machine/data/`.
- **Import JSON** restores a previous export to keep editing
  (face count must match the loaded mesh).

## Export format

```jsonc
{
  "schema_version": "1.0",
  "source_mesh": "default",          // or the .glb filename
  "exported_at": "2026-07-08T…",
  "face_count": 7504,                // total faces in the mesh
  "zones": {
    "chest": { "centroid": [0, 1.2, 0.1], "face_count": 420 }
    // … one entry per painted zone; centroid is area-weighted, in meters
  },
  "face_zones": { "1142": "chest" }  // face index → zone name, painted faces only
}
```

The mannequin faces +z with +y up and stands on the origin; `left_*` / `right_*`
zones are the mannequin's own anatomical sides (its right is at −x).

The default mannequin is deterministic — the same app version always produces
the same face indexing, so exports stay valid across sessions. In dev builds the
engine is exposed as `window.__painter` for scripting
(`fillPartByName('torso', 'chest')`, `exportJSON()`, `partNames`).
