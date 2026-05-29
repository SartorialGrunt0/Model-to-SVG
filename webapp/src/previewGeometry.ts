import type { ImageAnnotation, Point, Segment } from './types'

export type LineGroup = {
  id: string
  label: string
  segmentIds: string[]
  segments: Segment[]
  length: number
}

export type SnapGuide =
  | {
      id: string
      kind: 'point'
      label: string
      point: Point
      source: 'model' | 'image'
    }
  | {
      id: string
      kind: 'segment'
      label: string
      start: Point
      end: Point
      source: 'model' | 'image'
    }

export type SnapHit = {
  guide: SnapGuide
  point: Point
  distance: number
}

type SegmentNodeInfo = {
  segment: Segment
  startKey: string
  endKey: string
}

function pointKey(point: [number, number]): string {
  return `${point[0].toFixed(4)}:${point[1].toFixed(4)}`
}

function distanceBetween(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function nearestPointOnLineSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const segmentLengthSquared = dx * dx + dy * dy

  if (segmentLengthSquared <= Number.EPSILON) {
    return start
  }

  const projection =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / segmentLengthSquared
  const clamped = Math.max(0, Math.min(1, projection))

  return {
    x: start.x + clamped * dx,
    y: start.y + clamped * dy,
  }
}

function otherNodeKey(info: SegmentNodeInfo, nodeKey: string): string {
  return info.startKey === nodeKey ? info.endKey : info.startKey
}

function walkContinuousGroup(
  startSegmentId: string,
  startNodeKey: string,
  adjacency: Map<string, string[]>,
  infoById: Map<string, SegmentNodeInfo>,
  visited: Set<string>,
): string[] {
  const groupSegmentIds: string[] = []
  const loopKey = startNodeKey
  let currentSegmentId = startSegmentId
  let currentNodeKey = startNodeKey

  while (true) {
    if (visited.has(currentSegmentId)) {
      break
    }

    visited.add(currentSegmentId)
    groupSegmentIds.push(currentSegmentId)

    const info = infoById.get(currentSegmentId)
    if (!info) {
      break
    }

    const nextNodeKey = otherNodeKey(info, currentNodeKey)
    if (nextNodeKey === loopKey && groupSegmentIds.length > 1) {
      break
    }

    const nodeDegree = adjacency.get(nextNodeKey)?.length ?? 0
    const nextCandidates = (adjacency.get(nextNodeKey) ?? []).filter(
      (segmentId) => segmentId !== currentSegmentId && !visited.has(segmentId),
    )

    if (nodeDegree !== 2 || nextCandidates.length !== 1) {
      break
    }

    currentNodeKey = nextNodeKey
    currentSegmentId = nextCandidates[0]
  }

  return groupSegmentIds
}

export function buildContinuousLineGroups(segments: Segment[]): LineGroup[] {
  const adjacency = new Map<string, string[]>()
  const infoById = new Map<string, SegmentNodeInfo>()

  for (const segment of segments) {
    const startKey = pointKey(segment.start)
    const endKey = pointKey(segment.end)
    infoById.set(segment.id, { segment, startKey, endKey })
    adjacency.set(startKey, [...(adjacency.get(startKey) ?? []), segment.id])
    adjacency.set(endKey, [...(adjacency.get(endKey) ?? []), segment.id])
  }

  const visited = new Set<string>()
  const groups: LineGroup[] = []

  for (const segment of segments) {
    if (visited.has(segment.id)) {
      continue
    }

    const info = infoById.get(segment.id)
    if (!info) {
      continue
    }

    const startDegree = adjacency.get(info.startKey)?.length ?? 0
    const endDegree = adjacency.get(info.endKey)?.length ?? 0
    const startNodeKey =
      startDegree !== 2 ? info.startKey : endDegree !== 2 ? info.endKey : info.startKey
    const segmentIds = walkContinuousGroup(
      segment.id,
      startNodeKey,
      adjacency,
      infoById,
      visited,
    )
    const groupSegments = segmentIds
      .map((segmentId) => infoById.get(segmentId)?.segment)
      .filter((value): value is Segment => value !== undefined)

    groups.push({
      id: `line-${groups.length + 1}`,
      label: `Line ${groups.length + 1}`,
      segmentIds,
      segments: groupSegments,
      length: groupSegments.reduce((sum, currentSegment) => sum + currentSegment.length, 0),
    })
  }

  return groups
}

function transformLocalPoint(
  annotation: Pick<ImageAnnotation, 'x' | 'y' | 'rotation'>,
  point: Point,
): Point {
  const angle = (annotation.rotation * Math.PI) / 180
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)

  return {
    x: annotation.x + point.x * cosine - point.y * sine,
    y: annotation.y + point.x * sine + point.y * cosine,
  }
}

export function buildImageSnapGuides(imageAnnotations: ImageAnnotation[]): SnapGuide[] {
  const guides: SnapGuide[] = []

  for (const annotation of imageAnnotations) {
    if (!annotation.visible) {
      continue
    }

    const topLeft = transformLocalPoint(annotation, { x: 0, y: 0 })
    const topRight = transformLocalPoint(annotation, { x: annotation.width, y: 0 })
    const bottomRight = transformLocalPoint(annotation, {
      x: annotation.width,
      y: annotation.height,
    })
    const bottomLeft = transformLocalPoint(annotation, { x: 0, y: annotation.height })
    const topCenter = transformLocalPoint(annotation, { x: annotation.width / 2, y: 0 })
    const rightCenter = transformLocalPoint(annotation, {
      x: annotation.width,
      y: annotation.height / 2,
    })
    const bottomCenter = transformLocalPoint(annotation, {
      x: annotation.width / 2,
      y: annotation.height,
    })
    const leftCenter = transformLocalPoint(annotation, {
      x: 0,
      y: annotation.height / 2,
    })
    const center = transformLocalPoint(annotation, {
      x: annotation.width / 2,
      y: annotation.height / 2,
    })

    guides.push(
      {
        id: `${annotation.id}-top-edge`,
        kind: 'segment',
        label: `${annotation.name} top edge`,
        start: topLeft,
        end: topRight,
        source: 'image',
      },
      {
        id: `${annotation.id}-right-edge`,
        kind: 'segment',
        label: `${annotation.name} right edge`,
        start: topRight,
        end: bottomRight,
        source: 'image',
      },
      {
        id: `${annotation.id}-bottom-edge`,
        kind: 'segment',
        label: `${annotation.name} bottom edge`,
        start: bottomLeft,
        end: bottomRight,
        source: 'image',
      },
      {
        id: `${annotation.id}-left-edge`,
        kind: 'segment',
        label: `${annotation.name} left edge`,
        start: topLeft,
        end: bottomLeft,
        source: 'image',
      },
      {
        id: `${annotation.id}-vertical-center`,
        kind: 'segment',
        label: `${annotation.name} vertical center`,
        start: topCenter,
        end: bottomCenter,
        source: 'image',
      },
      {
        id: `${annotation.id}-horizontal-center`,
        kind: 'segment',
        label: `${annotation.name} horizontal center`,
        start: leftCenter,
        end: rightCenter,
        source: 'image',
      },
      {
        id: `${annotation.id}-center-point`,
        kind: 'point',
        label: `${annotation.name} center`,
        point: center,
        source: 'image',
      },
      {
        id: `${annotation.id}-top-left`,
        kind: 'point',
        label: `${annotation.name} top left`,
        point: topLeft,
        source: 'image',
      },
      {
        id: `${annotation.id}-top-right`,
        kind: 'point',
        label: `${annotation.name} top right`,
        point: topRight,
        source: 'image',
      },
      {
        id: `${annotation.id}-bottom-right`,
        kind: 'point',
        label: `${annotation.name} bottom right`,
        point: bottomRight,
        source: 'image',
      },
      {
        id: `${annotation.id}-bottom-left`,
        kind: 'point',
        label: `${annotation.name} bottom left`,
        point: bottomLeft,
        source: 'image',
      },
    )
  }

  return guides
}

export function findBestSnapGuide(
  point: Point,
  guides: SnapGuide[],
  toleranceMm: number,
): SnapHit | null {
  let bestHit: SnapHit | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const guide of guides) {
    const snappedPoint =
      guide.kind === 'point'
        ? guide.point
        : nearestPointOnLineSegment(point, guide.start, guide.end)
    const distance = distanceBetween(point, snappedPoint)

    if (distance > toleranceMm) {
      continue
    }

    const score = distance + (guide.kind === 'segment' ? 0.05 : 0)
    if (score < bestScore) {
      bestScore = score
      bestHit = {
        guide,
        point: snappedPoint,
        distance,
      }
    }
  }

  return bestHit
}
