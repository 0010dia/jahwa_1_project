from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = BASE_DIR / "data" / "gumi_admin_dongs.geojson"
GUMI_SGG_CODE = "47190"
SOURCE_VERSION = "20260701"
SOURCE_URL = (
    "https://github.com/vuski/admdongkor/tree/master/ver20260701"
)


def normalize_feature(feature: dict[str, Any]) -> dict[str, Any]:
    properties = feature.get("properties") or {}
    full_name = str(properties.get("adm_nm") or "").strip()
    return {
        "type": "Feature",
        "properties": {
            "code": str(properties.get("adm_cd2") or ""),
            "name": full_name.rsplit(" ", 1)[-1],
            "fullName": full_name,
        },
        "geometry": feature["geometry"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="전국 행정동 GeoJSON에서 구미시 읍면동 경계를 추출합니다."
    )
    parser.add_argument("source", type=Path, help="전국 행정동 GeoJSON 경로")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    with args.source.open(encoding="utf-8") as file:
        source = json.load(file)

    features = [
        normalize_feature(feature)
        for feature in source.get("features", [])
        if str((feature.get("properties") or {}).get("sgg")) == GUMI_SGG_CODE
    ]
    features.sort(key=lambda feature: feature["properties"]["code"])
    if not features:
        raise RuntimeError("구미시 행정동 경계를 찾지 못했습니다.")

    output = {
        "type": "FeatureCollection",
        "metadata": {
            "name": "구미시 행정동 경계",
            "source": "vuski/admdongkor (통계청 SGIS 기반)",
            "sourceVersion": SOURCE_VERSION,
            "sourceUrl": SOURCE_URL,
            "coordinateSystem": "EPSG:4326",
            "featureCount": len(features),
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as file:
        json.dump(output, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")
    print(f"구미시 읍면동 {len(features)}개를 {args.output}에 저장했습니다.")


if __name__ == "__main__":
    main()
