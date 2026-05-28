from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import gmsh
import numpy as np
import trimesh


EPSILON = 1e-6


@dataclass(frozen=True)
class Segment2D:
    start: tuple[float, float]
    end: tuple[float, float]

    @property
    def length(self) -> float:
        delta_x = self.end[0] - self.start[0]
        delta_y = self.end[1] - self.start[1]
        return float(np.hypot(delta_x, delta_y))


@dataclass(frozen=True)
class ProjectionResult:
    source_path: Path
    orientation: str
    units: str
    segments: tuple[Segment2D, ...]
    bounds: tuple[float, float, float, float]

    @property
    def width(self) -> float:
        return self.bounds[2] - self.bounds[0]

    @property
    def height(self) -> float:
        return self.bounds[3] - self.bounds[1]


def project_model_outline(
    source_path: str | Path,
    orientation: str = "top",
    page_rotation: int = 0,
    units: str = "mm",
    perspective_distance: float = 0.0,
) -> ProjectionResult:
    path = Path(source_path)
    triangles = _load_surface_triangles(path)
    rotated = _rotate_triangles(triangles, orientation)
    segments = _extract_visible_segments(rotated, perspective_distance)
    segments = _rotate_segments_2d(segments, page_rotation)
    bounds = _compute_bounds(segments)
    return ProjectionResult(
        source_path=path,
        orientation=orientation,
        units=units,
        segments=tuple(segments),
        bounds=bounds,
    )


def _load_surface_triangles(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix == ".stl":
        return _load_stl_triangles(path)
    if suffix in {".stp", ".step"}:
        return _load_step_triangles(path)
    raise ValueError(f"Unsupported file type: {path.suffix}")


def _load_stl_triangles(path: Path) -> np.ndarray:
    loaded = trimesh.load(path, force="scene", process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [
            geometry
            for geometry in loaded.geometry.values()
            if isinstance(geometry, trimesh.Trimesh)
        ]
        if not meshes:
            raise ValueError("The STL file does not contain any mesh geometry.")
        mesh = trimesh.util.concatenate(meshes)
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise ValueError("The STL file could not be read as a mesh.")

    triangles = np.asarray(mesh.triangles, dtype=float)
    if triangles.size == 0:
        raise ValueError("The STL file is empty.")
    return triangles


def _load_step_triangles(path: Path) -> np.ndarray:
    triangles: list[np.ndarray] = []
    was_initialized = gmsh.isInitialized()
    if not was_initialized:
        gmsh.initialize()

    try:
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.clear()
        gmsh.open(str(path))
        gmsh.model.mesh.generate(2)

        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        coords = np.asarray(node_coords, dtype=float).reshape(-1, 3)
        tag_to_index = {int(tag): index for index, tag in enumerate(node_tags)}

        for entity_dim, entity_tag in gmsh.model.getEntities(2):
            element_types, _, node_tags_per_element = gmsh.model.mesh.getElements(
                entity_dim,
                entity_tag,
            )
            for element_type, element_nodes in zip(element_types, node_tags_per_element):
                _, _, _, node_count, _, _ = gmsh.model.mesh.getElementProperties(
                    element_type
                )
                if node_count < 3:
                    continue
                faces = np.asarray(element_nodes, dtype=int).reshape(-1, node_count)
                triangle_indices = _triangulate_index_fan(node_count)
                for face in faces:
                    face_points = np.asarray(
                        [coords[tag_to_index[int(node_tag)]] for node_tag in face],
                        dtype=float,
                    )
                    for tri_index in triangle_indices:
                        triangles.append(face_points[tri_index])
    finally:
        gmsh.clear()
        if not was_initialized:
            gmsh.finalize()

    if not triangles:
        raise ValueError("The STEP file could not be meshed into any surface triangles.")
    return np.stack(triangles, axis=0)


def _triangulate_index_fan(node_count: int) -> list[list[int]]:
    if node_count == 3:
        return [[0, 1, 2]]
    return [[0, index, index + 1] for index in range(1, node_count - 1)]


def _rotate_triangles(triangles: np.ndarray, orientation: str) -> np.ndarray:
    matrix = _orientation_matrix(orientation)
    return np.einsum("ij,nkj->nki", matrix, triangles)


def _orientation_matrix(orientation: str) -> np.ndarray:
    normalized = orientation.lower()
    matrices = {
        "top": np.eye(3),
        "bottom": _rotation_matrix_x(np.pi),
        "front": _rotation_matrix_x(-np.pi / 2.0),
        "back": _rotation_matrix_x(np.pi / 2.0),
        "left": _rotation_matrix_y(np.pi / 2.0),
        "right": _rotation_matrix_y(-np.pi / 2.0),
    }
    try:
        return matrices[normalized]
    except KeyError as exc:
        options = ", ".join(sorted(matrices))
        raise ValueError(f"Unsupported orientation '{orientation}'. Choose from: {options}.") from exc


def _rotation_matrix_x(angle_radians: float) -> np.ndarray:
    cosine = float(np.cos(angle_radians))
    sine = float(np.sin(angle_radians))
    return np.array(
        [[1.0, 0.0, 0.0], [0.0, cosine, -sine], [0.0, sine, cosine]],
        dtype=float,
    )


def _rotation_matrix_y(angle_radians: float) -> np.ndarray:
    cosine = float(np.cos(angle_radians))
    sine = float(np.sin(angle_radians))
    return np.array(
        [[cosine, 0.0, sine], [0.0, 1.0, 0.0], [-sine, 0.0, cosine]],
        dtype=float,
    )


def _apply_perspective(x: float, y: float, z: float, distance: float) -> tuple[float, float]:
    if distance <= 0.0:
        return (x, y)
    scale = distance / (distance + z)
    return (x * scale, y * scale)


def _extract_visible_segments(triangles: np.ndarray, perspective_distance: float = 0.0) -> list[Segment2D]:
    normals = _face_normals(triangles)
    vertex_ids = _index_vertices(triangles)
    edge_faces: dict[tuple[int, int], list[int]] = {}
    edge_points: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}

    for face_index, face in enumerate(vertex_ids):
        triangle = triangles[face_index]
        for local_start, local_end in ((0, 1), (1, 2), (2, 0)):
            start_id = int(face[local_start])
            end_id = int(face[local_end])
            edge_key = (start_id, end_id) if start_id < end_id else (end_id, start_id)
            edge_faces.setdefault(edge_key, []).append(face_index)
            edge_points.setdefault(
                edge_key,
                (triangle[local_start].copy(), triangle[local_end].copy()),
            )

    segments: list[Segment2D] = []
    for edge_key, faces in edge_faces.items():
        if not _edge_is_visible(faces, normals):
            continue
        start_point, end_point = edge_points[edge_key]
        start_2d = _apply_perspective(
            float(start_point[0]), float(start_point[1]), float(start_point[2]),
            perspective_distance,
        )
        end_2d = _apply_perspective(
            float(end_point[0]), float(end_point[1]), float(end_point[2]),
            perspective_distance,
        )
        projected = Segment2D(start=start_2d, end=end_2d)
        if projected.length > EPSILON:
            segments.append(projected)
    return _deduplicate_segments(segments)


def _face_normals(triangles: np.ndarray) -> np.ndarray:
    first_edges = triangles[:, 1, :] - triangles[:, 0, :]
    second_edges = triangles[:, 2, :] - triangles[:, 0, :]
    normals = np.cross(first_edges, second_edges)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    safe_lengths = np.where(lengths < EPSILON, 1.0, lengths)
    return normals / safe_lengths


def _index_vertices(triangles: np.ndarray) -> np.ndarray:
    vertex_lookup: dict[tuple[int, int, int], int] = {}
    vertex_ids = np.empty((triangles.shape[0], 3), dtype=int)
    next_id = 0

    for triangle_index, triangle in enumerate(triangles):
        for point_index, point in enumerate(triangle):
            key = tuple(int(round(value * 1_000_000.0)) for value in point)
            if key not in vertex_lookup:
                vertex_lookup[key] = next_id
                next_id += 1
            vertex_ids[triangle_index, point_index] = vertex_lookup[key]
    return vertex_ids


def _edge_is_visible(face_indices: Iterable[int], normals: np.ndarray) -> bool:
    indices = list(face_indices)
    if not indices:
        return False

    classes = {_normal_class(normals[index][2]) for index in indices}
    if len(indices) == 1:
        return -1 not in classes
    return len(classes) > 1 and any(face_class in classes for face_class in (-1, 1))


def _normal_class(normal_z: float) -> int:
    if normal_z > EPSILON:
        return 1
    if normal_z < -EPSILON:
        return -1
    return 0


def _rotate_segments_2d(segments: list[Segment2D], page_rotation: int) -> list[Segment2D]:
    normalized_rotation = page_rotation % 360
    if normalized_rotation == 0:
        return segments
    if normalized_rotation not in {90, 180, 270}:
        raise ValueError("Page rotation must be 0, 90, 180, or 270 degrees.")

    rotation_map = {
        90: np.array([[0.0, -1.0], [1.0, 0.0]], dtype=float),
        180: np.array([[-1.0, 0.0], [0.0, -1.0]], dtype=float),
        270: np.array([[0.0, 1.0], [-1.0, 0.0]], dtype=float),
    }
    matrix = rotation_map[normalized_rotation]
    rotated_segments: list[Segment2D] = []
    for segment in segments:
        start = np.dot(matrix, np.asarray(segment.start, dtype=float))
        end = np.dot(matrix, np.asarray(segment.end, dtype=float))
        rotated_segments.append(
            Segment2D(
                start=(float(start[0]), float(start[1])),
                end=(float(end[0]), float(end[1])),
            )
        )
    return rotated_segments


def _compute_bounds(segments: list[Segment2D]) -> tuple[float, float, float, float]:
    if not segments:
        raise ValueError("No visible edges were found for the selected orientation.")

    points = np.array(
        [point for segment in segments for point in (segment.start, segment.end)],
        dtype=float,
    )
    min_x = float(np.min(points[:, 0]))
    min_y = float(np.min(points[:, 1]))
    max_x = float(np.max(points[:, 0]))
    max_y = float(np.max(points[:, 1]))
    return (min_x, min_y, max_x, max_y)


def _deduplicate_segments(segments: list[Segment2D]) -> list[Segment2D]:
    deduplicated: dict[tuple[int, int, int, int], Segment2D] = {}
    for segment in segments:
        ordered = sorted((segment.start, segment.end))
        key = tuple(
            int(round(value * 1_000_000.0))
            for point in ordered
            for value in point
        )
        deduplicated[key] = segment
    return list(deduplicated.values())


def _round_point(point: tuple[float, float], precision: int = 4) -> tuple[float, float]:
    return (round(point[0], precision), round(point[1], precision))


def find_closed_polygons(segments: list[Segment2D]) -> list[list[tuple[float, float]]]:
    """Find closed polygons from a list of 2D segments using edge-following."""
    adjacency: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for segment in segments:
        start = _round_point(segment.start)
        end = _round_point(segment.end)
        adjacency.setdefault(start, []).append(end)
        adjacency.setdefault(end, []).append(start)

    used_edges: set[tuple[tuple[float, float], tuple[float, float]]] = set()
    polygons: list[list[tuple[float, float]]] = []

    for segment in segments:
        start = _round_point(segment.start)
        end = _round_point(segment.end)

        for direction_start, direction_end in [(start, end), (end, start)]:
            edge_key = (direction_start, direction_end)
            if edge_key in used_edges:
                continue

            path = [direction_start, direction_end]
            used_edges.add(edge_key)
            current = direction_end

            max_steps = min(len(segments) + 1, 10000)
            for _ in range(max_steps):
                neighbors = adjacency.get(current, [])
                previous = path[-2] if len(path) >= 2 else None

                next_point = None
                for neighbor in neighbors:
                    candidate_edge = (current, neighbor)
                    if candidate_edge not in used_edges and neighbor != previous:
                        next_point = neighbor
                        break

                if next_point is None:
                    break

                used_edges.add((current, next_point))
                if next_point == path[0]:
                    polygons.append(path)
                    break

                path.append(next_point)
                current = next_point

    return polygons