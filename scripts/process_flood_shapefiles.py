from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import shapely
from pyogrio.raw import read
from pyproj import Transformer


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BASE_DIR / "data" / "flood_maps" / "processed"
SOURCES: tuple[dict[str, Any], ...] = (
    {
        "id": "river",
        "name": "50년 빈도 지방하천 하천범람구역",
        "path": BASE_DIR
        / "data"
        / "flood_maps"
        / "river"
        / "RFM_SGG_RGN_47190_050.shp",
        "note": "구미시 50년 빈도 지방하천 하천범람지도",
        "color": "#2563eb",
        "simplify": 0.0003,
    },
    {
        "id": "urban",
        "name": "50년 빈도 도시침수구역",
        "path": BASE_DIR
        / "data"
        / "flood_maps"
        / "urban"
        / "CFM_SGG_47190_050.shp",
        "note": "구미시 50년 빈도 도시침수지도",
        "color": "#dc2626",
        "simplify": 0.00015,
    },
)


def process_source(source: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    metadata, _, geometry_wkb, fields = read(source["path"], encoding="UTF-8")
    geometries = shapely.from_wkb(geometry_wkb, on_invalid="fix")
    transformer = Transformer.from_crs(
        metadata["crs"], "EPSG:4326", always_xy=True
    )
    geometries = shapely.transform(
        geometries, transformer.transform, interleaved=False
    )
    merged = shapely.union_all(geometries)
    if not shapely.is_valid(merged):
        merged = shapely.make_valid(merged)

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{source['id']}.wkb").write_bytes(
        shapely.to_wkb(merged, output_dimension=2)
    )

    display_geometry = shapely.simplify(
        merged, source["simplify"], preserve_topology=False
    )
    return {
        "type": "Feature",
        "properties": {
            "id": source["id"],
            "name": source["name"],
            "riskLevel": "50년 빈도",
            "note": source["note"],
            "color": source["color"],
            "featureCount": len(geometries),
            "depthCodes": sorted(set(fields[0].tolist())),
        },
        "geometry": json.loads(shapely.to_geojson(display_geometry)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="구미시 침수 SHP를 서버 판정용 WKB와 웹 표시용 GeoJSON으로 변환합니다."
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    features = [process_source(source, args.output_dir) for source in SOURCES]
    payload = {
        "type": "FeatureCollection",
        "features": features,
        "summary": [feature["properties"] for feature in features],
        "dataNotice": "사용자 제공 구미시 50년 빈도 하천범람지도 및 도시침수지도를 WGS84로 변환한 데이터입니다.",
    }
    output_path = args.output_dir / "flood_zones.gumi.web.geojson"
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"created: {output_path}")


if __name__ == "__main__":
    main()
