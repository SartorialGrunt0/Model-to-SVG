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
  ModelEntry,
  Orientation,
  Point,
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
  kind: 'text' | 'image' | 'model'
  id: string
  pointerStart: Point
  origin: Point
}

type ResizeState = {
  kind: 'text' | 'image' | 'model'
  id: string
  pointerStart: Point
  originalScale: number
  originalWidth: number
  originalHeight: number
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

function getSnapToleranceMm(svg: SVGSVGElement, canvasWidth: number): number {
  const bounds = svg.getBoundingClientRect()
  if (!bounds.width) {
    return 1.25
  }

  const millimetersPerPixel = canvasWidth / bounds.width
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

function polygonToPathData(points: [number, number][]): string {
  if (points.length < 3) return ''
  const parts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(6)} ${p[1].toFixed(6)}`)
  return parts.join(' ') + ' Z'
}

function computeCanvasBounds(models: ModelEntry[]): { width: number; height: number } {
  let maxX = 100
  let maxY = 100
  for (const model of models) {
    if (!model.projection) continue
    const right = model.x + model.projection.width * model.scale
    const bottom = model.y + model.projection.height * model.scale
    if (right > maxX) maxX = right
    if (bottom > maxY) maxY = bottom
  }
  return { width: maxX + 10, height: maxY + 10 }
}

function App() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [fonts, setFonts] = useState<string[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [status, setStatus] = useState('Upload an STL or STEP file to start the editor.')
  const [error, setError] = useState<string | null>(null)
  const [isLoadingProjection, setIsLoadingProjection] = useState(false)
  const [showHiddenGhosts, setShowHiddenGhosts] = useState(true)
  const [textAnnotations, setTextAnnotations] = useState<TextAnnotation[]>([])
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const [imageAnnotations, setImageAnnotations] = useState<ImageAnnotation[]>([])
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [measureMode, setMeasureMode] = useState(false)
  const [measurementDraft, setMeasurementDraft] = useState<Point | null>(null)
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [resizeState, setResizeState] = useState<ResizeState | null>(null)
  const textRequestSequence = useRef(0)

  const selectedModel = models.find((m) => m.id === selectedModelId) ?? null
  const selectedText =
    textAnnotations.find((annotation) => annotation.id === selectedTextId) ?? null
  const selectedImage =
    imageAnnotations.find((annotation) => annotation.id === selectedImageId) ?? null

  const deferredModels = useDeferredValue(models)

  const canvasBounds = computeCanvasBounds(models)

  const allVisibleSegments: Array<{ segment: Segment; modelId: string }> = []
  for (const model of models) {
    if (!model.projection) continue
    const hiddenSet = new Set(model.hiddenLineIds)
    for (const segment of model.projection.segments) {
      if (!hiddenSet.has(segment.id)) {
        allVisibleSegments.push({
          segment: {
            ...segment,
            start: [segment.start[0] * model.scale + model.x, segment.start[1] * model.scale + model.y],
            end: [segment.end[0] * model.scale + model.x, segment.end[1] * model.scale + model.y],
            length: segment.length * model.scale,
          },
          modelId: model.id,
        })
      }
    }
  }

  function findSnapPoint(point: Point): Point | null {
    if (!svgRef.current) {
      return null
    }

    const tolerance = getSnapToleranceMm(svgRef.current, canvasBounds.width)
    let bestPoint: Point | null = null
    let bestDistance = tolerance

    for (const { segment } of allVisibleSegments) {
      const candidate = nearestPointOnSegment(point, segment)
      const candidateDistance = distanceBetween(point, candidate)
      if (candidateDistance <= bestDistance) {
        bestDistance = candidateDistance
        bestPoint = candidate
      }
    }

    return bestPoint
  }

  function updateModel(modelId: string, patch: Partial<ModelEntry>) {
    setModels((current) =>
      current.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
    )
  }

  async function loadProjectionForModel(model: ModelEntry) {
    setIsLoadingProjection(true)
    setError(null)
    setStatus(`Projecting ${model.name}...`)

    try {
      const nextProjection = await fetchProjection(
        model.file,
        model.orientation,
        model.pageRotation,
        model.perspectiveDistance,
      )
      startTransition(() => {
        setModels((current) =>
          current.map((m) =>
            m.id === model.id
              ? { ...m, projection: nextProjection, hiddenLineIds: [], selectedLineIds: [] }
              : m,
          ),
        )
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
  }

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
    if (!svgRef.current) {
      return
    }

    if (resizeState) {
      const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
      if (!pointer) return

      const dx = pointer.x - resizeState.pointerStart.x
      const dy = pointer.y - resizeState.pointerStart.y
      const delta = Math.max(dx, dy)

      if (resizeState.kind === 'model') {
        const model = models.find((m) => m.id === resizeState.id)
        if (!model?.projection) return
        const baseWidth = model.projection.width
        if (baseWidth > 0) {
          const newScale = Math.max(0.1, resizeState.originalScale + delta / baseWidth)
          updateModel(resizeState.id, { scale: newScale })
        }
      } else if (resizeState.kind === 'image') {
        const ratio = resizeState.originalHeight / resizeState.originalWidth
        const newWidth = Math.max(0.5, resizeState.originalWidth + delta)
        updateSelectedImage({ width: newWidth, height: newWidth * ratio })
      } else if (resizeState.kind === 'text') {
        const scaleFactor = Math.max(0.1, 1 + delta / 20)
        const originalAnnotation = textAnnotations.find((a) => a.id === resizeState.id)
        if (originalAnnotation) {
          const newSizeMm = Math.max(0.5, Math.min(200, originalAnnotation.sizeMm * scaleFactor))
          updateSelectedText({ sizeMm: newSizeMm })
        }
      }
      return
    }

    if (!dragState) {
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

    if (dragState.kind === 'model') {
      updateModel(dragState.id, { x: nextPoint.x, y: nextPoint.y })
      return
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
    if (!dragState && !resizeState) {
      return
    }

    const onPointerMove = (event: PointerEvent) => handleDragMove(event)
    const onPointerUp = () => {
      setDragState(null)
      setResizeState(null)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [dragState, resizeState])

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

  function handleModelFilesChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (!files || files.length === 0) return

    const newModels: ModelEntry[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const entry: ModelEntry = {
        id: crypto.randomUUID(),
        name: file.name,
        file,
        orientation: 'top',
        pageRotation: 0,
        perspectiveDistance: 0,
        projection: null,
        hiddenLineIds: [],
        selectedLineIds: [],
        fillEnabled: false,
        x: 0,
        y: 0,
        scale: 1,
      }
      newModels.push(entry)
    }

    setModels((current) => [...current, ...newModels])
    if (newModels.length > 0) {
      setSelectedModelId(newModels[0].id)
    }
    setSelectedTextId(null)
    setSelectedImageId(null)

    for (const entry of newModels) {
      void loadProjectionForModel(entry)
    }

    event.target.value = ''
  }

  function handleRemoveModel(modelId: string) {
    setModels((current) => current.filter((m) => m.id !== modelId))
    if (selectedModelId === modelId) {
      setSelectedModelId(null)
    }
  }

  function handleModelSettingChange(modelId: string, patch: Partial<ModelEntry>) {
    const model = models.find((m) => m.id === modelId)
    if (!model) return

    const updated = { ...model, ...patch }
    updateModel(modelId, patch)

    if (
      patch.orientation !== undefined ||
      patch.pageRotation !== undefined ||
      patch.perspectiveDistance !== undefined
    ) {
      void loadProjectionForModel(updated)
    }
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
      setSelectedModelId(null)
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
      setSelectedModelId(null)
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
    modelId: string,
  ) {
    if (measureMode) {
      return
    }

    event.stopPropagation()
    setSelectedTextId(null)
    setSelectedImageId(null)
    setSelectedModelId(modelId)

    setModels((current) =>
      current.map((m) => {
        if (m.id !== modelId) return m
        const newSelected = event.shiftKey || event.metaKey || event.ctrlKey
          ? toggleId(m.selectedLineIds, segmentId)
          : [segmentId]
        return { ...m, selectedLineIds: newSelected }
      }),
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

    setModels((current) => current.map((m) => ({ ...m, selectedLineIds: [] })))
    setSelectedTextId(null)
    setSelectedImageId(null)
    setSelectedModelId(null)
  }

  function beginDrag(
    kind: 'text' | 'image' | 'model',
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

    if (kind === 'text') {
      setSelectedTextId(id)
      setSelectedImageId(null)
      setSelectedModelId(null)
      return
    }

    if (kind === 'image') {
      setSelectedImageId(id)
      setSelectedTextId(null)
      setSelectedModelId(null)
      return
    }

    setSelectedModelId(id)
    setSelectedTextId(null)
    setSelectedImageId(null)
  }

  function beginResize(
    kind: 'text' | 'image' | 'model',
    id: string,
    event: ReactPointerEvent<SVGRectElement>,
  ) {
    if (measureMode || !svgRef.current) return

    const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
    if (!pointer) return

    event.stopPropagation()

    if (kind === 'model') {
      const model = models.find((m) => m.id === id)
      if (!model) return
      setResizeState({
        kind,
        id,
        pointerStart: pointer,
        originalScale: model.scale,
        originalWidth: model.projection?.width ?? 1,
        originalHeight: model.projection?.height ?? 1,
      })
    } else if (kind === 'image') {
      const img = imageAnnotations.find((a) => a.id === id)
      if (!img) return
      setResizeState({
        kind,
        id,
        pointerStart: pointer,
        originalScale: 1,
        originalWidth: img.width,
        originalHeight: img.height,
      })
      setSelectedImageId(id)
    } else {
      setResizeState({
        kind,
        id,
        pointerStart: pointer,
        originalScale: 1,
        originalWidth: 0,
        originalHeight: 0,
      })
      setSelectedTextId(id)
    }
  }

  function handleHideSelectedLines(modelId: string) {
    setModels((current) =>
      current.map((m) => {
        if (m.id !== modelId || !m.selectedLineIds.length) return m
        return {
          ...m,
          hiddenLineIds: Array.from(new Set([...m.hiddenLineIds, ...m.selectedLineIds])),
          selectedLineIds: [],
        }
      }),
    )
  }

  function handleUnhideLine(modelId: string, lineId: string) {
    setModels((current) =>
      current.map((m) => {
        if (m.id !== modelId) return m
        return { ...m, hiddenLineIds: m.hiddenLineIds.filter((id) => id !== lineId) }
      }),
    )
  }

  function handleExport() {
    if (!models.length) return

    const baseName = models[0]?.name?.replace(/\.[^/.]+$/, '') ?? 'laser-layout'
    const svgMarkup = buildExportSvg(
      models,
      textAnnotations,
      imageAnnotations,
    )
    downloadSvg(`${baseName}-layout.svg`, svgMarkup)
    setStatus('SVG exported.')
  }

  const totalVisibleLines = models.reduce((sum, m) => {
    if (!m.projection) return sum
    return sum + m.projection.segments.length - m.hiddenLineIds.length
  }, 0)
  const totalHiddenLines = models.reduce((sum, m) => sum + m.hiddenLineIds.length, 0)

  const selectedModelSelectedSegments = selectedModel?.projection?.segments.filter(
    (s) => selectedModel.selectedLineIds.includes(s.id),
  ) ?? []
  const selectedModelHiddenSegments = selectedModel?.projection?.segments.filter(
    (s) => selectedModel.hiddenLineIds.includes(s.id),
  ) ?? []

  return (
    <div className="app-shell">
      <aside className="left-rail panel">
        <div className="panel-block hero-block">
          <p className="eyebrow">Laser Alignment</p>
          <h1>SVG Layout Studio</h1>
          <p className="intro-copy">
            Upload STL or STEP models, hide linework you do not want, then place
            text and images precisely on a live millimeter grid.
          </p>
        </div>

        <div className="panel-block">
          <div className="section-head">
            <h2>Models</h2>
            {isLoadingProjection ? <span className="badge">Projecting</span> : null}
          </div>
          <label className="upload-card">
            <span>Choose STL or STEP files</span>
            <input
              type="file"
              accept=".stl,.step,.stp"
              multiple
              onChange={handleModelFilesChange}
            />
          </label>

          <div className="annotation-list">
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                className={
                  selectedModelId === model.id
                    ? 'annotation-pill active'
                    : 'annotation-pill'
                }
                onClick={() => {
                  setSelectedModelId(model.id)
                  setSelectedTextId(null)
                  setSelectedImageId(null)
                }}
              >
                <span>{model.name}</span>
                <small>
                  {model.projection
                    ? `${model.projection.width.toFixed(1)} × ${model.projection.height.toFixed(1)} mm`
                    : 'Loading...'}
                </small>
              </button>
            ))}
            {!models.length && (
              <p className="empty-copy">Upload one or more model files to begin.</p>
            )}
          </div>

          {selectedModel && (
            <>
              <div className="field-grid two-up">
                <label>
                  <span>Face</span>
                  <select
                    value={selectedModel.orientation}
                    onChange={(event) =>
                      handleModelSettingChange(selectedModel.id, {
                        orientation: event.target.value as Orientation,
                      })
                    }
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
                    value={selectedModel.pageRotation}
                    onChange={(event) =>
                      handleModelSettingChange(selectedModel.id, {
                        pageRotation: Number(event.target.value),
                      })
                    }
                  >
                    {PAGE_ROTATIONS.map((rotation) => (
                      <option key={rotation} value={rotation}>
                        {rotation} deg
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="field-grid">
                <label>
                  <span>Perspective distance (0 = orthographic)</span>
                  <div className="slider-row">
                    <input
                      type="range"
                      min="0"
                      max="2000"
                      step="10"
                      value={selectedModel.perspectiveDistance}
                      onChange={(event) =>
                        handleModelSettingChange(selectedModel.id, {
                          perspectiveDistance: Number(event.target.value),
                        })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={selectedModel.perspectiveDistance}
                      className="slider-number"
                      onChange={(event) =>
                        handleModelSettingChange(selectedModel.id, {
                          perspectiveDistance: Number(event.target.value),
                        })
                      }
                    />
                  </div>
                </label>
              </div>

              <div className="field-grid two-up">
                <label>
                  <span>X offset</span>
                  <input
                    type="number"
                    step="0.5"
                    value={selectedModel.x}
                    onChange={(event) =>
                      updateModel(selectedModel.id, { x: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>Y offset</span>
                  <input
                    type="number"
                    step="0.5"
                    value={selectedModel.y}
                    onChange={(event) =>
                      updateModel(selectedModel.id, { y: Number(event.target.value) })
                    }
                  />
                </label>
              </div>

              <div className="field-grid two-up">
                <label>
                  <span>Scale</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={selectedModel.scale}
                    onChange={(event) =>
                      updateModel(selectedModel.id, { scale: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="toggle-pill">
                  <input
                    type="checkbox"
                    checked={selectedModel.fillEnabled}
                    onChange={(event) =>
                      updateModel(selectedModel.id, { fillEnabled: event.target.checked })
                    }
                  />
                  <span>Fill closed areas</span>
                </label>
              </div>

              <div className="stat-grid">
                <div>
                  <span>Width</span>
                  <strong>{selectedModel.projection ? formatMillimeters(selectedModel.projection.width) : '-'}</strong>
                </div>
                <div>
                  <span>Height</span>
                  <strong>{selectedModel.projection ? formatMillimeters(selectedModel.projection.height) : '-'}</strong>
                </div>
              </div>

              <div className="button-row compact">
                <button
                  type="button"
                  className="danger"
                  onClick={() => handleRemoveModel(selectedModel.id)}
                >
                  Remove model
                </button>
              </div>
            </>
          )}

          <div className="stat-grid">
            <div>
              <span>Visible lines</span>
              <strong>{totalVisibleLines}</strong>
            </div>
            <div>
              <span>Hidden lines</span>
              <strong>{totalHiddenLines}</strong>
            </div>
          </div>

          <div className="button-row compact">
            <button type="button" onClick={handleExport} disabled={!models.length}>
              Export SVG
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setModels((current) => current.map((m) => ({ ...m, hiddenLineIds: [] })))
              }
              disabled={!totalHiddenLines}
            >
              Show all lines
            </button>
          </div>
        </div>

        {selectedModel && (
          <div className="panel-block">
            <div className="section-head">
              <h2>Line Control</h2>
              <span className="badge subtle">Shift-click to multi-select</span>
            </div>

            <div className="button-row compact">
              <button
                type="button"
                onClick={() => handleHideSelectedLines(selectedModel.id)}
                disabled={!selectedModel.selectedLineIds.length}
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
              {selectedModelSelectedSegments.length ? (
                selectedModelSelectedSegments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    className="line-chip active"
                    onClick={() =>
                      updateModel(selectedModel.id, {
                        selectedLineIds: selectedModel.selectedLineIds.filter(
                          (id) => id !== segment.id,
                        ),
                      })
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
              {selectedModelHiddenSegments.length ? (
                selectedModelHiddenSegments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    className="line-chip hidden"
                    onClick={() => handleUnhideLine(selectedModel.id, segment.id)}
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
        )}
      </aside>

      <main className="center-stage panel">
        <div className="stage-toolbar">
          <div>
            <p className="eyebrow">Interactive Preview</p>
            <h2>Drag elements directly on the grid</h2>
          </div>
          <div className="toolbar-actions">
            <button
              type="button"
              className={measureMode ? 'accent' : 'secondary'}
              onClick={() => {
                setMeasureMode((currentMode) => !currentMode)
                setMeasurementDraft(null)
              }}
              disabled={!models.length}
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
          {models.length ? (
            <svg
              ref={svgRef}
              className={measureMode ? 'preview-canvas measure-mode' : 'preview-canvas'}
              viewBox={`0 0 ${canvasBounds.width} ${canvasBounds.height}`}
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

              <rect width={canvasBounds.width} height={canvasBounds.height} fill="url(#majorGrid)" />

              {deferredModels.map((model) => {
                if (!model.projection) return null
                const hiddenSet = new Set(model.hiddenLineIds)
                const isSelected = selectedModelId === model.id

                return (
                  <g
                    key={model.id}
                    transform={`translate(${model.x} ${model.y}) scale(${model.scale})`}
                    onPointerDown={(event) =>
                      beginDrag('model', model.id, model.x, model.y, event)
                    }
                    className={isSelected ? 'model-group selected' : 'model-group'}
                  >
                    {model.fillEnabled && model.projection.closed_polygons.map((polygon) => (
                      <path
                        key={polygon.id}
                        d={polygonToPathData(polygon.points)}
                        className="filled-polygon"
                      />
                    ))}
                    {model.projection.segments.map((segment) => {
                      const hidden = hiddenSet.has(segment.id)
                      if (hidden && !showHiddenGhosts) {
                        return null
                      }

                      const selected = model.selectedLineIds.includes(segment.id)
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
                          onPointerDown={(event) =>
                            handleLinePointerDown(event, segment.id, model.id)
                          }
                        />
                      )
                    })}
                    {isSelected && (
                      <>
                        <rect
                          x={0}
                          y={0}
                          width={model.projection.width}
                          height={model.projection.height}
                          className="model-selection-box"
                        />
                        <rect
                          x={model.projection.width - 1.5}
                          y={model.projection.height - 1.5}
                          width={3}
                          height={3}
                          className="resize-handle"
                          onPointerDown={(event) => beginResize('model', model.id, event)}
                        />
                      </>
                    )}
                  </g>
                )
              })}

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
                        {selected && (
                          <rect
                            x={annotation.width - 1.5}
                            y={annotation.height - 1.5}
                            width={3}
                            height={3}
                            className="resize-handle"
                            onPointerDown={(event) => beginResize('image', annotation.id, event)}
                          />
                        )}
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
                        {selected && (
                          <rect
                            x={Math.max(annotation.width, 0.5) - 1.5}
                            y={Math.max(annotation.height, 0.5) - 1.5}
                            width={3}
                            height={3}
                            className="resize-handle"
                            onPointerDown={(event) => beginResize('text', annotation.id, event)}
                          />
                        )}
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
                    setSelectedModelId(null)
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
                    setSelectedModelId(null)
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
