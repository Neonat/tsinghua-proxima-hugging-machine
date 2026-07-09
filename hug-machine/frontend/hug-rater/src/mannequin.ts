import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// A named span of faces inside the merged geometry, used by the fill tool
// and for sanity-checking imports.
export interface BodyPart {
  name: string
  faceStart: number
  faceCount: number
}

export interface PaintableGeometry {
  geometry: THREE.BufferGeometry // non-indexed, 3 vertices per face
  parts: BodyPart[]
  source: string // "default" or a filename
}

const DEG = Math.PI / 180

/** Bake a transform into a geometry and strip it down to position+normal. */
function place(
  geo: THREE.BufferGeometry,
  opts: { pos?: [number, number, number]; rotZ?: number; rotX?: number; scale?: [number, number, number] } = {},
): THREE.BufferGeometry {
  const m = new THREE.Matrix4()
  const rot = new THREE.Matrix4().makeRotationZ(opts.rotZ ?? 0)
  rot.multiply(new THREE.Matrix4().makeRotationX(opts.rotX ?? 0))
  if (opts.scale) m.multiply(new THREE.Matrix4().makeScale(...opts.scale))
  m.premultiply(rot)
  if (opts.pos) m.premultiply(new THREE.Matrix4().makeTranslation(...opts.pos))
  geo.applyMatrix4(m)
  return geo
}

/**
 * Programmatic anatomical mannequin, ~1.75m tall, standing on the origin,
 * facing +z, arms in a relaxed A-pose so hug zones stay reachable.
 * Facing +z with +y up, the mannequin's anatomical right is -x — it shows
 * on the viewer's left from the front, like a person in a photo.
 */
export function buildDefaultMannequin(): PaintableGeometry {
  const named: Array<[string, THREE.BufferGeometry]> = []

  named.push(['head', place(new THREE.SphereGeometry(0.112, 28, 20), { pos: [0, 1.62, 0], scale: [0.92, 1.12, 1] })])
  named.push(['neck', place(new THREE.CylinderGeometry(0.048, 0.062, 0.12, 18), { pos: [0, 1.48, 0] })])

  // Torso as a lathe profile: hips → waist → chest → shoulder taper,
  // flattened front-to-back to read as a body instead of a pill.
  const profile = [
    [0.001, 0.0], [0.15, 0.015], [0.163, 0.1], [0.135, 0.27],
    [0.168, 0.45], [0.164, 0.52], [0.138, 0.58], [0.001, 0.625],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  named.push(['torso', place(new THREE.LatheGeometry(profile, 30), { pos: [0, 0.9, 0], scale: [1, 1, 0.74] })])
  named.push(['pelvis', place(new THREE.CapsuleGeometry(0.148, 0.09, 6, 22), { pos: [0, 0.9, 0], scale: [1.08, 1, 0.8] })])

  for (const side of [-1, 1] as const) {
    const s = side === -1 ? 'r' : 'l' // anatomical right is -x
    const shoulder = new THREE.Vector3(side * 0.185, 1.43, 0)
    // rotZ(θ) sends the hanging (0,-1,0) arm toward +x for θ>0, so the
    // outward tilt matches the side's sign.
    const armTilt = side * 16 * DEG
    const dir = new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), armTilt)

    named.push([`${s}_shoulder_cap`, place(new THREE.SphereGeometry(0.068, 18, 14), { pos: shoulder.toArray() })])

    const upperC = shoulder.clone().addScaledVector(dir, 0.17)
    named.push([`${s}_upper_arm`, place(new THREE.CapsuleGeometry(0.052, 0.22, 6, 16), { pos: upperC.toArray(), rotZ: armTilt })])

    const elbow = shoulder.clone().addScaledVector(dir, 0.31)
    // Lower arm bends slightly forward, ready to receive a hug.
    const lowerDir = dir.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -14 * DEG)
    const lowerC = elbow.clone().addScaledVector(lowerDir, 0.13)
    named.push([`${s}_lower_arm`, place(new THREE.CapsuleGeometry(0.044, 0.2, 6, 16), { pos: lowerC.toArray(), rotZ: armTilt, rotX: -14 * DEG })])

    const wrist = elbow.clone().addScaledVector(lowerDir, 0.27)
    named.push([`${s}_hand`, place(new THREE.SphereGeometry(0.05, 14, 10), { pos: wrist.toArray(), scale: [0.85, 1.25, 0.95], rotZ: armTilt })])

    const hip = new THREE.Vector3(side * 0.088, 0.86, 0)
    named.push([`${s}_upper_leg`, place(new THREE.CapsuleGeometry(0.075, 0.3, 6, 18), { pos: [hip.x, 0.68, 0] })])
    named.push([`${s}_lower_leg`, place(new THREE.CapsuleGeometry(0.054, 0.32, 6, 16), { pos: [hip.x, 0.32, 0] })])
    named.push([`${s}_foot`, place(new THREE.SphereGeometry(0.06, 14, 10), { pos: [hip.x, 0.05, 0.05], scale: [0.95, 0.75, 1.9] })])
  }

  const parts: BodyPart[] = []
  const prepared: THREE.BufferGeometry[] = []
  let faceCursor = 0
  for (const [name, geoRaw] of named) {
    const geo = geoRaw.index ? geoRaw.toNonIndexed() : geoRaw
    for (const attr of Object.keys(geo.attributes)) {
      if (attr !== 'position' && attr !== 'normal') geo.deleteAttribute(attr)
    }
    const faces = geo.attributes.position.count / 3
    parts.push({ name, faceStart: faceCursor, faceCount: faces })
    faceCursor += faces
    prepared.push(geo)
  }

  const geometry = mergeGeometries(prepared, false)
  geometry.computeVertexNormals()
  return { geometry, parts, source: 'default' }
}
