import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildDefaultMannequin, type PaintableGeometry } from './mannequin'
import { ZONES, zoneById } from './zones'

export type Tool = 'brush' | 'fill' | 'erase'

export interface ZoneStats {
  faceCounts: Record<string, number>
  paintedFaces: number
  totalFaces: number
}

const BASE_COLOR = new THREE.Color('#38322c')
const UNPAINTED = -1

interface StrokeDiff {
  faces: Map<number, number> // face index -> previous zone index
}

export class PainterEngine {
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera!: THREE.PerspectiveCamera
  private controls!: OrbitControls
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  private mesh: THREE.Mesh | null = null
  private wire: THREE.LineSegments | null = null
  private cursor!: THREE.Mesh
  private paintable!: PaintableGeometry

  private faceZones = new Int16Array(0) // face index -> zone index or -1
  private centroids = new Float32Array(0)
  private areas = new Float32Array(0)

  tool: Tool = 'brush'
  zoneIndex = 0
  brushRadius = 0.055

  private stroke: StrokeDiff | null = null
  private undoStack: StrokeDiff[] = []
  private disposed = false

  onStats: (s: ZoneStats) => void = () => {}
  onUndoDepth: (n: number) => void = () => {}

  mount(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 60)
    this.camera.position.set(1.35, 1.5, 3.1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.95, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 0.5
    this.controls.maxDistance = 8

    this.scene.add(new THREE.AmbientLight('#57493d', 2))
    this.scene.add(new THREE.HemisphereLight('#ffd9b0', '#241a12', 0.9))
    const key = new THREE.PointLight('#ffb37a', 42, 0, 2)
    key.position.set(2.2, 2.6, 2.4)
    this.scene.add(key)
    const rim = new THREE.PointLight('#5a7dff', 16, 0, 2)
    rim.position.set(-2.4, 1.6, -2.2)
    this.scene.add(rim)
    const fill = new THREE.PointLight('#ff8a5c', 5, 0, 2)
    fill.position.set(-1.2, 0.4, 2.6)
    this.scene.add(fill)

    const grid = new THREE.PolarGridHelper(1.35, 12, 5, 64, '#7a4a2e', '#3a2c22')
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.55
    this.scene.add(grid)

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.35, 64),
      new THREE.MeshBasicMaterial({ color: '#120d0a', transparent: true, opacity: 0.85 }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.position.y = -0.002
    this.scene.add(disc)

    // Brush cursor: a glowing ring that hugs the surface under the pointer.
    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 40),
      new THREE.MeshBasicMaterial({ color: '#ffb37a', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }),
    )
    this.cursor.visible = false
    this.cursor.renderOrder = 10
    this.scene.add(this.cursor)

    this.setPaintable(buildDefaultMannequin())

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      this.renderer.setSize(w, h)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    resize()
    this.resizeObserver = new ResizeObserver(resize)
    this.resizeObserver.observe(container)

    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    })
  }
  private resizeObserver!: ResizeObserver

  dispose() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver?.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.renderer.dispose()
    el.remove()
  }

  // ---------- geometry ----------

  private setPaintable(p: PaintableGeometry) {
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
    }
    if (this.wire) {
      this.scene.remove(this.wire)
      this.wire.geometry.dispose()
    }
    this.paintable = p
    const geo = p.geometry
    const faceCount = geo.attributes.position.count / 3
    this.faceZones = new Int16Array(faceCount).fill(UNPAINTED)
    this.undoStack = []
    this.onUndoDepth(0)

    const colors = new Float32Array(geo.attributes.position.count * 3)
    for (let i = 0; i < geo.attributes.position.count; i++) BASE_COLOR.toArray(colors, i * 3)
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // Precompute face centroids and areas for brush hit-testing and export.
    this.centroids = new Float32Array(faceCount * 3)
    this.areas = new Float32Array(faceCount)
    const pos = geo.attributes.position
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const ab = new THREE.Vector3(), ac = new THREE.Vector3()
    for (let f = 0; f < faceCount; f++) {
      a.fromBufferAttribute(pos, f * 3)
      b.fromBufferAttribute(pos, f * 3 + 1)
      c.fromBufferAttribute(pos, f * 3 + 2)
      this.centroids[f * 3] = (a.x + b.x + c.x) / 3
      this.centroids[f * 3 + 1] = (a.y + b.y + c.y) / 3
      this.centroids[f * 3 + 2] = (a.z + b.z + c.z) / 3
      this.areas[f] = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2
    }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.22, flatShading: true })
    this.mesh = new THREE.Mesh(geo, mat)
    this.scene.add(this.mesh)

    const wireMat = new THREE.LineBasicMaterial({ color: '#ffb37a', transparent: true, opacity: 0.13 })
    this.wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo), wireMat)
    this.scene.add(this.wire)

    this.emitStats()
  }

  resetMannequin() {
    this.setPaintable(buildDefaultMannequin())
  }

  clearPaint() {
    const diff: StrokeDiff = { faces: new Map() }
    for (let f = 0; f < this.faceZones.length; f++) {
      if (this.faceZones[f] !== UNPAINTED) {
        diff.faces.set(f, this.faceZones[f])
        this.setFaceZone(f, UNPAINTED)
      }
    }
    if (diff.faces.size) {
      this.undoStack.push(diff)
      this.onUndoDepth(this.undoStack.length)
      this.emitStats()
    }
  }

  async loadGLB(buffer: ArrayBuffer, filename: string) {
    const gltf = await new GLTFLoader().parseAsync(buffer, '')
    gltf.scene.updateMatrixWorld(true)
    const geos: THREE.BufferGeometry[] = []
    gltf.scene.traverse((obj) => {
      const m = obj as THREE.Mesh
      if (!m.isMesh) return
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()) as THREE.BufferGeometry
      for (const attr of Object.keys(g.attributes)) {
        if (attr !== 'position') g.deleteAttribute(attr)
      }
      g.applyMatrix4(m.matrixWorld)
      geos.push(g)
    })
    if (!geos.length) throw new Error('No meshes found in GLB')
    const merged = mergeGeometries(geos, false)
    // Normalize: feet on the floor at the origin, ~1.75m tall.
    merged.computeBoundingBox()
    const box = merged.boundingBox!
    const size = new THREE.Vector3()
    box.getSize(size)
    const scale = 1.75 / Math.max(size.y, 1e-6)
    const center = new THREE.Vector3()
    box.getCenter(center)
    merged.translate(-center.x, -box.min.y, -center.z)
    merged.scale(scale, scale, scale)
    merged.computeVertexNormals()
    const faceCount = merged.attributes.position.count / 3
    this.setPaintable({ geometry: merged, parts: [{ name: 'mesh', faceStart: 0, faceCount }], source: filename })
  }

  get source() {
    return this.paintable?.source ?? 'default'
  }

  // ---------- painting ----------

  private setFaceZone(face: number, zone: number) {
    this.faceZones[face] = zone
    const color = zone === UNPAINTED ? BASE_COLOR : tmpColor.set(zoneById.get(ZONES[zone].id)!.color)
    const attr = this.mesh!.geometry.attributes.color as THREE.BufferAttribute
    for (let v = 0; v < 3; v++) color.toArray(attr.array as Float32Array, (face * 3 + v) * 3)
    attr.needsUpdate = true
  }

  private applyAt(hit: THREE.Intersection) {
    const targetZone = this.tool === 'erase' ? UNPAINTED : this.zoneIndex
    if (this.tool === 'fill') {
      const face = hit.faceIndex!
      const part = this.paintable.parts.find((p) => face >= p.faceStart && face < p.faceStart + p.faceCount)
      if (!part) return
      for (let f = part.faceStart; f < part.faceStart + part.faceCount; f++) this.paintFace(f, targetZone)
    } else {
      const p = hit.point
      const r2 = this.brushRadius * this.brushRadius
      for (let f = 0; f < this.faceZones.length; f++) {
        const dx = this.centroids[f * 3] - p.x
        const dy = this.centroids[f * 3 + 1] - p.y
        const dz = this.centroids[f * 3 + 2] - p.z
        if (dx * dx + dy * dy + dz * dz <= r2) this.paintFace(f, targetZone)
      }
    }
  }

  private paintFace(face: number, zone: number) {
    if (this.faceZones[face] === zone) return
    if (this.stroke && !this.stroke.faces.has(face)) this.stroke.faces.set(face, this.faceZones[face])
    this.setFaceZone(face, zone)
  }

  /** Assign every face of a named body part to a zone (or null to clear). */
  fillPartByName(partName: string, zoneId: string | null): boolean {
    const part = this.paintable.parts.find((p) => p.name === partName)
    const zi = zoneId === null ? UNPAINTED : ZONES.findIndex((z) => z.id === zoneId)
    if (!part || zi < UNPAINTED) return false
    if (zoneId !== null && zi === UNPAINTED) return false
    for (let f = part.faceStart; f < part.faceStart + part.faceCount; f++) this.setFaceZone(f, zi)
    this.emitStats()
    return true
  }

  get partNames(): string[] {
    return this.paintable.parts.map((p) => p.name)
  }

  undo() {
    const diff = this.undoStack.pop()
    if (!diff) return
    for (const [face, zone] of diff.faces) this.setFaceZone(face, zone)
    this.onUndoDepth(this.undoStack.length)
    this.emitStats()
  }

  // ---------- pointer handling ----------

  private updatePointer(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  private castOnMesh(): THREE.Intersection | null {
    if (!this.mesh) return null
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.mesh, false)
    return hits[0] ?? null
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    this.updatePointer(e)
    const hit = this.castOnMesh()
    if (!hit) return // left-drag on empty space orbits
    this.controls.enabled = false
    this.stroke = { faces: new Map() }
    this.applyAt(hit)
  }

  private onPointerMove = (e: PointerEvent) => {
    this.updatePointer(e)
    const hit = this.castOnMesh()
    if (hit && this.tool !== 'fill') {
      this.cursor.visible = true
      this.cursor.position.copy(hit.point)
      const n = hit.face!.normal.clone().transformDirection(this.mesh!.matrixWorld)
      this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
      const s = this.brushRadius
      this.cursor.scale.set(s, s, s)
      ;(this.cursor.material as THREE.MeshBasicMaterial).color.set(this.tool === 'erase' ? '#8a8a8a' : ZONES[this.zoneIndex].color)
    } else {
      this.cursor.visible = false
    }
    if (this.stroke && hit) this.applyAt(hit)
  }

  private onPointerUp = () => {
    if (this.stroke) {
      if (this.stroke.faces.size) {
        this.undoStack.push(this.stroke)
        if (this.undoStack.length > 64) this.undoStack.shift()
        this.onUndoDepth(this.undoStack.length)
        this.emitStats()
      }
      this.stroke = null
    }
    this.controls.enabled = true
  }

  // ---------- stats / io ----------

  private emitStats() {
    const faceCounts: Record<string, number> = {}
    for (const z of ZONES) faceCounts[z.id] = 0
    let painted = 0
    for (let f = 0; f < this.faceZones.length; f++) {
      const z = this.faceZones[f]
      if (z !== UNPAINTED) {
        faceCounts[ZONES[z].id]++
        painted++
      }
    }
    this.onStats({ faceCounts, paintedFaces: painted, totalFaces: this.faceZones.length })
  }

  exportJSON() {
    const faceZonesOut: Record<string, string> = {}
    const acc: Record<string, { c: THREE.Vector3; area: number; count: number }> = {}
    for (let f = 0; f < this.faceZones.length; f++) {
      const zi = this.faceZones[f]
      if (zi === UNPAINTED) continue
      const id = ZONES[zi].id
      faceZonesOut[f] = id
      const slot = (acc[id] ??= { c: new THREE.Vector3(), area: 0, count: 0 })
      const w = this.areas[f]
      slot.c.x += this.centroids[f * 3] * w
      slot.c.y += this.centroids[f * 3 + 1] * w
      slot.c.z += this.centroids[f * 3 + 2] * w
      slot.area += w
      slot.count++
    }
    const zones: Record<string, { centroid: number[]; face_count: number }> = {}
    for (const [id, s] of Object.entries(acc)) {
      zones[id] = {
        centroid: s.c.divideScalar(Math.max(s.area, 1e-9)).toArray().map((v) => +v.toFixed(5)),
        face_count: s.count,
      }
    }
    return {
      schema_version: '1.0',
      source_mesh: this.source,
      exported_at: new Date().toISOString(),
      face_count: this.faceZones.length,
      zones,
      face_zones: faceZonesOut,
    }
  }

  importJSON(data: { face_count?: number; face_zones?: Record<string, string> }) {
    if (!data.face_zones) throw new Error('Missing face_zones')
    if (data.face_count !== this.faceZones.length) {
      throw new Error(`Face count mismatch: file has ${data.face_count}, current mesh has ${this.faceZones.length}`)
    }
    const zoneIndexById = new Map(ZONES.map((z, i) => [z.id, i]))
    for (let f = 0; f < this.faceZones.length; f++) this.setFaceZone(f, UNPAINTED)
    for (const [faceStr, zoneId] of Object.entries(data.face_zones)) {
      const zi = zoneIndexById.get(zoneId)
      const f = +faceStr
      if (zi !== undefined && f >= 0 && f < this.faceZones.length) this.setFaceZone(f, zi)
    }
    this.undoStack = []
    this.onUndoDepth(0)
    this.emitStats()
  }
}

const tmpColor = new THREE.Color()
