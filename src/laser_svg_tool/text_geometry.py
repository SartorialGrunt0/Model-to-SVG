from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtGui import QFont, QFontDatabase, QGuiApplication, QPainterPath, QTransform


POINTS_PER_MILLIMETER = 72.0 / 25.4
PREFERRED_FONTS = ("Arial", "Bahnschrift", "Segoe UI", "Courier New")
_qt_app: QGuiApplication | None = None


@dataclass(frozen=True)
class TextOutline:
    font_family: str
    path_data: str
    width: float
    height: float


def list_font_families() -> list[str]:
    _ensure_qt_application()
    families = [family for family in QFontDatabase.families() if not family.startswith("@")]  # type: ignore[arg-type]
    ordered = sorted(set(families), key=lambda family: (family not in PREFERRED_FONTS, family.lower()))
    return ordered


def build_text_outline(content: str, font_family: str, size_mm: float) -> TextOutline:
    if not content.strip():
        raise ValueError("Text content cannot be empty.")
    if size_mm <= 0:
        raise ValueError("Text size must be greater than zero.")

    _ensure_qt_application()

    font = QFont(font_family)
    font.setPointSizeF(size_mm * POINTS_PER_MILLIMETER)
    font.setStyleStrategy(QFont.StyleStrategy.PreferOutline)

    path = QPainterPath()
    path.addText(0.0, 0.0, font, content)
    bounds = path.boundingRect()
    normalized = QTransform.fromTranslate(-bounds.left(), -bounds.top()).map(path)
    normalized_bounds = normalized.boundingRect()

    return TextOutline(
        font_family=font.family(),
        path_data=_painter_path_to_svg_path(normalized),
        width=float(normalized_bounds.width()),
        height=float(normalized_bounds.height()),
    )


def _ensure_qt_application() -> QGuiApplication:
    global _qt_app

    instance = QGuiApplication.instance()
    if instance is not None:
        return instance

    if _qt_app is None:
        _qt_app = QGuiApplication([])
    return _qt_app


def _painter_path_to_svg_path(path: QPainterPath) -> str:
    commands: list[str] = []
    for index in range(path.elementCount()):
        element = path.elementAt(index)
        if element.isMoveTo():
            commands.append(f"M {element.x:.6f} {element.y:.6f}")
        elif element.isLineTo():
            commands.append(f"L {element.x:.6f} {element.y:.6f}")
        else:
            control1 = element
            control2 = path.elementAt(index + 1)
            end_point = path.elementAt(index + 2)
            commands.append(
                "C "
                f"{control1.x:.6f} {control1.y:.6f} "
                f"{control2.x:.6f} {control2.y:.6f} "
                f"{end_point.x:.6f} {end_point.y:.6f}"
            )
    return " ".join(commands)