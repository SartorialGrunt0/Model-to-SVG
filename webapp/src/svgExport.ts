import type { ImageAnnotation, ProjectionData, TextAnnotation } from './types'

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

export function buildExportSvg(
  projection: ProjectionData,
  hiddenLineIds: string[],
  textAnnotations: TextAnnotation[],
  imageAnnotations: ImageAnnotation[],
): string {
  const hidden = new Set(hiddenLineIds)

  const lineMarkup = projection.segments
    .filter((segment) => !hidden.has(segment.id))
    .map(
      (segment) =>
        `<line x1="${formatNumber(segment.start[0])}" y1="${formatNumber(segment.start[1])}" x2="${formatNumber(segment.end[0])}" y2="${formatNumber(segment.end[1])}" />`,
    )
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
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${projection.width.toFixed(4)}mm" height="${projection.height.toFixed(4)}mm" viewBox="0 0 ${formatNumber(projection.width)} ${formatNumber(projection.height)}">
  <g fill="none" stroke="black" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">
    ${lineMarkup}
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