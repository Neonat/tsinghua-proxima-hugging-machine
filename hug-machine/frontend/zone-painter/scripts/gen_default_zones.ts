/**
 * Headless generator for a sensible default mannequin_zones.json, so the
 * backend works out of the box. The zone painter can refine it later —
 * same mesh, same face indexing.
 *
 *   npx tsx scripts/gen_default_zones.ts [out.json]
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { buildDefaultMannequin } from '../src/mannequin'
import { ZONES } from '../src/zones'

const { geometry, parts } = buildDefaultMannequin()
const pos = geometry.attributes.position
const faceCount = pos.count / 3

const partForFace = (f: number) => parts.find((p) => f >= p.faceStart && f < p.faceStart + p.faceCount)!.name

const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
const centroids: THREE.Vector3[] = []
const areas: number[] = []
for (let f = 0; f < faceCount; f++) {
  a.fromBufferAttribute(pos, f * 3)
  b.fromBufferAttribute(pos, f * 3 + 1)
  c.fromBufferAttribute(pos, f * 3 + 2)
  centroids.push(a.clone().add(b).add(c).divideScalar(3))
  areas.push(b.clone().sub(a).cross(c.clone().sub(a)).length() / 2)
}

// Straight part -> zone assignments; the torso is split below.
const partZone: Record<string, string> = {
  l_shoulder_cap: 'left_shoulder', r_shoulder_cap: 'right_shoulder',
  l_upper_arm: 'left_upper_arm', r_upper_arm: 'right_upper_arm',
  l_lower_arm: 'left_lower_arm', r_lower_arm: 'right_lower_arm',
  l_hand: 'left_lower_arm', r_hand: 'right_lower_arm',
}

const faceZones: Record<number, string> = {}
for (let f = 0; f < faceCount; f++) {
  const part = partForFace(f)
  const ctr = centroids[f]
  if (part === 'torso') {
    // Mannequin faces +z: front of the torso is chest, back splits at
    // mid-torso height into upper/lower back.
    faceZones[f] = ctr.z >= 0 ? 'chest' : ctr.y > 1.17 ? 'upper_back' : 'lower_back'
  } else if (partZone[part]) {
    faceZones[f] = partZone[part]
  }
}

const acc: Record<string, { c: THREE.Vector3; area: number; count: number }> = {}
for (const [fStr, zone] of Object.entries(faceZones)) {
  const f = +fStr
  const slot = (acc[zone] ??= { c: new THREE.Vector3(), area: 0, count: 0 })
  slot.c.addScaledVector(centroids[f], areas[f])
  slot.area += areas[f]
  slot.count++
}
const zones = Object.fromEntries(
  ZONES.filter((z) => acc[z.id]).map((z) => [z.id, {
    centroid: acc[z.id].c.divideScalar(acc[z.id].area).toArray().map((v) => +v.toFixed(5)),
    face_count: acc[z.id].count,
  }]),
)

const out = {
  schema_version: '1.0',
  source_mesh: 'default',
  exported_at: new Date().toISOString(),
  face_count: faceCount,
  zones,
  face_zones: faceZones,
}

const target = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../../data/mannequin_zones.json'))
writeFileSync(target, JSON.stringify(out, null, 1))
console.log(`wrote ${target}: ${Object.keys(faceZones).length}/${faceCount} faces across ${Object.keys(zones).length} zones`)
for (const [name, z] of Object.entries(zones)) console.log(`  ${name.padEnd(16)} ${String(z.face_count).padStart(5)} faces  centroid [${z.centroid.join(', ')}]`)
