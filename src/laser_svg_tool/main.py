from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QDoubleSpinBox,
    QFontComboBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QComboBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .canvas import CanvasView
from .document import Measurement, TextAnnotation, nearest_snap_point, normalize_projection
from .geometry import project_model_outline
from .svg_export import export_canvas_svg


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Laser SVG Tool")
        self.resize(1480, 920)

        self._current_model_path: Path | None = None
        self._canvas_projection = None
        self._text_annotations: list[TextAnnotation] = []
        self._measurements: list[Measurement] = []
        self._pending_measure_point: tuple[float, float] | None = None

        self.canvas = CanvasView(self)
        self.canvas.pointSelected.connect(self._handle_canvas_point_selected)
        self.canvas.measurePointPicked.connect(self._handle_measure_point_picked)
        self.canvas.pointHovered.connect(self._handle_canvas_point_hovered)

        controls = self._build_controls_panel()
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(controls)
        splitter.addWidget(self.canvas)
        splitter.setSizes([360, 1120])

        self.setCentralWidget(splitter)
        self.statusBar().showMessage("Load a model to begin.")
        self._load_first_model_if_present()

    def _build_controls_panel(self) -> QWidget:
        container = QWidget()
        layout = QVBoxLayout(container)
        layout.addWidget(self._build_model_group())
        layout.addWidget(self._build_view_group())
        layout.addWidget(self._build_text_group())
        layout.addWidget(self._build_measure_group())
        layout.addStretch(1)
        return container

    def _build_model_group(self) -> QGroupBox:
        group = QGroupBox("Model")
        layout = QVBoxLayout(group)

        self.model_path_label = QLabel("No model loaded")
        self.model_path_label.setWordWrap(True)

        load_button = QPushButton("Open STL / STEP")
        load_button.clicked.connect(self._open_model)

        export_button = QPushButton("Export SVG")
        export_button.clicked.connect(self._export_svg)

        layout.addWidget(self.model_path_label)
        layout.addWidget(load_button)
        layout.addWidget(export_button)
        return group

    def _build_view_group(self) -> QGroupBox:
        group = QGroupBox("Projection")
        form = QFormLayout(group)

        self.orientation_combo = QComboBox()
        self.orientation_combo.addItem("Top", "top")
        self.orientation_combo.addItem("Bottom", "bottom")
        self.orientation_combo.addItem("Front", "front")
        self.orientation_combo.addItem("Back", "back")
        self.orientation_combo.addItem("Left", "left")
        self.orientation_combo.addItem("Right", "right")
        self.orientation_combo.currentIndexChanged.connect(self._reload_projection)

        self.page_rotation_combo = QComboBox()
        self.page_rotation_combo.addItem("0 deg", 0)
        self.page_rotation_combo.addItem("90 deg", 90)
        self.page_rotation_combo.addItem("180 deg", 180)
        self.page_rotation_combo.addItem("270 deg", 270)
        self.page_rotation_combo.currentIndexChanged.connect(self._reload_projection)

        self.width_label = QLabel("-")
        self.height_label = QLabel("-")

        form.addRow("Face", self.orientation_combo)
        form.addRow("Page rotation", self.page_rotation_combo)
        form.addRow("Width", self.width_label)
        form.addRow("Height", self.height_label)
        return group

    def _build_text_group(self) -> QGroupBox:
        group = QGroupBox("Text")
        layout = QVBoxLayout(group)

        self.text_list = QListWidget()
        self.text_list.currentRowChanged.connect(self._load_selected_text)

        self.text_content_edit = QLineEdit()
        self.text_content_edit.setPlaceholderText("Enter text or symbols")

        self.font_combo = QFontComboBox()
        self.font_combo.setCurrentFont(self.font_combo.currentFont())

        self.text_size_spin = self._make_spin_box(0.5, 200.0, 8.0, " mm")
        self.text_x_spin = self._make_spin_box(-10000.0, 10000.0, 0.0, " mm")
        self.text_y_spin = self._make_spin_box(-10000.0, 10000.0, 0.0, " mm")
        self.text_rotation_spin = self._make_spin_box(-360.0, 360.0, 0.0, " deg")

        form = QFormLayout()
        form.addRow("Content", self.text_content_edit)
        form.addRow("Font", self.font_combo)
        form.addRow("Size", self.text_size_spin)
        form.addRow("X", self.text_x_spin)
        form.addRow("Y", self.text_y_spin)
        form.addRow("Rotation", self.text_rotation_spin)

        hint_label = QLabel("Click the preview to snap X and Y to model geometry.")
        hint_label.setWordWrap(True)

        buttons_row = QHBoxLayout()
        apply_button = QPushButton("Add / Update")
        apply_button.clicked.connect(self._upsert_text_annotation)
        remove_button = QPushButton("Remove Selected")
        remove_button.clicked.connect(self._remove_selected_text)
        buttons_row.addWidget(apply_button)
        buttons_row.addWidget(remove_button)

        layout.addWidget(self.text_list)
        layout.addLayout(form)
        layout.addWidget(hint_label)
        layout.addLayout(buttons_row)
        return group

    def _build_measure_group(self) -> QGroupBox:
        group = QGroupBox("Measure")
        layout = QVBoxLayout(group)

        self.measure_button = QPushButton("Start Measure")
        self.measure_button.setCheckable(True)
        self.measure_button.toggled.connect(self._toggle_measure_mode)

        clear_button = QPushButton("Clear Measurements")
        clear_button.clicked.connect(self._clear_measurements)

        self.measure_label = QLabel("Click two snapped points to measure distance.")
        self.measure_label.setWordWrap(True)

        layout.addWidget(self.measure_button)
        layout.addWidget(clear_button)
        layout.addWidget(self.measure_label)
        return group

    def _make_spin_box(
        self,
        minimum: float,
        maximum: float,
        value: float,
        suffix: str,
    ) -> QDoubleSpinBox:
        spin_box = QDoubleSpinBox()
        spin_box.setDecimals(3)
        spin_box.setRange(minimum, maximum)
        spin_box.setValue(value)
        spin_box.setSuffix(suffix)
        return spin_box

    def _load_first_model_if_present(self) -> None:
        for pattern in ("*.stl", "*.step", "*.stp"):
            match = next(Path.cwd().glob(pattern), None)
            if match is not None:
                self._current_model_path = match
                self._reload_projection()
                return

    def _open_model(self) -> None:
        selected, _ = QFileDialog.getOpenFileName(
            self,
            "Open 3D Model",
            str(Path.cwd()),
            "3D Models (*.stl *.step *.stp)",
        )
        if not selected:
            return
        self._current_model_path = Path(selected)
        self._reload_projection()

    def _reload_projection(self) -> None:
        if self._current_model_path is None:
            return

        try:
            projection = project_model_outline(
                self._current_model_path,
                orientation=str(self.orientation_combo.currentData()),
                page_rotation=int(self.page_rotation_combo.currentData()),
                units="mm",
            )
            self._canvas_projection = normalize_projection(projection)
        except Exception as exc:
            QMessageBox.critical(self, "Projection Error", str(exc))
            self.statusBar().showMessage("Projection failed.")
            return

        self._pending_measure_point = None
        self._measurements.clear()
        self.measure_label.setText("Click two snapped points to measure distance.")
        self.model_path_label.setText(str(self._current_model_path))
        self.width_label.setText(f"{self._canvas_projection.width:.3f} mm")
        self.height_label.setText(f"{self._canvas_projection.height:.3f} mm")
        self.canvas.set_projection(self._canvas_projection)
        self.canvas.set_annotations(self._text_annotations)
        self.canvas.set_measurements(self._measurements)
        self.statusBar().showMessage(
            f"Loaded {self._current_model_path.name} as a {self._canvas_projection.width:.3f} mm x {self._canvas_projection.height:.3f} mm projection."
        )

    def _export_svg(self) -> None:
        if self._canvas_projection is None:
            QMessageBox.information(self, "Export SVG", "Load a model before exporting.")
            return

        default_path = self._current_model_path.with_suffix(".svg") if self._current_model_path else Path("export.svg")
        selected, _ = QFileDialog.getSaveFileName(
            self,
            "Export SVG",
            str(default_path),
            "SVG Files (*.svg)",
        )
        if not selected:
            return

        try:
            output = export_canvas_svg(self._canvas_projection, self._text_annotations, selected)
        except Exception as exc:
            QMessageBox.critical(self, "Export Error", str(exc))
            return

        self.statusBar().showMessage(f"Exported SVG to {output}")

    def _upsert_text_annotation(self) -> None:
        if self._canvas_projection is None:
            QMessageBox.information(self, "Text", "Load a model before adding text.")
            return

        content = self.text_content_edit.text()
        if not content.strip():
            QMessageBox.information(self, "Text", "Enter text or a symbol before adding an annotation.")
            return

        annotation = TextAnnotation(
            content=content,
            font_family=self.font_combo.currentFont().family(),
            size_mm=self.text_size_spin.value(),
            x=self.text_x_spin.value(),
            y=self.text_y_spin.value(),
            rotation_degrees=self.text_rotation_spin.value(),
        )

        row = self.text_list.currentRow()
        if row >= 0:
            self._text_annotations[row] = annotation
        else:
            self._text_annotations.append(annotation)
            row = len(self._text_annotations) - 1

        self._refresh_text_list(selected_row=row)
        self.canvas.set_annotations(self._text_annotations)
        self.statusBar().showMessage(f"Text item ready at ({annotation.x:.3f}, {annotation.y:.3f}) mm")

    def _remove_selected_text(self) -> None:
        row = self.text_list.currentRow()
        if row < 0:
            return
        del self._text_annotations[row]
        self._refresh_text_list(selected_row=min(row, len(self._text_annotations) - 1))
        self.canvas.set_annotations(self._text_annotations)

    def _refresh_text_list(self, selected_row: int | None = None) -> None:
        self.text_list.blockSignals(True)
        self.text_list.clear()
        for annotation in self._text_annotations:
            self.text_list.addItem(annotation.label())
        self.text_list.blockSignals(False)
        if selected_row is not None and selected_row >= 0 and self._text_annotations:
            self.text_list.setCurrentRow(selected_row)
        else:
            self.text_list.setCurrentRow(-1)

    def _load_selected_text(self, row: int) -> None:
        if row < 0 or row >= len(self._text_annotations):
            return
        annotation = self._text_annotations[row]
        self.text_content_edit.setText(annotation.content)
        self.font_combo.setCurrentFont(QFont(annotation.font_family))
        self.text_size_spin.setValue(annotation.size_mm)
        self.text_x_spin.setValue(annotation.x)
        self.text_y_spin.setValue(annotation.y)
        self.text_rotation_spin.setValue(annotation.rotation_degrees)

    def _toggle_measure_mode(self, enabled: bool) -> None:
        self._pending_measure_point = None
        self.measure_button.setText("Stop Measure" if enabled else "Start Measure")
        self.measure_label.setText(
            "Click two snapped points to measure distance." if enabled else "Measure mode is off."
        )
        self.canvas.set_measure_mode(enabled)

    def _clear_measurements(self) -> None:
        self._pending_measure_point = None
        self._measurements.clear()
        self.canvas.set_measurements(self._measurements)
        self.measure_label.setText("Click two snapped points to measure distance.")

    def _handle_canvas_point_selected(self, point: QPointF) -> None:
        snapped = self._snap_canvas_point(point)
        target = snapped if snapped is not None else (point.x(), point.y())
        self.text_x_spin.setValue(target[0])
        self.text_y_spin.setValue(target[1])
        self.statusBar().showMessage(f"Text anchor set to ({target[0]:.3f}, {target[1]:.3f}) mm")

    def _handle_measure_point_picked(self, point: QPointF) -> None:
        snapped = self._snap_canvas_point(point)
        target = snapped if snapped is not None else (point.x(), point.y())

        if self._pending_measure_point is None:
            self._pending_measure_point = target
            self.measure_label.setText(
                f"First point: ({target[0]:.3f}, {target[1]:.3f}) mm. Click the second point."
            )
            return

        measurement = Measurement(start=self._pending_measure_point, end=target)
        self._measurements.append(measurement)
        self._pending_measure_point = None
        self.canvas.set_measurements(self._measurements)
        self.measure_label.setText(f"Last distance: {measurement.length:.3f} mm")
        self.statusBar().showMessage(f"Measured {measurement.length:.3f} mm")

    def _handle_canvas_point_hovered(self, point: QPointF) -> None:
        snapped = self._snap_canvas_point(point)
        if snapped is None:
            self.statusBar().showMessage(f"Cursor: ({point.x():.3f}, {point.y():.3f}) mm")
            return
        self.statusBar().showMessage(
            f"Cursor: ({point.x():.3f}, {point.y():.3f}) mm | Snap: ({snapped[0]:.3f}, {snapped[1]:.3f}) mm"
        )

    def _snap_canvas_point(self, point: QPointF) -> tuple[float, float] | None:
        if self._canvas_projection is None:
            return None
        tolerance = self.canvas.scene_tolerance_from_pixels(14.0)
        return nearest_snap_point(
            (point.x(), point.y()),
            self._canvas_projection.segments,
            tolerance_mm=tolerance,
        )


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Laser SVG Tool")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())