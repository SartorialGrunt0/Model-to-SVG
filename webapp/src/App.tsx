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
import {
  buildContinuousLineGroups,
  buildImageSnapGuides,
  findBestSnapGuide,
  type LineGroup,
  type SnapGuide,
  type SnapHit,
} from './previewGeometry'
import { buildExportSvg, downloadSvg } from './svgExport'
import type {
  ImageAnnotation,
  Measurement,
  ModelEntry,
  Orientation,
  Point,
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

const DEFAULT_CANVAS_SIZE = 100
const CANVAS_PADDING = 10
const TEXT_RESIZE_SENSITIVITY = 20

function computeCanvasBounds(models: ModelEntry[]): { width: number; height: number } {
  let maxX = DEFAULT_CANVAS_SIZE
  let maxY = DEFAULT_CANVAS_SIZE
  for (const model of models) {
    if (!model.projection) continue
    const right = model.x + model.projection.width * model.scale
    const bottom = model.y + model.projection.height * model.scale
    if (right > maxX) maxX = right
    if (bottom > maxY) maxY = bottom
  }
  return { width: maxX + CANVAS_PADDING, height: maxY + CANVAS_PADDING }
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
  const [fillMode, setFillMode] = useState(false)
  const [measurementDraft, setMeasurementDraft] = useState<Point | null>(null)
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [hoverSnap, setHoverSnap] = useState<SnapHit | null>(null)
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

  const lineGroupsByModel = new Map<string, LineGroup[]>()
  const lineGroupBySegmentId = new Map<string, LineGroup>()
  const modelSnapGuides: SnapGuide[] = []

  for (const model of models) {
    if (!model.projection) continue

    const lineGroups = buildContinuousLineGroups(model.projection.segments)
    const hiddenSet = new Set(model.hiddenLineIds)
    lineGroupsByModel.set(model.id, lineGroups)

    for (const lineGroup of lineGroups) {
      for (const segment of lineGroup.segments) {
        lineGroupBySegmentId.set(segment.id, lineGroup)
        if (hiddenSet.has(segment.id)) {
          continue
        }

        const start = {
          x: segment.start[0] * model.scale + model.x,
          y: segment.start[1] * model.scale + model.y,
        }
        const end = {
          x: segment.end[0] * model.scale + model.x,
          y: segment.end[1] * model.scale + model.y,
        }

        modelSnapGuides.push(
          {
            id: `${model.id}-${segment.id}`,
            kind: 'segment',
            label: `${model.name} ${lineGroup.label}`,
            start,
            end,
            source: 'model',
          },
          {
            id: `${model.id}-${segment.id}-start`,
            kind: 'point',
            label: `${model.name} ${lineGroup.label} start`,
            point: start,
            source: 'model',
          },
          {
            id: `${model.id}-${segment.id}-end`,
            kind: 'point',
            label: `${model.name} ${lineGroup.label} end`,
            point: end,
            source: 'model',
          },
          {
            id: `${model.id}-${segment.id}-mid`,
            kind: 'point',
            label: `${model.name} ${lineGroup.label} midpoint`,
            point: {
              x: (start.x + end.x) / 2,
              y: (start.y + end.y) / 2,
            },
            source: 'model',
          },
        )
      }
    }
  }

  const measurementSnapGuides = [...modelSnapGuides, ...buildImageSnapGuides(imageAnnotations)]

  function findSnapHit(point: Point, guides: SnapGuide[]): SnapHit | null {
    if (!svgRef.current) {
      return null
    }

    const tolerance = getSnapToleranceMm(svgRef.current, canvasBounds.width)
    return findBestSnapGuide(point, guides, tolerance)
  }

  function findModelSnapPoint(point: Point): Point | null {
    return findSnapHit(point, modelSnapGuides)?.point ?? null
  }

  function findMeasurementSnapHit(point: Point): SnapHit | null {
    return findSnapHit(point, measurementSnapGuides)
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
              ? {
                  ...m,
                  projection: nextProjection,
                  hiddenLineIds: [],
                  selectedLineIds: [],
                  filledPolygonIds: [],
                }
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

  useEffect(() => {
    if (!measureMode) {
      setHoverSnap(null)
    }
  }, [measureMode])

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
        const scaleFactor = Math.max(0.1, 1 + delta / TEXT_RESIZE_SENSITIVITY)
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

    const snapped = findModelSnapPoint(nextPoint)
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
        filledPolygonIds: [],
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
        'Added a text annotation. Use the center drag handle in the preview or refine the coordinates in the sidebar.',
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
        `Added image ${file.name}. Use the center drag handle in the preview or edit its exact position in the sidebar.`,
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
    if (measureMode || fillMode) {
      return
    }

    const lineGroup = lineGroupBySegmentId.get(segmentId)
    if (!lineGroup) {
      return
    }

    event.stopPropagation()
    setSelectedTextId(null)
    setSelectedImageId(null)
    setSelectedModelId(modelId)

    setModels((current) =>
      current.map((m) => {
        if (m.id !== modelId) return m

        const selectedIds = new Set(m.selectedLineIds)
        const groupAlreadySelected = lineGroup.segmentIds.every((id) => selectedIds.has(id))

        if (event.shiftKey || event.metaKey || event.ctrlKey) {
          for (const id of lineGroup.segmentIds) {
            if (groupAlreadySelected) {
              selectedIds.delete(id)
            } else {
              selectedIds.add(id)
            }
          }

          return { ...m, selectedLineIds: Array.from(selectedIds) }
        }

        return { ...m, selectedLineIds: [...lineGroup.segmentIds] }
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
      const snapHit = findMeasurementSnapHit(pointer)
      if (!snapHit) {
        setStatus('Move closer to model linework, an image edge, or an image center guide to place a measurement point.')
        return
      }

      if (!measurementDraft) {
        setMeasurementDraft(snapHit.point)
        setStatus(
          `Measurement start set on ${snapHit.guide.label} at ${formatMillimeters(snapHit.point.x)}, ${formatMillimeters(snapHit.point.y)}.`,
        )
        return
      }

      const measurement: Measurement = {
        id: crypto.randomUUID(),
        start: measurementDraft,
        end: snapHit.point,
        length: distanceBetween(measurementDraft, snapHit.point),
      }

      setMeasurements((currentMeasurements) => [...currentMeasurements, measurement])
      setMeasurementDraft(null)
      setStatus(`Measured ${formatMillimeters(measurement.length)}.`)
      return
    }

    if (fillMode) {
      setStatus('Fill tool is active. Click inside a closed area to toggle fill.')
      return
    }

    setModels((current) => current.map((m) => ({ ...m, selectedLineIds: [] })))
    setSelectedTextId(null)
    setSelectedImageId(null)
    setSelectedModelId(null)
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!measureMode || !svgRef.current || dragState || resizeState) {
      return
    }

    const pointer = clientPointToSvg(svgRef.current, event.clientX, event.clientY)
    if (!pointer) {
      setHoverSnap(null)
      return
    }

    setHoverSnap(findMeasurementSnapHit(pointer))
  }

  function beginDrag(
    kind: 'text' | 'image' | 'model',
    id: string,
    x: number,
    y: number,
    event: ReactPointerEvent<SVGElement>,
  ) {
    if (measureMode || fillMode || !svgRef.current) {
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
    if (measureMode || fillMode || !svgRef.current) return

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

  function handleUnhideLine(modelId: string, lineIds: string[]) {
    setModels((current) =>
      current.map((m) => {
        if (m.id !== modelId) return m
        return {
          ...m,
          hiddenLineIds: m.hiddenLineIds.filter((id) => !lineIds.includes(id)),
        }
      }),
    )
  }

  function handlePolygonPointerDown(
    event: ReactPointerEvent<SVGPathElement>,
    modelId: string,
    polygonId: string,
  ) {
    if (!fillMode) {
      return
    }

    event.stopPropagation()

    const wasFilled =
      models.find((model) => model.id === modelId)?.filledPolygonIds.includes(polygonId) ?? false

    setSelectedModelId(modelId)
    setSelectedTextId(null)
    setSelectedImageId(null)
    setModels((current) =>
      current.map((model) => {
        if (model.id !== modelId) {
          return model
        }

        return {
          ...model,
          filledPolygonIds: wasFilled
            ? model.filledPolygonIds.filter((id) => id !== polygonId)
            : [...model.filledPolygonIds, polygonId],
        }
      }),
    )
    setStatus(wasFilled ? 'Removed fill from the selected closed area.' : 'Filled the selected closed area.')
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

  const totalVisibleLines = models.reduce((sum, model) => {
    const lineGroups = lineGroupsByModel.get(model.id) ?? []
    const hiddenSet = new Set(model.hiddenLineIds)
    return sum + lineGroups.filter((lineGroup) => !lineGroup.segmentIds.every((id) => hiddenSet.has(id))).length
  }, 0)
  const totalHiddenLines = models.reduce((sum, model) => {
    const lineGroups = lineGroupsByModel.get(model.id) ?? []
    const hiddenSet = new Set(model.hiddenLineIds)
    return sum + lineGroups.filter((lineGroup) => lineGroup.segmentIds.every((id) => hiddenSet.has(id))).length
  }, 0)

  const selectedModelLineGroups = selectedModel
    ? lineGroupsByModel.get(selectedModel.id) ?? []
    : []
  const selectedModelSelectedGroups = selectedModel
    ? selectedModelLineGroups.filter((lineGroup) =>
        lineGroup.segmentIds.every((id) => selectedModel.selectedLineIds.includes(id)),
      )
    : []
  const selectedModelHiddenGroups = selectedModel
    ? selectedModelLineGroups.filter((lineGroup) =>
        lineGroup.segmentIds.every((id) => selectedModel.hiddenLineIds.includes(id)),
      )
    : []

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
                  <span>Orthographic view</span>
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

              <details className="advanced-control">
                <summary>Advanced projection</summary>
                <p className="control-note">
                  For exact laser-ready SVG output, keep perspective at 0 mm. Non-zero
                  perspective is preview-only and will not match a drawing-grade orthographic
                  export.
                </p>
                <div className="field-grid">
                  <label>
                    <span>Perspective distance in mm (0 = exact orthographic, +/- allowed)</span>
                    <div className="slider-row">
                      <input
                        type="range"
                        min="-2000"
                        max="2000"
                        step="5"
                        value={selectedModel.perspectiveDistance}
                        onChange={(event) =>
                          handleModelSettingChange(selectedModel.id, {
                            perspectiveDistance: Number(event.target.value),
                          })
                        }
                      />
                      <input
                        type="number"
                        step="1"
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
              </details>

              {selectedModel.perspectiveDistance !== 0 ? (
                <p className="control-note warning">
                  Perspective is active. Exported geometry will not be a true 1:1 orthographic
                  drawing.
                </p>
              ) : null}

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

              <div className="field-grid">
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
                <div>
                  <span>Filled areas</span>
                  <strong>{selectedModel.filledPolygonIds.length}</strong>
                </div>
              </div>

              <div className="button-row compact">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => updateModel(selectedModel.id, { filledPolygonIds: [] })}
                  disabled={!selectedModel.filledPolygonIds.length}
                >
                  Clear fills
                </button>
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
              <span>Visible paths</span>
              <strong>{totalVisibleLines}</strong>
            </div>
            <div>
              <span>Hidden paths</span>
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
                setModels((current) =>
                  current.map((m) => ({ ...m, hiddenLineIds: [], selectedLineIds: [] })),
                )
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
              <span className="badge subtle">Shift-click to multi-select paths</span>
            </div>

            <div className="button-row compact">
              <button
                type="button"
                onClick={() => handleHideSelectedLines(selectedModel.id)}
                disabled={!selectedModelSelectedGroups.length}
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
              <div className="mini-list-head">Selected paths</div>
              {selectedModelSelectedGroups.length ? (
                selectedModelSelectedGroups.map((lineGroup) => (
                  <button
                    key={lineGroup.id}
                    type="button"
                    className="line-chip active"
                    onClick={() =>
                      updateModel(selectedModel.id, {
                        selectedLineIds: selectedModel.selectedLineIds.filter(
                          (id) => !lineGroup.segmentIds.includes(id),
                        ),
                      })
                    }
                  >
                    <span>{lineGroup.label}</span>
                    <small>{formatMillimeters(lineGroup.length)}</small>
                  </button>
                ))
              ) : (
                <p className="empty-copy">Click any preview line to select its full continuous path.</p>
              )}
            </div>

            <div className="mini-list">
              <div className="mini-list-head">Hidden paths</div>
              {selectedModelHiddenGroups.length ? (
                selectedModelHiddenGroups.map((lineGroup) => (
                  <button
                    key={lineGroup.id}
                    type="button"
                    className="line-chip hidden"
                    onClick={() => handleUnhideLine(selectedModel.id, lineGroup.segmentIds)}
                  >
                    <span>{lineGroup.label}</span>
                    <small>Restore</small>
                  </button>
                ))
              ) : (
                <p className="empty-copy">Hidden paths stay out of the export.</p>
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
                const nextMeasureMode = !measureMode
                setMeasureMode(nextMeasureMode)
                setFillMode(false)
                setMeasurementDraft(null)
                setHoverSnap(null)
                if (nextMeasureMode) {
                  setStatus('Measure tool active. Click model lines, image edges, or image centers.')
                }
              }}
              disabled={!models.length}
            >
              {measureMode ? 'Stop Measure' : 'Measure'}
            </button>
            <button
              type="button"
              className={fillMode ? 'accent' : 'secondary'}
              onClick={() => {
                const nextFillMode = !fillMode
                setFillMode(nextFillMode)
                setMeasureMode(false)
                setMeasurementDraft(null)
                setHoverSnap(null)
                setStatus(
                  nextFillMode
                    ? 'Fill tool active. Click any closed area to toggle fill.'
                    : 'Fill tool off.',
                )
              }}
              disabled={!models.some((model) => model.projection?.closed_polygons.length)}
            >
              {fillMode ? 'Stop Fill' : 'Fill Tool'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMeasurements([])
                setMeasurementDraft(null)
                setHoverSnap(null)
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
              className={`preview-canvas${measureMode ? ' measure-mode' : ''}${fillMode ? ' fill-mode' : ''}`}
              viewBox={`0 0 ${canvasBounds.width} ${canvasBounds.height}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerLeave={() => setHoverSnap(null)}
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
                const filledSet = new Set(model.filledPolygonIds)
                const isSelected = selectedModelId === model.id

                return (
                  <g
                    key={model.id}
                    transform={`translate(${model.x} ${model.y}) scale(${model.scale})`}
                    className={isSelected ? 'model-group selected' : 'model-group'}
                  >
                    {model.projection.closed_polygons.map((polygon) => (
                      <path
                        key={polygon.id}
                        d={polygonToPathData(polygon.points)}
                        className={filledSet.has(polygon.id) ? 'fill-region filled' : 'fill-region'}
                        onPointerDown={(event) =>
                          handlePolygonPointerDown(event, model.id, polygon.id)
                        }
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
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            setSelectedModelId(model.id)
                            setSelectedTextId(null)
                            setSelectedImageId(null)
                          }}
                        />
                        <rect
                          x={model.projection.width / 2 - 2}
                          y={model.projection.height / 2 - 2}
                          width={4}
                          height={4}
                          className="drag-handle"
                          onPointerDown={(event) =>
                            beginDrag('model', model.id, model.x, model.y, event)
                          }
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
                      >
                        <image
                          href={annotation.dataUrl}
                          x={0}
                          y={0}
                          width={annotation.width}
                          height={annotation.height}
                          opacity={annotation.opacity}
                          preserveAspectRatio="none"
                          pointerEvents="none"
                        />
                        <rect
                          x={0}
                          y={0}
                          width={annotation.width}
                          height={annotation.height}
                          className={selected ? 'annotation-box selected' : 'annotation-box'}
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            setSelectedImageId(annotation.id)
                            setSelectedTextId(null)
                            setSelectedModelId(null)
                          }}
                        />
                        {selected && (
                          <>
                            <rect
                              x={annotation.width / 2 - 2}
                              y={annotation.height / 2 - 2}
                              width={4}
                              height={4}
                              className="drag-handle"
                              onPointerDown={(event) =>
                                beginDrag('image', annotation.id, annotation.x, annotation.y, event)
                              }
                            />
                            <rect
                              x={annotation.width - 1.5}
                              y={annotation.height - 1.5}
                              width={3}
                              height={3}
                              className="resize-handle"
                              onPointerDown={(event) => beginResize('image', annotation.id, event)}
                            />
                          </>
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
                      >
                        <path d={annotation.pathData} className="text-outline" pointerEvents="none" />
                        <rect
                          x={0}
                          y={0}
                          width={Math.max(annotation.width, 0.5)}
                          height={Math.max(annotation.height, 0.5)}
                          className={selected ? 'annotation-box selected' : 'annotation-box'}
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            setSelectedTextId(annotation.id)
                            setSelectedImageId(null)
                            setSelectedModelId(null)
                          }}
                        />
                        {selected && (
                          <>
                            <rect
                              x={Math.max(annotation.width, 0.5) / 2 - 2}
                              y={Math.max(annotation.height, 0.5) / 2 - 2}
                              width={4}
                              height={4}
                              className="drag-handle"
                              onPointerDown={(event) =>
                                beginDrag('text', annotation.id, annotation.x, annotation.y, event)
                              }
                            />
                            <rect
                              x={Math.max(annotation.width, 0.5) - 1.5}
                              y={Math.max(annotation.height, 0.5) - 1.5}
                              width={3}
                              height={3}
                              className="resize-handle"
                              onPointerDown={(event) => beginResize('text', annotation.id, event)}
                            />
                          </>
                        )}
                      </g>
                    )
                  })}
              </g>

              <g className="measurement-layer">
                {hoverSnap?.guide.kind === 'segment' ? (
                  <line
                    x1={hoverSnap.guide.start.x}
                    y1={hoverSnap.guide.start.y}
                    x2={hoverSnap.guide.end.x}
                    y2={hoverSnap.guide.end.y}
                    className="snap-guide-line"
                  />
                ) : null}
                {hoverSnap ? (
                  <circle cx={hoverSnap.point.x} cy={hoverSnap.point.y} r={0.55} className="snap-guide-point" />
                ) : null}
                {measurementDraft && hoverSnap ? (
                  <line
                    x1={measurementDraft.x}
                    y1={measurementDraft.y}
                    x2={hoverSnap.point.x}
                    y2={hoverSnap.point.y}
                    className="measure-preview-line"
                  />
                ) : null}
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
