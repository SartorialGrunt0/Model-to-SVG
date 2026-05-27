from __future__ import annotations

import math
from typing import Sequence

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPen, QWheelEvent
from PySide6.QtWidgets import (
    QGraphicsPathItem,
    QGraphicsScene,
    QGraphicsSimpleTextItem,
    QGraphicsView,
)

from .document import CanvasProjection, Measurement, TextAnnotation, build_line_path, build_text_path


class CanvasView(QGraphicsView):
    pointHovered = Signal(QPointF)
    pointSelected = Signal(QPointF)
    measurePointPicked = Signal(QPointF)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self._projection: CanvasProjection | None = None
        self._measure_mode = False
        self._measurement_labels: list[QGraphicsSimpleTextItem] = []

        self._model_item = QGraphicsPathItem()
        self._text_item = QGraphicsPathItem()
        self._measurement_item = QGraphicsPathItem()

        self._scene.addItem(self._model_item)
        self._scene.addItem(self._text_item)
        self._scene.addItem(self._measurement_item)
        self.setScene(self._scene)

        self._configure_item_styles()
        self.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.TextAntialiasing)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        self.setMouseTracking(True)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)

    def set_projection(self, projection: CanvasProjection | None) -> None:
        self._projection = projection
        if projection is None:
            self._model_item.setPath(QPainterPath())
            self._scene.setSceneRect(QRectF())
            return

        self._model_item.setPath(build_line_path(projection.segments))
        self._scene.setSceneRect(QRectF(0.0, 0.0, projection.width, projection.height))
        self.fitInView(self._scene.sceneRect().adjusted(-5.0, -5.0, 5.0, 5.0), Qt.AspectRatioMode.KeepAspectRatio)

    def set_annotations(self, annotations: Sequence[TextAnnotation]) -> None:
        path = QPainterPath()
        for annotation in annotations:
            path.addPath(build_text_path(annotation))
        self._text_item.setPath(path)

    def set_measurements(self, measurements: Sequence[Measurement]) -> None:
        path = QPainterPath()
        for label in self._measurement_labels:
            self._scene.removeItem(label)
        self._measurement_labels.clear()

        for measurement in measurements:
            path.moveTo(*measurement.start)
            path.lineTo(*measurement.end)

            midpoint = QPointF(
                (measurement.start[0] + measurement.end[0]) / 2.0,
                (measurement.start[1] + measurement.end[1]) / 2.0,
            )
            label = QGraphicsSimpleTextItem(f"{measurement.length:.3f} mm")
            label.setBrush(QColor("#1d4ed8"))
            label.setFlag(QGraphicsSimpleTextItem.GraphicsItemFlag.ItemIgnoresTransformations)
            label.setPos(midpoint + QPointF(3.0, -14.0))
            self._scene.addItem(label)
            self._measurement_labels.append(label)

        self._measurement_item.setPath(path)

    def set_measure_mode(self, enabled: bool) -> None:
        self._measure_mode = enabled
        cursor = Qt.CursorShape.CrossCursor if enabled else Qt.CursorShape.ArrowCursor
        self.setCursor(cursor)

    def scene_tolerance_from_pixels(self, pixels: float) -> float:
        left = self.mapToScene(QPoint(0, 0))
        right = self.mapToScene(QPoint(int(pixels), 0))
        return max(abs(right.x() - left.x()), 0.25)

    def drawBackground(self, painter: QPainter, rect: QRectF) -> None:
        painter.fillRect(rect, QColor("#fbfbfb"))

        minor_step = 5.0
        major_ratio = 2
        minor_pen = QPen(QColor("#ededed"), 0.0)
        major_pen = QPen(QColor("#d8d8d8"), 0.0)

        start_column = int(math.floor(rect.left() / minor_step))
        end_column = int(math.ceil(rect.right() / minor_step))
        start_row = int(math.floor(rect.top() / minor_step))
        end_row = int(math.ceil(rect.bottom() / minor_step))

        for column in range(start_column, end_column + 1):
            x = column * minor_step
            painter.setPen(major_pen if column % major_ratio == 0 else minor_pen)
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

        for row in range(start_row, end_row + 1):
            y = row * minor_step
            painter.setPen(major_pen if row % major_ratio == 0 else minor_pen)
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))

    def mouseMoveEvent(self, event) -> None:
        self.pointHovered.emit(self.mapToScene(event.position().toPoint()))
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            scene_point = self.mapToScene(event.position().toPoint())
            if self._measure_mode:
                self.measurePointPicked.emit(scene_point)
            else:
                self.pointSelected.emit(scene_point)
        super().mousePressEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1.0 / 1.15
        self.scale(factor, factor)

    def _configure_item_styles(self) -> None:
        model_pen = QPen(QColor("black"), 0.2)
        model_pen.setCosmetic(False)
        self._model_item.setPen(model_pen)

        text_pen = QPen(QColor("black"), 0.2)
        text_pen.setCosmetic(False)
        self._text_item.setPen(text_pen)
        self._text_item.setBrush(Qt.BrushStyle.NoBrush)

        measurement_pen = QPen(QColor("#1d4ed8"), 0.18)
        measurement_pen.setCosmetic(False)
        measurement_pen.setStyle(Qt.PenStyle.DashLine)
        self._measurement_item.setPen(measurement_pen)