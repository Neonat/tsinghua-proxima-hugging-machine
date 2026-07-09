// The nine named contact zones from the project brief, each with a paint
// colour chosen to stay legible against the warm dark scene.
export interface ZoneDef {
  id: string
  label: string
  color: string
  key: string // keyboard shortcut
}

export const ZONES: ZoneDef[] = [
  { id: 'chest', label: 'Chest', color: '#ff5c38', key: '1' },
  { id: 'left_shoulder', label: 'L Shoulder', color: '#ffa02e', key: '2' },
  { id: 'right_shoulder', label: 'R Shoulder', color: '#ffd166', key: '3' },
  { id: 'left_upper_arm', label: 'L Upper Arm', color: '#7fd8ff', key: '4' },
  { id: 'right_upper_arm', label: 'R Upper Arm', color: '#3f8cff', key: '5' },
  { id: 'left_lower_arm', label: 'L Lower Arm', color: '#42e8c0', key: '6' },
  { id: 'right_lower_arm', label: 'R Lower Arm', color: '#1e9e83', key: '7' },
  { id: 'upper_back', label: 'Upper Back', color: '#c986ff', key: '8' },
  { id: 'lower_back', label: 'Lower Back', color: '#ff7ab8', key: '9' },
]

export const zoneById = new Map(ZONES.map((z) => [z.id, z]))
