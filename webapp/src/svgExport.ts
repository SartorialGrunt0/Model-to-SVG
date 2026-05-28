import type { ImageAnnotation, ModelEntry, TextAnnotation } from './types'

const DEFAULT_CANVAS_SIZE = 100

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function formatNumber(value: number): string {
  return value.toFixed(6)
}

function buildTransform(x: number, y: number, rotation: number): string {
  return `translate(${formatNumber(x)} ${formatNumber(y)}) rotate(${formatNumber(rotation)})`
}

function polygonToPathData(points: [number, number][]): string {
  if (points.length < 3) return ''
  const parts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(6)} ${p[1].toFixed(6)}`)
  return parts.join(' ') + ' Z'
}

export function buildExportSvg(
  models: ModelEntry[],
  textAnnotations: TextAnnotation[],
  imageAnnotations: ImageAnnotation[],
): string {
  let maxX = 0
  let maxY = 0
  for (const model of models) {
    if (!model.projection) continue
    const right = model.x + model.projection.width * model.scale
    const bottom = model.y + model.projection.height * model.scale
    if (right > maxX) maxX = right
    if (bottom > maxY) maxY = bottom
  }
  const canvasWidth = maxX || DEFAULT_CANVAS_SIZE
  const canvasHeight = maxY || DEFAULT_CANVAS_SIZE

  const modelMarkup = models
    .filter((model) => model.projection)
    .map((model) => {
      const hidden = new Set(model.hiddenLineIds)
      const proj = model.projection!

      const fillMarkup = model.fillEnabled
        ? proj.closed_polygons
            .map(
              (polygon) =>
                `<path d="${polygonToPathData(polygon.points)}" fill="black" stroke="none" />`,
            )
            .join('')
        : ''

      const lineMarkup = proj.segments
        .filter((segment) => !hidden.has(segment.id))
        .map(
          (segment) =>
            `<line x1="${formatNumber(segment.start[0])}" y1="${formatNumber(segment.start[1])}" x2="${formatNumber(segment.end[0])}" y2="${formatNumber(segment.end[1])}" />`,
        )
        .join('')

      return `<g transform="translate(${formatNumber(model.x)} ${formatNumber(model.y)}) scale(${formatNumber(model.scale)})">${fillMarkup}${lineMarkup}</g>`
    })
    .join('')

  const textMarkup = textAnnotations
    .filter((annotation) => annotation.visible && annotation.pathData)
    .map(
      (annotation) =>
        `<g transform="${buildTransform(annotation.x, annotation.y, annotation.rotation)}"><path d="${escapeXml(annotation.pathData)}" /></g>`,
    )
    .join('')

  const imageMarkup = imageAnnotations
    .filter((annotation) => annotation.visible)
    .map(
      (annotation) =>
        `<g transform="${buildTransform(annotation.x, annotation.y, annotation.rotation)}"><image href="${escapeXml(annotation.dataUrl)}" x="0" y="0" width="${formatNumber(annotation.width)}" height="${formatNumber(annotation.height)}" opacity="${annotation.opacity.toFixed(3)}" preserveAspectRatio="none" /></g>`,
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvasWidth.toFixed(4)}mm" height="${canvasHeight.toFixed(4)}mm" viewBox="0 0 ${formatNumber(canvasWidth)} ${formatNumber(canvasHeight)}">
  <rect width="${formatNumber(canvasWidth)}" height="${formatNumber(canvasHeight)}" fill="white" />
  <g fill="none" stroke="black" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">
    ${modelMarkup}
    ${textMarkup}
  </g>
  ${imageMarkup}
</svg>`
}

export function downloadSvg(fileName: string, svgMarkup: string): void {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}