from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


FIELD_ALIASES = {
    "name": ["name", "시설명", "대피소명", "FCLT_NM"],
    "address": ["address", "주소", "도로명주소", "RONA_DADDR", "LOTNO_DADDR"],
    "lat": ["lat", "위도", "LAT", "Y"],
    "lng": ["lng", "경도", "LOT", "LON", "X"],
    "capacity": ["capacity", "수용인원", "ACPTN_NMPR"],
}


def first_value(row: dict[str, str], aliases: list[str]) -> str:
    for alias in aliases:
        value = row.get(alias)
        if value:
            return value.strip()
    return ""


def convert(input_path: Path, output_path: Path) -> None:
    shelters = []
    with input_path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        for index, row in enumerate(reader, start=1):
            lat = first_value(row, FIELD_ALIASES["lat"])
            lng = first_value(row, FIELD_ALIASES["lng"])
            if not lat or not lng:
                continue
            shelters.append(
                {
                    "id": f"gumi-official-{index:04d}",
                    "name": first_value(row, FIELD_ALIASES["name"]) or f"대피소 {index}",
                    "type": "이재민 임시주거시설",
                    "address": first_value(row, FIELD_ALIASES["address"]),
                    "lat": float(lat),
                    "lng": float(lng),
                    "capacity": int(float(first_value(row, FIELD_ALIASES["capacity"]) or 0)),
                    "verified": True,
                    "source": "imported_csv",
                }
            )

    output_path.write_text(
        json.dumps(shelters, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="대피소 CSV를 앱 JSON 형식으로 변환합니다.")
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/shelters.gumi.json"),
    )
    args = parser.parse_args()
    convert(args.input, args.output)


if __name__ == "__main__":
    main()
