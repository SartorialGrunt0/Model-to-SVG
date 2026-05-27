from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from PySide6.QtGui import QFont, QPainterPath, QTransform

from .geometry import ProjectionResult, Segment2D


POINTS_PER_MILLIMETER = 72.0 / 25.4


@dataclass(frozen=True)
class CanvasProjection:
    source_path: Path
    orientation: str
    units: str
    segments: tuple[Segment2D, ...]
    width: float
    height: float


@dataclass(frozen=True)
class TextAnnotation:
    content: str
    font_family: str
    size_mm: float
    x: float
    y: float
    rotation_degrees: float = 0.0

    def label(self) -> str:
        trimmed = self.content.replace("\n", " ").strip() or "(empty)"
        return f"{trimmed} @ ({self.x:.2f}, {self.y:.2f}) mm"


@dataclass(frozen=True)
class Measurement:
    start: tuple[float, float]
    end: tuple[float, float]

    @property
    def length(self) -> float:
        dx = self.end[0] - self.start[0]
        dy = self.end[1] - self.start[1]
        return (dx * dx + dy * dy) ** 0.5


def normalize_projection(projection: ProjectionResult) -> CanvasProjection:
    min_x, _, _, max_y = projection.bounds
    segments = []
    for segment in projection.segments:
        segments.append(
            Segment2D(
                start=(segment.start[0] - min_x, max_y - segment.start[1]),
                end=(segment.end[0] - min_x, max_y - segment.end[1]),
            )
        )
    return CanvasProjection(
        source_path=projection.source_path,
        orientation=projection.orientation,
        units=projection.units,
        segments=tuple(segments),
        width=projection.width,
        height=projection.height,
    )


def build_line_path(segments: Sequence[Segment2D]) -> QPainterPath:
    path = QPainterPath()
    for segment in segments:
        path.moveTo(*segment.start)
        path.lineTo(*segment.end)
    return path


def build_text_path(annotation: TextAnnotation) -> QPainterPath:
    font = QFont(annotation.font_family)
    font.setPointSizeF(annotation.size_mm * POINTS_PER_MILLIMETER)
    font.setStyleStrategy(QFont.StyleStrategy.PreferOutline)

    path = QPainterPath()
    path.addText(0.0, 0.0, font, annotation.content)
    bounds = path.boundingRect()
    path = QTransform.fromTranslate(-bounds.left(), -bounds.top()).map(path)
    if annotation.rotation_degrees:
        path = QTransform().rotate(annotation.rotation_degrees).map(path)
    return QTransform.fromTranslate(annotation.x, annotation.y).map(path)


def nearest_snap_point(
    point: tuple[float, float],
    segments: Sequence[Segment2D],
    tolerance_mm: float,
) -> tuple[float, float] | None:
    closest_point: tuple[float, float] | None = None
    closest_distance = tolerance_mm
    for segment in segments:
        candidate = _closest_point_on_segment(point, segment)
        dx = candidate[0] - point[0]
        dy = candidate[1] - point[1]
        distance = (dx * dx + dy * dy) ** 0.5
        if distance <= closest_distance:
            closest_distance = distance
            closest_point = candidate
    return closest_point


def _closest_point_on_segment(
    point: tuple[float, float],
    segment: Segment2D,
) -> tuple[float, float]:
    start_x, start_y = segment.start
    end_x, end_y = segment.end
    dx = end_x - start_x
    dy = end_y - start_y
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-12:
        return segment.start

    projection = ((point[0] - start_x) * dx + (point[1] - start_y) * dy) / length_squared
    clamped = max(0.0, min(1.0, projection))
    return (start_x + clamped * dx, start_y + clamped * dy)