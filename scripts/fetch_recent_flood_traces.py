from __future__ import annotations

import argparse
import collections
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import requests
import shapely
from dotenv import load_dotenv
from pyproj import Transformer


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BASE_DIR / "data" / "flood_maps" / "processed"
API_URL = "https://www.safetydata.go.kr/V2/api/DSSP-IF-00117"
PAGE_SIZE = 1_000
PREDICTION_SOURCES: tuple[dict[str, Any], ...] = (
    {
        "id": "river",
        "name": "50년 빈도 지방하천 하천범람구역",
        "riskLevel": "50년 빈도 예상",
        "note": "지방하천 하천범람 시뮬레이션 · 선택 레이어",
        "color": "#2563eb",
        "simplify": 0.0003,
    },
    {
        "id": "urban",
        "name": "50년 빈도 도시침수구역",
        "riskLevel": "50년 빈도 예상",
        "note": "도시침수 시뮬레이션 · 선택 레이어",
        "color": "#d97706",
        "simplify": 0.00015,
    },
)


def fetch_page(service_key: str, page_no: int) -> dict[str, Any]:
    params = {
        "serviceKey": service_key,
        "returnType": "json",
        "pageNo": page_no,
        "numOfRows": PAGE_SIZE,
    }
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(API_URL, params=params, timeout=90)
            response.raise_for_status()
            payload = response.json()
            header = payload.get("header") or {}
            if header.get("resultCode") != "00":
                raise RuntimeError(
                    f"API 오류 {header.get('resultCode')}: "
                    f"{header.get('errorMsg') or header.get('resultMsg')}"
                )
            return payload
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{page_no}페이지 조회 실패: {last_error}")


def record_matches(
    record: dict[str, Any], sgg_code: str, start_year: int, end_year: int
) -> bool:
    try:
        year = int(record.get("FLDN_YR"))
    except (TypeError, ValueError):
        return False
    return (
        str(record.get("STDG_SGG_CD", "")).zfill(5) == sgg_code
        and start_year <= year <= end_year
        and bool(record.get("GEOM"))
    )


def write_outputs(
    records: list[dict[str, Any]],
    output_dir: Path,
    start_year: int,
    end_year: int,
) -> None:
    geometries = []
    valid_records = []
    for record in records:
        try:
            geometry = shapely.from_wkt(record["GEOM"], on_invalid="fix")
        except (shapely.GEOSException, TypeError, ValueError):
            continue
        if shapely.is_empty(geometry):
            continue
        geometries.append(geometry)
        valid_records.append(record)

    if geometries:
        source_geometries = np.asarray(geometries, dtype=object)
        transformer = Transformer.from_crs(
            "EPSG:3857", "EPSG:4326", always_xy=True
        )
        transformed = shapely.transform(
            source_geometries, transformer.transform, interleaved=False
        )
        merged = shapely.union_all(transformed)
        if not shapely.is_valid(merged):
            merged = shapely.make_valid(merged)
    else:
        merged = shapely.GeometryCollection()

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "history.wkb").write_bytes(
        shapely.to_wkb(merged, output_dimension=2)
    )

    years = sorted({int(record["FLDN_YR"]) for record in valid_records})
    disasters = sorted(
        {
            str(record["FLDN_DST_NM"]).strip()
            for record in valid_records
            if record.get("FLDN_DST_NM")
        }
    )
    display_geometry = shapely.simplify(
        merged, 0.00004, preserve_topology=True
    )
    year_label = "·".join(str(year) for year in years)
    record_note = f"{year_label}년 공식 등록 {len(valid_records)}건"
    properties = {
        "id": "history",
        "name": "구미시 실제 침수흔적",
        "riskLevel": "실제 침수이력",
        "note": record_note,
        "color": "#dc2626",
        "datasetType": "history",
        "defaultEnabled": True,
        "featureCount": len(valid_records),
        "availableYears": years,
        "disasterNames": disasters,
    }
    features = [
        {
            "type": "Feature",
            "properties": properties,
            "geometry": json.loads(shapely.to_geojson(display_geometry)),
        }
    ]
    summaries = [properties]

    for source in PREDICTION_SOURCES:
        source_geometry = shapely.from_wkb(
            (output_dir / f"{source['id']}.wkb").read_bytes(),
            on_invalid="fix",
        )
        source_display = shapely.simplify(
            source_geometry,
            source["simplify"],
            preserve_topology=False,
        )
        source_properties = {
            "id": source["id"],
            "name": source["name"],
            "riskLevel": source["riskLevel"],
            "note": source["note"],
            "color": source["color"],
            "datasetType": "scenario",
            "defaultEnabled": False,
        }
        features.append(
            {
                "type": "Feature",
                "properties": source_properties,
                "geometry": json.loads(shapely.to_geojson(source_display)),
            }
        )
        summaries.append(source_properties)

    payload = {
        "type": "FeatureCollection",
        "features": features,
        "summary": summaries,
        "dataNotice": (
            "행정안전부 침수흔적도 API의 구미시 실제 이력을 기본으로 사용합니다. "
            "사용자가 선택하면 50년 빈도 하천범람·도시침수 예상지도도 함께 표시하고 우회 판정에 반영합니다."
        ),
        "generatedAt": datetime.now(UTC).isoformat(),
    }
    output_path = output_dir / "flood_zones.gumi.web.geojson"
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"created: {output_path} "
        f"({len(valid_records)} records, years={years or 'none'})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="공식 API에서 구미시 실제 침수흔적을 받아 앱 데이터로 변환합니다."
    )
    parser.add_argument("--start-year", type=int, default=2012)
    parser.add_argument("--end-year", type=int, default=2018)
    parser.add_argument("--sgg-code", default="47190")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    load_dotenv(BASE_DIR / ".env")
    service_key = os.getenv("SAFETYDATA_SERVICE_KEY", "").strip()
    if not service_key:
        raise RuntimeError("SAFETYDATA_SERVICE_KEY가 설정되지 않았습니다.")

    first_page = fetch_page(service_key, 1)
    total_count = int(first_page.get("totalCount") or 0)
    page_count = max(1, math.ceil(total_count / PAGE_SIZE))
    pages = {1: first_page}
    print(f"fetching {total_count} records across {page_count} pages")

    if page_count > 1:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {
                executor.submit(fetch_page, service_key, page_no): page_no
                for page_no in range(2, page_count + 1)
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                page_no = futures[future]
                pages[page_no] = future.result()
                if completed % 5 == 0 or completed == len(futures):
                    print(f"downloaded {completed + 1}/{page_count} pages")

    all_records = [
        record
        for page_no in sorted(pages)
        for record in (pages[page_no].get("body") or [])
    ]
    area_records = [
        record
        for record in all_records
        if str(record.get("STDG_SGG_CD", "")).zfill(5) == args.sgg_code
    ]
    area_years = collections.Counter(
        str(record.get("FLDN_YR") or "unknown") for record in area_records
    )
    print(
        f"area {args.sgg_code}: {len(area_records)} records, "
        f"year distribution={dict(sorted(area_years.items()))}"
    )
    selected = [
        record
        for record in area_records
        if record_matches(
            record, args.sgg_code, args.start_year, args.end_year
        )
    ]
    write_outputs(selected, args.output_dir, args.start_year, args.end_year)


if __name__ == "__main__":
    main()
