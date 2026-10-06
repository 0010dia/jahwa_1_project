from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from shapely.affinity import scale, translate
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree


BASE_DIR = Path(__file__).resolve().parent
PROCESSED_DIR = BASE_DIR / "data" / "flood_maps" / "processed"
SOURCE_METADATA = {
    "history": {
        "name": "구미시 실제 침수흔적",
        "riskLevel": "실제 침수이력",
        "note": "2012·2018년 행정안전부 침수흔적도",
        "detour_margin_deg": 0.0015,
    },
    "river": {
        "name": "50년 빈도 지방하천 하천범람구역",
        "riskLevel": "50년 빈도 예상",
        "note": "구미시 지방하천 하천범람 시뮬레이션",
        "detour_margin_deg": 0.0025,
    },
    "urban": {
        "name": "50년 빈도 도시침수구역",
        "riskLevel": "50년 빈도 예상",
        "note": "구미시 도시침수 시뮬레이션",
        "detour_margin_deg": 0.0015,
    },
}
LIVE_FLOOD_RADIUS_M = 40
LIVE_FLOOD_COLOR = "#be123c"
DEMO_FLOOD_COLOR = "#d97706"


def live_flood_geometry(
    lat: float, lng: float, radius_m: float = LIVE_FLOOD_RADIUS_M
) -> Any:
    unit_circle = Point(0, 0).buffer(1, quad_segs=24)
    circle = scale(
        unit_circle,
        xfact=radius_m / (111_320 * math.cos(math.radians(lat))),
        yfact=radius_m / 110_574,
        origin=(0, 0),
    )
    return translate(circle, xoff=lng, yoff=lat)


def _live_zone_metadata(report: dict[str, Any]) -> dict[str, Any]:
    report_id = int(report["id"])
    is_sample = bool(report.get("isSample", False))
    is_admin_created = bool(report.get("isAdminCreated", False))
    if is_sample:
        name = f"데모 침수 #{report_id}"
        risk_level = "데모 침수구역"
        note = "실제 침수흔적 내부 추출 데모 · 반경 40m"
    elif is_admin_created:
        name = f"관리자 등록 침수 #{report_id}"
        risk_level = "현재 침수 위험"
        note = "관리자 지도 직접 추가 · 반경 40m"
    else:
        name = f"실시간 침수 신고 #{report_id}"
        risk_level = "현재 침수 위험"
        note = "관리자 승인 신고 · 반경 40m"
    return {
        "id": f"live-{report_id}",
        "sourceId": "live",
        "name": name,
        "riskLevel": risk_level,
        "note": note,
        "detour_margin_deg": 0.0007,
        "datasetType": "live",
        "color": DEMO_FLOOD_COLOR if is_sample else LIVE_FLOOD_COLOR,
        "reportId": report_id,
        "approvedAt": report.get("approvedAt"),
        "radiusM": LIVE_FLOOD_RADIUS_M,
        "isSample": is_sample,
        "isAdminCreated": is_admin_created,
    }


def live_flood_feature_collection(
    reports: list[dict[str, Any]],
) -> dict[str, Any]:
    features = []
    summaries = []
    for report in reports:
        metadata = _live_zone_metadata(report)
        geometry = live_flood_geometry(float(report["lat"]), float(report["lng"]))
        properties = {
            key: value
            for key, value in metadata.items()
            if key != "detour_margin_deg"
        }
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": json.loads(shapely.to_geojson(geometry)),
            }
        )
        summaries.append(properties)
    return {
        "type": "FeatureCollection",
        "features": features,
        "summary": summaries,
        "dataNotice": "활성 상태의 현재 침수지점을 반경 40m로 표시합니다.",
    }


class FloodRepository:
    def __init__(
        self,
        include_prediction: bool = False,
        live_reports: list[dict[str, Any]] | None = None,
        include_history: bool = True,
    ) -> None:
        geometries: list[Any] = []
        source_ids: list[str] = []
        source_part_indexes: list[int] = []
        zone_metadata: list[dict[str, Any]] = []

        enabled_sources = ["history"] if include_history else []
        if include_prediction:
            enabled_sources.extend(["river", "urban"])

        for source_id in enabled_sources:
            path = PROCESSED_DIR / f"{source_id}.wkb"
            if not path.exists():
                raise FileNotFoundError(
                    f"침수 전처리 파일이 없습니다: {path}. "
                    "scripts/fetch_recent_flood_traces.py를 먼저 실행하세요."
                )
            merged = shapely.from_wkb(path.read_bytes(), on_invalid="fix")
            parts = shapely.get_parts(merged)
            for part_index, geometry in enumerate(parts):
                if shapely.is_empty(geometry):
                    continue
                geometries.append(geometry)
                source_ids.append(source_id)
                source_part_indexes.append(part_index)
                fingerprint = hashlib.sha1(
                    f"{source_id}:{part_index}".encode("ascii")
                ).hexdigest()[:10]
                zone_metadata.append(
                    {
                        "id": f"{source_id}-{fingerprint}",
                        "sourceId": source_id,
                        **SOURCE_METADATA[source_id],
                    }
                )

        for report in live_reports or []:
            geometries.append(
                live_flood_geometry(float(report["lat"]), float(report["lng"]))
            )
            source_ids.append("live")
            source_part_indexes.append(int(report["id"]))
            zone_metadata.append(_live_zone_metadata(report))

        self.geometries = np.asarray(geometries, dtype=object)
        self.source_ids = source_ids
        self.source_part_indexes = source_part_indexes
        self.zone_metadata = zone_metadata
        self.tree = STRtree(self.geometries)
        self.is_empty = len(self.geometries) == 0

    def _zone(
        self, index: int, focus_geometry: Any | None = None
    ) -> dict[str, Any]:
        geometry = self.geometries[index]
        metadata = self.zone_metadata[index]
        local_geometry = geometry
        if focus_geometry is not None:
            focused = geometry.intersection(focus_geometry.buffer(0.0015))
            if not shapely.is_empty(focused):
                local_geometry = focused
        return {
            **metadata,
            "bounds": list(local_geometry.bounds),
            "_geometry": geometry,
        }

    def hazards_for_paths(
        self, paths: list[list[dict[str, float]]]
    ) -> list[dict[str, Any]]:
        lines = [
            LineString([(point["lng"], point["lat"]) for point in path])
            for path in paths
            if len(path) >= 2
        ]
        if not lines:
            return []
        route_geometry = lines[0] if len(lines) == 1 else shapely.MultiLineString(lines)
        indexes = self.tree.query(route_geometry, predicate="intersects")
        return [
            self._zone(int(index), route_geometry)
            for index in sorted(set(indexes.tolist()))
        ]

    def risk_exposure_m(self, paths: list[list[dict[str, float]]]) -> float:
        lines = [
            LineString([(point["lng"], point["lat"]) for point in path])
            for path in paths
            if len(path) >= 2
        ]
        total_m = 0.0
        for line in lines:
            indexes = self.tree.query(line, predicate="intersects")
            intersections: list[Any] = []
            for index in indexes.tolist():
                intersection = line.intersection(self.geometries[int(index)])
                if not shapely.is_empty(intersection):
                    intersections.append(intersection)
            if intersections:
                flooded_segment = shapely.union_all(intersections)
                _, min_lat, _, max_lat = flooded_segment.bounds
                center_lat = (min_lat + max_lat) / 2
                projected = scale(
                    flooded_segment,
                    xfact=111_320 * math.cos(math.radians(center_lat)),
                    yfact=110_574,
                    origin=(0, 0),
                )
                total_m += float(projected.length)
        return total_m

    def hazards_for_point(self, point: dict[str, float]) -> list[dict[str, Any]]:
        geometry = Point(point["lng"], point["lat"])
        indexes = self.tree.query(geometry, predicate="intersects")
        return [self._zone(int(index)) for index in sorted(set(indexes.tolist()))]

    def hazards_near_point(
        self, point: dict[str, float], radius_m: float
    ) -> list[dict[str, Any]]:
        radius_deg = radius_m / 100_000
        area = Point(point["lng"], point["lat"]).buffer(radius_deg)
        indexes = self.tree.query(area, predicate="intersects")
        return [self._zone(int(index)) for index in sorted(set(indexes.tolist()))]

    def contains_point(self, point: dict[str, float]) -> bool:
        return bool(self.hazards_for_point(point))

    @staticmethod
    def segment_intersects_zone(
        start: dict[str, float], end: dict[str, float], zone: dict[str, Any]
    ) -> bool:
        line = LineString(
            [(start["lng"], start["lat"]), (end["lng"], end["lat"])]
        )
        return bool(line.intersects(zone["_geometry"]))


@lru_cache(maxsize=2)
def get_flood_repository(include_prediction: bool = False) -> FloodRepository:
    return FloodRepository(include_prediction=include_prediction)


@lru_cache(maxsize=1)
def load_flood_display() -> dict[str, Any]:
    path = PROCESSED_DIR / "flood_zones.gumi.web.geojson"
    with path.open(encoding="utf-8") as file:
        return json.load(file)
