import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildDefaultMannequin } from './mannequin'

const BASE = new THREE.Color('#38322c')
// Contact ramp from the brief: cool blue -> orange -> hot red.
const RAMP: Array<[number, THREE.Color]> = [
  [0.0, BASE],
  [0.18, new THREE.Color('#2f6bd8')],
  [0.55, new THREE.Color('#ff9e5e')],
  [1.0, new THREE.Color('#ff3b1f')],
]

function rampColor(t: number, out: THREE.Color): THREE.Color {
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i]
    const [t0, c0] = RAMP[i - 1]
    if (t <= t1 || i === RAMP.length - 1) {
      return out.copy(c0).lerp(c1, THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1))
    }
  }
  return out.copy(BASE)
}

/** Live mannequin heatmap: zones glow blue -> orange -> red by intensity. */
export class HeatmapScene {
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera!: THREE.PerspectiveCamera
  private controls!: OrbitControls
  private resizeObserver!: ResizeObserver

  private colorAttr!: THREE.BufferAttribute
  private zoneFaces = new Map<string, number[]>() // zone -> face indices
  private current = new Map<string, number>() // smoothed intensity per zone
  private target = new Map<string, number>()
  private disposed = false

  zonesReady = false

  async mount(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 60)
    this.camera.position.set(1.6, 1.45, 2.9)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.95, 0)
    this.controls.enableDamping = true
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = 0.6
    this.controls.minDistance = 1
    this.controls.maxDistance = 7

    this.scene.add(new THREE.AmbientLight('#57493d', 2))
    this.scene.add(new THREE.HemisphereLight('#ffd9b0', '#241a12', 0.9))
    const key = new THREE.PointLight('#ffb37a', 42, 0, 2)
    key.position.set(2.2, 2.6, 2.4)
    this.scene.add(key)
    const rim = new THREE.PointLight('#5a7dff', 16, 0, 2)
    rim.position.set(-2.4, 1.6, -2.2)
    this.scene.add(rim)

    const grid = new THREE.PolarGridHelper(1.35, 12, 5, 64, '#7a4a2e', '#3a2c22')
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.55
    this.scene.add(grid)

    const { geometry } = buildDefaultMannequin()
    const vertexCount = geometry.attributes.position.count
    const colors = new Float32Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) BASE.toArray(colors, i * 3)
    this.colorAttr = new THREE.BufferAttribute(colors, 3)
    geometry.setAttribute('color', this.colorAttr)

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.22, flatShading: true }),
    )
    this.scene.add(mesh)
    this.scene.add(
      new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: '#ffb37a', transparent: true, opacity: 0.1 }),
      ),
    )

    // Zone -> painted faces, from the same JSON the backend uses.
    try {
      const res = await fetch('/mannequin_zones.json')
      const data = await res.json()
      const faceCount = vertexCount / 3
      if (data.face_count === faceCount) {
        for (const [faceStr, zone] of Object.entries<string>(data.face_zones)) {
          let list = this.zoneFaces.get(zone)
          if (!list) this.zoneFaces.set(zone, (list = []))
          list.push(+faceStr)
        }
        this.zonesReady = true
      } else {
        console.warn(`zone file face_count ${data.face_count} != mesh ${faceCount}`)
      }
    } catch (err) {
      console.warn('could not load /mannequin_zones.json', err)
    }

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

    const tmp = new THREE.Color()
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return
      // Ease every zone toward its target so contact pulses feel organic.
      let dirty = false
      for (const [zone, faces] of this.zoneFaces) {
        const cur = this.current.get(zone) ?? 0
        const tgt = this.target.get(zone) ?? 0
        const next = Math.abs(tgt - cur) < 0.004 ? tgt : cur + (tgt - cur) * 0.18
        if (next !== cur) {
          this.current.set(zone, next)
          rampColor(next, tmp)
          const arr = this.colorAttr.array as Float32Array
          for (const f of faces) for (let v = 0; v < 3; v++) tmp.toArray(arr, (f * 3 + v) * 3)
          dirty = true
        }
      }
      if (dirty) this.colorAttr.needsUpdate = true
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    })
  }

  setIntensities(zones: Record<string, number>) {
    for (const zone of this.zoneFaces.keys()) this.target.set(zone, zones[zone] ?? 0)
  }

  dispose() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver?.disconnect()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
