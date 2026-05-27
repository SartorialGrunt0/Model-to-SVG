from __future__ import annotations

import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .document import normalize_projection
from .geometry import Segment2D, project_model_outline
from .text_geometry import build_text_outline, list_font_families


class SegmentResponse(BaseModel):
    id: str
    start: tuple[float, float]
    end: tuple[float, float]
    length: float


class ProjectionResponse(BaseModel):
    file_name: str
    orientation: str
    page_rotation: int
    units: str
    width: float
    height: float
    segments: list[SegmentResponse]


class FontListResponse(BaseModel):
    fonts: list[str]


class TextPathRequest(BaseModel):
    content: str
    font_family: str
    size_mm: float


class TextPathResponse(BaseModel):
    font_family: str
    path_data: str
    width: float
    height: float


app = FastAPI(title="Laser SVG Tool API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WEBAPP_DIST_DIR = Path(__file__).resolve().parents[2] / "webapp" / "dist"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/fonts", response_model=FontListResponse)
def fonts() -> FontListResponse:
    return FontListResponse(fonts=list_font_families())


@app.post("/api/project", response_model=ProjectionResponse)
async def project_uploaded_model(
    model_file: UploadFile = File(...),
    orientation: str = Form("top"),
    page_rotation: int = Form(0),
) -> ProjectionResponse:
    suffix = Path(model_file.filename or "uploaded-model").suffix.lower()
    if suffix not in {".stl", ".step", ".stp"}:
        raise HTTPException(status_code=400, detail="Only STL and STEP files are supported.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_path = Path(temp_file.name)
        while chunk := await model_file.read(1024 * 1024):
            temp_file.write(chunk)

    try:
        projection = project_model_outline(
            temp_path,
            orientation=orientation,
            page_rotation=page_rotation,
            units="mm",
        )
        normalized = normalize_projection(projection)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        temp_path.unlink(missing_ok=True)

    return ProjectionResponse(
        file_name=model_file.filename or temp_path.name,
        orientation=orientation,
        page_rotation=page_rotation,
        units=normalized.units,
        width=normalized.width,
        height=normalized.height,
        segments=[_segment_response(index, segment) for index, segment in enumerate(normalized.segments)],
    )


@app.post("/api/text-path", response_model=TextPathResponse)
def text_path(request: TextPathRequest) -> TextPathResponse:
    try:
        outline = build_text_outline(
            request.content,
            request.font_family,
            request.size_mm,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return TextPathResponse(
        font_family=outline.font_family,
        path_data=outline.path_data,
        width=outline.width,
        height=outline.height,
    )


def _segment_response(index: int, segment: Segment2D) -> SegmentResponse:
    return SegmentResponse(
        id=f"seg-{index}",
        start=segment.start,
        end=segment.end,
        length=segment.length,
    )


def run() -> None:
    uvicorn.run(
        "laser_svg_tool.web_api:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
    )


if WEBAPP_DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=WEBAPP_DIST_DIR, html=True), name="webapp")


if __name__ == "__main__":
    run()