from __future__ import annotations

from pathlib import Path
from typing import Sequence

from PySide6.QtGui import QPainterPath
import svgwrite

from .document import CanvasProjection, TextAnnotation, build_text_path
from .geometry import ProjectionResult


def export_projection_svg(
    projection: ProjectionResult,
    output_path: str | Path,
    stroke_width_mm: float = 0.2,
) -> Path:
    path = Path(output_path)
    width = max(projection.width, 1e-6)
    height = max(projection.height, 1e-6)
    min_x, min_y, _, max_y = projection.bounds

    drawing = svgwrite.Drawing(
        filename=str(path),
        size=(f"{width:.4f}mm", f"{height:.4f}mm"),
        viewBox=f"0 0 {width:.6f} {height:.6f}",
    )
    group = drawing.g(
        fill="none",
        stroke="black",
        stroke_width=stroke_width_mm,
        stroke_linecap="round",
        stroke_linejoin="round",
        style="vector-effect: non-scaling-stroke;",
    )
    drawing.add(group)

    for segment in projection.segments:
        start_x = segment.start[0] - min_x
        start_y = max_y - segment.start[1]
        end_x = segment.end[0] - min_x
        end_y = max_y - segment.end[1]
        group.add(drawing.line(start=(start_x, start_y), end=(end_x, end_y)))

    path.parent.mkdir(parents=True, exist_ok=True)
    drawing.save(pretty=True)
    return path


def export_canvas_svg(
    projection: CanvasProjection,
    annotations: Sequence[TextAnnotation],
    output_path: str | Path,
    stroke_width_mm: float = 0.2,
) -> Path:
    path = Path(output_path)
    drawing = svgwrite.Drawing(
        filename=str(path),
        size=(f"{projection.width:.4f}mm", f"{projection.height:.4f}mm"),
        viewBox=f"0 0 {projection.width:.6f} {projection.height:.6f}",
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    outline_group = drawing.g(
        fill="none",
        stroke="black",
        stroke_width=stroke_width_mm,
        stroke_linecap="round",
        stroke_linejoin="round",
        style="vector-effect: non-scaling-stroke;",
    )
    drawing.add(outline_group)

    for segment in projection.segments:
        outline_group.add(drawing.line(start=segment.start, end=segment.end))

    for annotation in annotations:
        for polygon in build_text_path(annotation).toSubpathPolygons():
            outline_group.add(drawing.path(d=_polygon_to_path_data(polygon), fill="none"))

    drawing.save(pretty=True)
    return path


def _polygon_to_path_data(polygon) -> str:
    if polygon.isEmpty():
        return ""

    commands = [f"M {polygon[0].x():.6f} {polygon[0].y():.6f}"]
    for index in range(1, polygon.count()):
        point = polygon[index]
        commands.append(f"L {point.x():.6f} {point.y():.6f}")
    commands.append("Z")
    return " ".join(commands)