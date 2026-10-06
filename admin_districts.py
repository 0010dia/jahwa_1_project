from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from shapely.geometry import Point, shape
from shapely.strtree import STRtree


BASE_DIR = Path(__file__).resolve().parent
ADMIN_DONG_PATH = BASE_DIR / "data" / "gumi_admin_dongs.geojson"
COUNT_STYLES = (
    (0, "데이터 없음", "#94a3b8", 0.04),
    (1, "1건", "#facc15", 0.16),
    (3, "2~3건", "#f97316", 0.22),
    (5, "4~5건", "#dc2626", 0.27),
    (float("inf"), "6건 이상", "#881337", 0.32),
)


def _style_for_count(count: int) -> dict[str, Any]:
    for upper_bound, label, color, opacity in COUNT_STYLES:
        if count <= upper_bound:
            return {
                "levelLabel": label,
                "color": color,
                "fillOpacity": opacity,
            }
    raise AssertionError("침수 건수 색상 구간을 찾지 못했습니다.")


class AdminDistrictRepository:
    def __init__(self, path: Path = ADMIN_DONG_PATH) -> None:
        with path.open(encoding="utf-8") as file:
            payload = json.load(file)
        self.metadata = payload.get("metadata") or {}
        self.features = payload.get("features") or []
        self.geometries = np.asarray(
            [shape(feature["geometry"]) for feature in self.features],
            dtype=object,
        )
        self.tree = STRtree(self.geometries)

    def district_index_for_point(self, lat: float, lng: float) -> int | None:
        point = Point(lng, lat)
        candidates = np.atleast_1d(self.tree.query(point))
        matches = [
            int(index)
            for index in candidates
            if self.geometries[int(index)].covers(point)
        ]
        if not matches:
            return None
        return min(matches, key=lambda index: self.geometries[index].area)

    def statistics(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
        buckets = [
            {"reportIds": [], "userCount": 0, "adminCount": 0, "demoCount": 0}
            for _ in self.features
        ]
        unmatched_count = 0
        for report in reports:
            index = self.district_index_for_point(
                float(report["lat"]), float(report["lng"])
            )
            if index is None:
                unmatched_count += 1
                continue
            bucket = buckets[index]
            bucket["reportIds"].append(int(report["id"]))
            if report.get("isSample"):
                bucket["demoCount"] += 1
            elif report.get("isAdminCreated"):
                bucket["adminCount"] += 1
            else:
                bucket["userCount"] += 1

        features = []
        for index, source_feature in enumerate(self.features):
            geometry = self.geometries[index]
            center = geometry.representative_point()
            bucket = buckets[index]
            active_count = len(bucket["reportIds"])
            properties = {
                **source_feature["properties"],
                **bucket,
                **_style_for_count(active_count),
                "activeCount": active_count,
                "centerLat": center.y,
                "centerLng": center.x,
            }
            features.append(
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": source_feature["geometry"],
                }
            )

        affected_count = sum(
            feature["properties"]["activeCount"] > 0 for feature in features
        )
        return {
            "type": "FeatureCollection",
            "metadata": {
                **self.metadata,
                "activeCount": len(reports),
                "affectedDongCount": affected_count,
                "unmatchedCount": unmatched_count,
                "maxCount": max(
                    (feature["properties"]["activeCount"] for feature in features),
                    default=0,
                ),
            },
            "legend": [
                {"label": label, "color": color, "fillOpacity": opacity}
                for _, label, color, opacity in COUNT_STYLES
            ],
            "features": features,
        }


@lru_cache(maxsize=1)
def get_admin_district_repository() -> AdminDistrictRepository:
    return AdminDistrictRepository()
