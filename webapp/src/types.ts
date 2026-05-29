export type Orientation = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

export type Segment = {
  id: string
  start: [number, number]
  end: [number, number]
  length: number
}

export type ClosedPolygon = {
  id: string
  points: [number, number][]
}

export type ProjectionData = {
  file_name: string
  orientation: Orientation
  page_rotation: number
  units: string
  width: number
  height: number
  segments: Segment[]
  closed_polygons: ClosedPolygon[]
}

export type ModelEntry = {
  id: string
  name: string
  file: File
  orientation: Orientation
  pageRotation: number
  perspectiveDistance: number
  projection: ProjectionData | null
  hiddenLineIds: string[]
  selectedLineIds: string[]
  filledPolygonIds: string[]
  x: number
  y: number
  scale: number
}

export type TextPathResponse = {
  font_family: string
  path_data: string
  width: number
  height: number
}

export type Point = {
  x: number
  y: number
}

export type Measurement = {
  id: string
  start: Point
  end: Point
  length: number
}

export type TextAnnotation = {
  id: string
  name: string
  content: string
  fontFamily: string
  sizeMm: number
  x: number
  y: number
  rotation: number
  pathData: string
  width: number
  height: number
  visible: boolean
}

export type ImageAnnotation = {
  id: string
  name: string
  dataUrl: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  visible: boolean
}