"""Laser SVG tool package."""

from .document import CanvasProjection, Measurement, TextAnnotation, normalize_projection
from .geometry import ProjectionResult, Segment2D, project_model_outline
from .svg_export import export_canvas_svg, export_projection_svg

__all__ = [
    "CanvasProjection",
    "Measurement",
    "ProjectionResult",
    "Segment2D",
    "TextAnnotation",
    "export_canvas_svg",
    "export_projection_svg",
    "normalize_projection",
    "project_model_outline",
]