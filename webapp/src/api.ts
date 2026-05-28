import type { Orientation, ProjectionData, TextPathResponse } from './types'

type FontResponse = {
  fonts: string[]
}

function toErrorMessage(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail
  }

  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }
        if (item && typeof item === 'object' && 'msg' in item) {
          return String(item.msg)
        }
        return JSON.stringify(item)
      })
      .join(', ')
  }

  return 'The request failed.'
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const payload = (await response.json().catch(() => null)) as
    | { detail?: unknown }
    | null

  if (!response.ok) {
    throw new Error(toErrorMessage(payload?.detail))
  }

  return payload as T
}

export async function fetchFonts(): Promise<string[]> {
  const response = await requestJson<FontResponse>('/api/fonts')
  return response.fonts
}

export async function fetchProjection(
  file: File,
  orientation: Orientation,
  pageRotation: number,
  perspectiveDistance: number = 0,
): Promise<ProjectionData> {
  const formData = new FormData()
  formData.append('model_file', file)
  formData.append('orientation', orientation)
  formData.append('page_rotation', String(pageRotation))
  formData.append('perspective_distance', String(perspectiveDistance))

  return requestJson<ProjectionData>('/api/project', {
    method: 'POST',
    body: formData,
  })
}

export async function fetchTextPath(
  content: string,
  fontFamily: string,
  sizeMm: number,
): Promise<TextPathResponse> {
  return requestJson<TextPathResponse>('/api/text-path', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      font_family: fontFamily,
      size_mm: sizeMm,
    }),
  })
}