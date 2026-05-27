import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import './App.css'
import { fetchFonts, fetchProjection, fetchTextPath } from './api'
import { buildExportSvg, downloadSvg } from './svgExport'
import type {
  ImageAnnotation,
  Measurement,
  Orientation,
  Point,
  ProjectionData,
  Segment,
  TextAnnotation,
} from './types'

const ORIENTATION_OPTIONS: Array<{ label: string; value: Orientation }> = [
  { label: 'Top', value: 'top' },
  { label: 'Bottom', value: 'bottom' },
  { label: 'Front', value: 'front' },
  { label: 'Back', value: 'back' },
  { label: 'Left', value: 'left' },
  { label: 'Right', value: 'right' },
]

const PAGE_ROTATIONS = [0, 90, 180, 270] as const

type DragState = {
  kind: 'text' | 'image'
  id: string
  pointerStart: Point
  origin: Point
}

function formatMillimeters(value: number): string {
  return `${value.toFixed(3)} mm`
}

function distanceBetween(start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  return Math.hypot(dx, dy)
}

function nearestPointOnSegment(point: Point, segment: Segment): Point {
  const [startX, startY] = segment.start
  const [endX, endY] = segment.end
  const dx = endX - startX
  const dy = endY - startY
  const segmentLengthSquared = dx * dx + dy * dy

  if (segmentLengthSquared <= Number.EPSILON) {
    return { x: startX, y: startY }
  }

  const projection =
    ((point.x - startX) * dx + (point.y - startY) * dy) / segmentLengthSquared
  const clamped = Math.max(0, Math.min(1, projection))

  return {
    x: startX + clamped * dx,
    y: startY + clamped * dy,
  }
}

function clientPointToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): Point | null {
  const ctm = svg.getScreenCTM()
  if (!ctm) {
    return null
  }

  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY

  const result = point.matrixTransform(ctm.inverse())
  return { x: result.x, y: result.y }
}

function getSnapToleranceMm(svg: SVGSVGElement, projection: ProjectionData): number {
  const bounds = svg.getBoundingClientRect()
  if (!bounds.width) {
    return 1.25
  }

  const millimetersPerPixel = projection.width / bounds.width
  return Math.max(millimetersPerPixel * 12, 0.75)
}

function toggleId(currentIds: string[], id: string): string[] {
  return currentIds.includes(id)
    ? currentIds.filter((currentId) => currentId !== id)
    : [...currentIds, id]
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Unable to read the selected image.'))
    reader.readAsDataURL(file)
  })
}

function readImageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve({ width: image.width, height: image.height })
    }
    image.onerror = () => reject(new Error('Unable to load the selected image.'))
    image.src = dataUrl
  })
}

function App() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [fonts, setFonts] = useState<string[]>([])
  const [modelFile, setModelFile] = useState<File | null>(null)
  const [projection, setProjection] = useState<ProjectionData | null>(null)
  const [orientation, setOrientation] = useState<Orientation>('top')
  const [pageRotation, setPageRotation] = useState<number>(0)
  const [status, setStatus] = useState('Upload an STL or STEP file to start the editor.')
  const [error, setError] = useState<string | null>(null)
  const [isLoadingProjection, setIsLoadingProjection] = useState(false)
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([])
  const [hiddenLineIds, setHiddenLineIds] = useState<string[]>([])
  const [showHiddenGhosts, setShowHiddenGhosts] = useState(true)
  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([])
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const [imageAnnotations, setImageAnnotations] = useState<ImageAnnotation[]>([])
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [measureMode, setMeasureMode] = useState(false)
  const [measurementDraft, setMeasurementDraft] = useState<Point | null>(null)
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [dragState, setDragState] = useState<DragState | null>(null)
  const deferredHiddenLineIds = useDeferredValue(hiddenLineIds)
  const deferredSelectedLineIds = useDeferredValue(selectedLineIds)
  const textRequestSequence = useRef(0)

  const hiddenLineIdSet = new Set(hiddenLineIds)
  const selectedText =
    textAnnotations.find((annotation) => annotation.id === selectedTextId) ?? null
  const selectedImage =
    imageAnnotations.find((annotation) => annotation.id === selectedImageId) ?? null
  const selectedSegments =
    projection?.segments.filter((segment) => deferredSelectedLineIds.includes(segment.id)) ?? []
  const hiddenSegments =
    projection?.segments.filter((segment) => deferredHiddenLineIds.includes(segment.id)) ?? []

  const findSnapPoint = useEffectEvent((point: Point): Point | null => {
    if (!projection || !svgRef.current) {
      return null
    }

    const tolerance = getSnapToleranceMm(svgRef.current, projection)
    let bestPoint: Point | null = null
    let bestDistance = tolerance

    for (const segment of projection.segments) {
      if (hiddenLineIdSet.has(segment.id)) {
        continue
      }

      const candidate = nearestPointOnSegment(point, segment)
      const candidateDistance = distanceBetween(point, candidate)
      if (candidateDistance <= bestDistance) {
        bestDistance = candidateDistance
        bestPoint = candidate
      }
    }

    return bestPoint
  })

  const loadProjection = useEffectEvent(
    async (nextFile: File, nextOrientation: Orientation, nextPageRotation: number) => {
      setIsLoadingProjection(true)
      setError(null)
      setStatus(`Projecting ${nextFile.name}...`)

      try {
        const nextProjection = await fetchProjection(
          nextFile,
          nextOrientation,
          nextPageRotation,
        )
        startTransition(() => {
          setProjection(nextProjection)
          setHiddenLineIds([])
          setSelectedLineIds([])
          setMeasurements([])
          setMeasurementDraft(null)
        })
        setStatus(
          `Loaded ${nextProjection.file_name} at ${formatMillimeters(nextProjection.width)} by ${formatMillimeters(nextProjection.height)}.`,
        )
      } catch (projectionError) {
        const message =
          projectionError instanceof Error
            ? projectionError.message
            : 'Projection failed.'
        setError(message)
        setStatus('Projection failed.')
      } finally {
        setIsLoadingProjection(false)
      }
    },
  )

  useEffect(() => {
    void fetchFonts()
      .then((fontFamilies) => {
        setFonts(fontFamilies)
      })
      .catch((fontError) => {
        const message = fontError instanceof Error ? fontError.message : 'Unable to load fonts.'
        setError(message)
      })
  }, [])

  useEffect(() => {
    if (!modelFile) {
      return
    }

    void loadProjection(modelFile, orientation, pageRotation)
  }, [modelFile, orientation, pageRotation])

  useEffect(() => {
    if (!selectedText) {
      return
    }

    if (!selectedText.content.trim()) {
      setTextAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === selectedText.id
            ? { ...annotation, pathData: '', width: 0, height: 0 }
            : annotation,
        ),
      )
      return
    }

    const requestId = ++textRequestSequence.current
    const timer = window.setTimeout(() => {
      void fetchTextPath(
        selectedText.content,
        selectedText.fontFamily,
        selectedText.sizeMm,
      )
        .then((outline) => {
          if (textRequestSequence.current !== requestId) {
            return
          }

          setTextAnnotations((currentAnnotations) =>
            currentAnnotations.map((annotation) =>
              annotation.id === selectedText.id
                ? {
                    ...annotation,
                    fontFamily: outline.font_family,
                    pathData: outline.path_data,
                    width: outline.width,
                    height: outline.height,
                  }
                : annotation,
            ),
          )
        })
        .catch((textError) => {
          if (textRequestSequence.current !== requestId) {
            return
          }

          const message =
            textError instanceof Error
              ? textError.message
              : 'Unable to generate a text outline.'
          setError(message)
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
    }
  }, [selectedText?.content, selectedText?.fontFamily, selectedText?.id, selectedText?.sizeMm])

  const handleDragMove = useEffectEvent((event: PointerEvent) => {
    if (!dragState || !projection || !svgRef.current) {
      return
    }

    const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
    if (!pointer) {
      return
    }

    const nextPoint = {
      x: dragState.origin.x + (pointer.x - dragState.pointerStart.x),
      y: dragState.origin.y + (pointer.y - dragState.pointerStart.y),
    }
    const snapped = findSnapPoint(nextPoint)
    const target = snapped ?? nextPoint

    if (dragState.kind === 'text') {
      setTextAnnotations((currentAnnotations) =>
        currentAnnotations.map((annotation) =>
          annotation.id === dragState.id
            ? { ...annotation, x: target.x, y: target.y }
            : annotation,
        ),
      )
      return
    }

    setImageAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) =>
        annotation.id === dragState.id
          ? { ...annotation, x: target.x, y: target.y }
          : annotation,
      ),
    )
  })

  useEffect(() => {
    if (!dragState) {
      return
    }

    const onPointerMove = (event: PointerEvent) => handleDragMove(event)
    const onPointerUp = () => setDragState(null)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [dragState])

  function updateSelectedText(patch: Partial<TextAnnotation>) {
    if (!selectedTextId) {
      return
    }

    setTextAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) =>
        annotation.id === selectedTextId ? { ...annotation, ...patch } : annotation,
      ),
    )
  }

  function updateSelectedImage(patch: Partial<ImageAnnotation>) {
    if (!selectedImageId) {
      return
    }

    setImageAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) =>
        annotation.id === selectedImageId ? { ...annotation, ...patch } : annotation,
      ),
    )
  }

  function handleModelFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null
    setModelFile(nextFile)
    setSelectedLineIds([])
    setSelectedTextId(null)
    setSelectedImageId(null)
  }

  async function handleAddText() {
    const fontFamily = fonts[0] ?? 'Arial'

    try {
      const outline = await fetchTextPath('TEXT', fontFamily, 6)
      const annotation: TextAnnotation = {
        id: crypto.randomUUID(),
        name: `Text ${textAnnotations.length + 1}`,
        content: 'TEXT',
        fontFamily: outline.font_family,
        sizeMm: 6,
        x: 4,
        y: 4,
        rotation: 0,
        pathData: outline.path_data,
        width: outline.width,
        height: outline.height,
        visible: true,
      }

      setTextAnnotations((currentAnnotations) => [...currentAnnotations, annotation])
      setSelectedTextId(annotation.id)
      setSelectedImageId(null)
      setSelectedLineIds([])
      setStatus(
        'Added a text annotation. Drag it in the preview or refine the coordinates in the sidebar.',
      )
    } catch (textError) {
      const message =
        textError instanceof Error ? textError.message : 'Unable to create a text annotation.'
      setError(message)
    }
  }

  function handleRemoveText() {
    if (!selectedTextId) {
      return
    }

    setTextAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedTextId),
    )
    setSelectedTextId(null)
  }

  async function handleImageFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const dataUrl = await readFileAsDataUrl(file)
      const size = await readImageDimensions(dataUrl)
      const width = 20
      const height = (size.height / size.width) * width
      const annotation: ImageAnnotation = {
        id: crypto.randomUUID(),
        name: file.name,
        dataUrl,
        x: 5,
        y: 5,
        width,
        height,
        rotation: 0,
        opacity: 1,
        visible: true,
      }

      setImageAnnotations((currentAnnotations) => [...currentAnnotations, annotation])
      setSelectedImageId(annotation.id)
      setSelectedTextId(null)
      setSelectedLineIds([])
      setStatus(
        `Added image ${file.name}. Drag it in the preview or edit its exact position in the sidebar.`,
      )
    } catch (imageError) {
      const message =
        imageError instanceof Error ? imageError.message : 'Unable to add the selected image.'
      setError(message)
    }

    event.target.value = ''
  }

  function handleRemoveImage() {
    if (!selectedImageId) {
      return
    }

    setImageAnnotations((currentAnnotations) =>
      currentAnnotations.filter((annotation) => annotation.id !== selectedImageId),
    )
    setSelectedImageId(null)
  }

  function handleLinePointerDown(
    event: ReactPointerEvent<SVGLineElement>,
    segmentId: string,
  ) {
    if (measureMode) {
      return
    }

    event.stopPropagation()
    setSelectedTextId(null)
    setSelectedImageId(null)
    setSelectedLineIds((currentIds) =>
      event.shiftKey || event.metaKey || event.ctrlKey
        ? toggleId(currentIds, segmentId)
        : [segmentId],
    )
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!svgRef.current) {
      return
    }

    const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
    if (!pointer) {
      return
    }

    if (measureMode) {
      const snapped = findSnapPoint(pointer)
      if (!snapped) {
        setStatus('Move closer to the model linework to place a measurement point.')
        return
      }

      if (!measurementDraft) {
        setMeasurementDraft(snapped)
        setStatus(
          `Measurement start set at ${formatMillimeters(snapped.x)}, ${formatMillimeters(snapped.y)}.`,
        )
        return
      }

      const measurement: Measurement = {
        id: crypto.randomUUID(),
        start: measurementDraft,
        end: snapped,
        length: distanceBetween(measurementDraft, snapped),
      }

      setMeasurements((currentMeasurements) => [...currentMeasurements, measurement])
      setMeasurementDraft(null)
      setStatus(`Measured ${formatMillimeters(measurement.length)}.`)
      return
    }

    setSelectedLineIds([])
    setSelectedTextId(null)
    setSelectedImageId(null)
  }

  function beginDrag(
    kind: 'text' | 'image',
    id: string,
    x: number,
    y: number,
    event: ReactPointerEvent<SVGGElement>,
  ) {
    if (measureMode || !svgRef.current) {
      return
    }

    const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
    if (!pointer) {
      return
    }

    event.stopPropagation()
    setDragState({
      kind,
      id,
      pointerStart: pointer,
      origin: { x, y },
    })
    setSelectedLineIds([])

    if (kind === 'text') {
      setSelectedTextId(id)
      setSelectedImageId(null)
      return
    }

    setSelectedImageId(id)
    setSelectedTextId(null)
  }

  function handleHideSelectedLines() {
    if (!selectedLineIds.length) {
      return
    }

    setHiddenLineIds((currentIds) => Array.from(new Set([...currentIds, ...selectedLineIds])))
    setSelectedLineIds([])
  }

  function handleUnhideLine(lineId: string) {
    setHiddenLineIds((currentIds) => currentIds.filter((currentId) => currentId !== lineId))
  }

  function handleExport() {
    if (!projection) {
      return
    }

    const baseName = (modelFile?.name ?? 'laser-layout').replace(/\.[^/.]+$/, '')
    const svgMarkup = buildExportSvg(
      projection,
      hiddenLineIds,
      textAnnotations,
      imageAnnotations,
    )
    downloadSvg(`${baseName}-layout.svg`, svgMarkup)
    setStatus('SVG exported.')
  }

  const visibleLineCount = projection ? projection.segments.length - hiddenLineIds.length : 0

  return (
    <div className="app-shell">
      <aside className="left-rail panel">
        <div className="panel-block hero-block">
          <p className="eyebrow">Laser Alignment</p>
          <h1>SVG Layout Studio</h1>
          <p className="intro-copy">
            Upload an STL or STEP model, hide linework you do not want, then place
            text and images precisely on a live millimeter grid.
          </p>
        </div>

        <div className="panel-block">
          <div className="section-head">
            <h2>Model</h2>
            {isLoadingProjection ? <span className="badge">Projecting</span> : null}
          </div>
          <label className="upload-card">
            <span>{modelFile ? modelFile.name : 'Choose STL or STEP file'}</span>
            <input
              type="file"
              accept=".stl,.step,.stp"
              onChange={handleModelFileChange}
            />
          </label>

          <div className="field-grid two-up">
            <label>
              <span>Face</span>
              <select
                value={orientation}
                onChange={(event) => setOrientation(event.target.value as Orientation)}
              >
                {ORIENTATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Page rotation</span>
              <select
                value={pageRotation}
                onChange={(event) => setPageRotation(Number(event.target.value))}
              >
                {PAGE_ROTATIONS.map((rotation) => (
                  <option key={rotation} value={rotation}>
                    {rotation} deg
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="stat-grid">
            <div>
              <span>Width</span>
              <strong>{projection ? formatMillimeters(projection.width) : '-'}</strong>
            </div>
            <div>
              <span>Height</span>
              <strong>{projection ? formatMillimeters(projection.height) : '-'}</strong>
            </div>
            <div>
              <span>Visible lines</span>
              <strong>{projection ? visibleLineCount : '-'}</strong>
            </div>
            <div>
              <span>Hidden lines</span>
              <strong>{hiddenLineIds.length}</strong>
            </div>
          </div>

          <div className="button-row compact">
            <button type="button" onClick={handleExport} disabled={!projection}>
              Export SVG
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setHiddenLineIds([])}
              disabled={!hiddenLineIds.length}
            >
              Show all lines
            </button>
          </div>
        </div>

        <div className="panel-block">
          <div className="section-head">
            <h2>Line Control</h2>
            <span className="badge subtle">Shift-click to multi-select</span>
          </div>

          <div className="button-row compact">
            <button
              type="button"
              onClick={handleHideSelectedLines}
              disabled={!selectedLineIds.length}
            >
              Hide selected
            </button>
            <label className="toggle-pill">
              <input
                type="checkbox"
                checked={showHiddenGhosts}
                onChange={(event) => setShowHiddenGhosts(event.target.checked)}
              />
              <span>Show hidden ghosts</span>
            </label>
          </div>

          <div className="mini-list">
            <div className="mini-list-head">Selected lines</div>
            {selectedSegments.length ? (
              selectedSegments.map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  className="line-chip active"
                  onClick={() =>
                    setSelectedLineIds((currentIds) =>
                      currentIds.filter((currentId) => currentId !== segment.id),
                    )
                  }
                >
                  <span>{segment.id}</span>
                  <small>{formatMillimeters(segment.length)}</small>
                </button>
              ))
            ) : (
              <p className="empty-copy">Click any preview line to select it.</p>
            )}
          </div>

          <div className="mini-list">
            <div className="mini-list-head">Hidden lines</div>
            {hiddenSegments.length ? (
              hiddenSegments.map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  className="line-chip hidden"
                  onClick={() => handleUnhideLine(segment.id)}
                >
                  <span>{segment.id}</span>
                  <small>Restore</small>
                </button>
              ))
            ) : (
              <p className="empty-copy">Hidden lines stay out of the export.</p>
            )}
          </div>
        </div>
      </aside>

      <main className="center-stage panel">
        <div className="stage-toolbar">
          <div>
            <p className="eyebrow">Interactive Preview</p>
            <h2>Drag text and images directly on the grid</h2>
          </div>
          <div className="toolbar-actions">
            <button
              type="button"
              className={measureMode ? 'accent' : 'secondary'}
              onClick={() => {
                setMeasureMode((currentMode) => !currentMode)
                setMeasurementDraft(null)
              }}
              disabled={!projection}
            >
              {measureMode ? 'Stop Measure' : 'Measure'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMeasurements([])
                setMeasurementDraft(null)
              }}
              disabled={!measurements.length && !measurementDraft}
            >
              Clear Measure
            </button>
          </div>
        </div>

        <div className="preview-frame">
          {projection ? (
            <svg
              ref={svgRef}
              className={measureMode ? 'preview-canvas measure-mode' : 'preview-canvas'}
              viewBox={`0 0 ${projection.width} ${projection.height}`}
              onPointerDown={handleCanvasPointerDown}
            >
              <defs>
                <pattern id="minorGrid" width="1" height="1" patternUnits="userSpaceOnUse">
                  <path d="M 1 0 L 0 0 0 1" fill="none" className="grid-minor" />
                </pattern>
                <pattern id="majorGrid" width="5" height="5" patternUnits="userSpaceOnUse">
                  <rect width="5" height="5" fill="url(#minorGrid)" />
                  <path d="M 5 0 L 0 0 0 5" fill="none" className="grid-major" />
                </pattern>
              </defs>

              <rect width={projection.width} height={projection.height} fill="url(#majorGrid)" />

              <g className="segment-layer">
                {projection.segments.map((segment) => {
                  const hidden = hiddenLineIdSet.has(segment.id)
                  if (hidden && !showHiddenGhosts) {
                    return null
                  }

                  const selected = selectedLineIds.includes(segment.id)
                  const className = hidden
                    ? 'segment-line hidden'
                    : selected
                      ? 'segment-line selected'
                      : 'segment-line'

                  return (
                    <line
                      key={segment.id}
                      x1={segment.start[0]}
                      y1={segment.start[1]}
                      x2={segment.end[0]}
                      y2={segment.end[1]}
                      className={className}
                      onPointerDown={(event) => handleLinePointerDown(event, segment.id)}
                    />
                  )
                })}
              </g>

              <g className="image-layer">
                {imageAnnotations
                  .filter((annotation) => annotation.visible)
                  .map((annotation) => {
                    const selected = selectedImageId === annotation.id
                    return (
                      <g
                        key={annotation.id}
                        transform={`translate(${annotation.x} ${annotation.y}) rotate(${annotation.rotation})`}
                        onPointerDown={(event) =>
                          beginDrag('image', annotation.id, annotation.x, annotation.y, event)
                        }
                      >
                        <image
                          href={annotation.dataUrl}
                          x={0}
                          y={0}
                          width={annotation.width}
                          height={annotation.height}
                          opacity={annotation.opacity}
                          preserveAspectRatio="none"
                        />
                        <rect
                          x={0}
                          y={0}
                          width={annotation.width}
                          height={annotation.height}
                          className={selected ? 'annotation-box selected' : 'annotation-box'}
                        />
                      </g>
                    )
                  })}
              </g>

              <g className="text-layer">
                {textAnnotations
                  .filter((annotation) => annotation.visible && annotation.pathData)
                  .map((annotation) => {
                    const selected = selectedTextId === annotation.id
                    return (
                      <g
                        key={annotation.id}
                        transform={`translate(${annotation.x} ${annotation.y}) rotate(${annotation.rotation})`}
                        onPointerDown={(event) =>
                          beginDrag('text', annotation.id, annotation.x, annotation.y, event)
                        }
                      >
                        <path d={annotation.pathData} className="text-outline" />
                        <rect
                          x={0}
                          y={0}
                          width={Math.max(annotation.width, 0.5)}
                          height={Math.max(annotation.height, 0.5)}
                          className={selected ? 'annotation-box selected' : 'annotation-box'}
                        />
                      </g>
                    )
                  })}
              </g>

              <g className="measurement-layer">
                {measurementDraft ? (
                  <circle cx={measurementDraft.x} cy={measurementDraft.y} r={0.4} className="measure-point" />
                ) : null}
                {measurements.map((measurement) => {
                  const midX = (measurement.start.x + measurement.end.x) / 2
                  const midY = (measurement.start.y + measurement.end.y) / 2
                  return (
                    <g key={measurement.id}>
                      <line
                        x1={measurement.start.x}
                        y1={measurement.start.y}
                        x2={measurement.end.x}
                        y2={measurement.end.y}
                        className="measure-line"
                      />
                      <text x={midX} y={midY - 0.6} className="measure-label">
                        {measurement.length.toFixed(3)} mm
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
          ) : (
            <div className="empty-stage">
              <p>Upload a model file to render the live SVG editor.</p>
              <span>The preview grid and drag handles appear as soon as the model is projected.</span>
            </div>
          )}
        </div>

        <div className="status-strip">
          <span>{status}</span>
          {error ? <strong>{error}</strong> : null}
        </div>
      </main>

      <aside className="right-rail panel">
        <div className="panel-block">
          <div className="section-head">
            <h2>Text</h2>
            <div className="button-row compact">
              <button type="button" onClick={() => void handleAddText()}>
                Add text
              </button>
              <button
                type="button"
                className="secondary"
                onClick={handleRemoveText}
                disabled={!selectedText}
              >
                Remove
              </button>
            </div>
          </div>

          <div className="annotation-list">
            {textAnnotations.length ? (
              textAnnotations.map((annotation) => (
                <button
                  key={annotation.id}
                  type="button"
                  className={
                    selectedTextId === annotation.id
                      ? 'annotation-pill active'
                      : 'annotation-pill'
                  }
                  onClick={() => {
                    setSelectedTextId(annotation.id)
                    setSelectedImageId(null)
                    setSelectedLineIds([])
                  }}
                >
                  <span>{annotation.name}</span>
                  <small>{annotation.content}</small>
                </button>
              ))
            ) : (
              <p className="empty-copy">
                Text outlines come from the backend font engine so export stays exact.
              </p>
            )}
          </div>

          {selectedText ? (
            <div className="field-grid">
              <label>
                <span>Content</span>
                <textarea
                  value={selectedText.content}
                  rows={3}
                  onChange={(event) => updateSelectedText({ content: event.target.value })}
                />
              </label>
              <label>
                <span>Font</span>
                <select
                  value={selectedText.fontFamily}
                  onChange={(event) => updateSelectedText({ fontFamily: event.target.value })}
                >
                  {fonts.map((fontFamily) => (
                    <option key={fontFamily} value={fontFamily}>
                      {fontFamily}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-grid two-up">
                <label>
                  <span>Size</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedText.sizeMm}
                    onChange={(event) =>
                      updateSelectedText({ sizeMm: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>Rotation</span>
                  <input
                    type="number"
                    step="1"
                    value={selectedText.rotation}
                    onChange={(event) =>
                      updateSelectedText({ rotation: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <div className="field-grid two-up">
                <label>
                  <span>X</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedText.x}
                    onChange={(event) => updateSelectedText({ x: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>Y</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedText.y}
                    onChange={(event) => updateSelectedText({ y: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label className="toggle-pill">
                <input
                  type="checkbox"
                  checked={selectedText.visible}
                  onChange={(event) => updateSelectedText({ visible: event.target.checked })}
                />
                <span>Include in export</span>
              </label>
            </div>
          ) : null}
        </div>

        <div className="panel-block">
          <div className="section-head">
            <h2>Images</h2>
            <button
              type="button"
              className="secondary"
              onClick={handleRemoveImage}
              disabled={!selectedImage}
            >
              Remove
            </button>
          </div>

          <label className="upload-card secondary-card">
            <span>Import PNG, JPG, or SVG</span>
            <input type="file" accept="image/*,.svg" onChange={handleImageFileChange} />
          </label>

          <div className="annotation-list compact-list">
            {imageAnnotations.length ? (
              imageAnnotations.map((annotation) => (
                <button
                  key={annotation.id}
                  type="button"
                  className={
                    selectedImageId === annotation.id
                      ? 'annotation-pill active'
                      : 'annotation-pill'
                  }
                  onClick={() => {
                    setSelectedImageId(annotation.id)
                    setSelectedTextId(null)
                    setSelectedLineIds([])
                  }}
                >
                  <span>{annotation.name}</span>
                  <small>
                    {annotation.width.toFixed(1)} x {annotation.height.toFixed(1)} mm
                  </small>
                </button>
              ))
            ) : (
              <p className="empty-copy">
                Imported images are draggable and stay embedded in the exported SVG.
              </p>
            )}
          </div>

          {selectedImage ? (
            <div className="field-grid">
              <div className="field-grid two-up">
                <label>
                  <span>X</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedImage.x}
                    onChange={(event) => updateSelectedImage({ x: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>Y</span>
                  <input
                    type="number"
                    step="0.1"
                    value={selectedImage.y}
                    onChange={(event) => updateSelectedImage({ y: Number(event.target.value) })}
                  />
                </label>
              </div>
              <div className="field-grid two-up">
                <label>
                  <span>Width</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedImage.width}
                    onChange={(event) => updateSelectedImage({ width: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>Height</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedImage.height}
                    onChange={(event) => updateSelectedImage({ height: Number(event.target.value) })}
                  />
                </label>
              </div>
              <div className="field-grid two-up">
                <label>
                  <span>Rotation</span>
                  <input
                    type="number"
                    step="1"
                    value={selectedImage.rotation}
                    onChange={(event) =>
                      updateSelectedImage({ rotation: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>Opacity</span>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selectedImage.opacity}
                    onChange={(event) =>
                      updateSelectedImage({ opacity: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <label className="toggle-pill">
                <input
                  type="checkbox"
                  checked={selectedImage.visible}
                  onChange={(event) => updateSelectedImage({ visible: event.target.checked })}
                />
                <span>Include in export</span>
              </label>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

export default App
