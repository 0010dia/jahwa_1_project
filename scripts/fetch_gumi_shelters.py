from __future__ import annotations

import argparse
import json
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = BASE_DIR / "data" / "shelters.gumi.json"
API_URL = "https://www.safetydata.go.kr/V2/api/DSSP-IF-10945"
TMAP_REVERSE_GEOCODING_URL = (
    "https://apis.openapi.sk.com/tmap/geo/reversegeocoding"
)
PAGE_SIZE = 1_000
GUMI_CODE = "47190"
GUMI_BOUNDS = {
    "startLot": "127.7",
    "endLot": "129.0",
    "startLat": "35.7",
    "endLat": "36.5",
}


def fetch_page(service_key: str, page_no: int) -> dict[str, Any]:
    params = {
        "serviceKey": service_key,
        "returnType": "json",
        "pageNo": page_no,
        "numOfRows": PAGE_SIZE,
        **GUMI_BOUNDS,
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


def _code_starts_with(value: Any, prefix: str) -> bool:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits.startswith(prefix)


def _coordinate(record: dict[str, Any], key: str) -> float | None:
    try:
        value = float(record.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def is_gumi_temporary_housing(record: dict[str, Any]) -> bool:
    is_gumi = _code_starts_with(record.get("ARCD"), GUMI_CODE) or (
        _code_starts_with(record.get("BDONG_CD"), GUMI_CODE)
    )
    if not is_gumi:
        return False

    lat = _coordinate(record, "LA")
    lng = _coordinate(record, "LO")
    return lat is not None and lng is not None and 35.7 < lat < 36.5 and 127.7 < lng < 129.0


def _clean(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _tmap_address(address_info: dict[str, Any]) -> str:
    city = _clean(address_info.get("city_do"))
    district = _clean(address_info.get("gu_gun"))
    town = _clean(
        address_info.get("eup_myun")
        or address_info.get("adminDong")
        or address_info.get("legalDong")
    )
    road_name = _clean(address_info.get("roadName"))
    building_index = _clean(address_info.get("buildingIndex"))

    if road_name:
        return " ".join(
            part for part in (city, district, town, road_name, building_index) if part
        )

    legal_dong = _clean(address_info.get("legalDong"))
    ri = _clean(address_info.get("ri"))
    bunji = _clean(address_info.get("bunji"))
    local_parts = [town]
    if legal_dong and legal_dong not in local_parts:
        local_parts.append(legal_dong)
    if ri and ri not in local_parts:
        local_parts.append(ri)
    return " ".join(
        part for part in (city, district, *local_parts, bunji) if part
    )


def reverse_geocode(tmap_key: str, lat: float, lng: float) -> str:
    params = {
        "version": "1",
        "lat": lat,
        "lon": lng,
        "coordType": "WGS84GEO",
        "addressType": "A10",
        "newAddressExtend": "Y",
    }
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(
                TMAP_REVERSE_GEOCODING_URL,
                params=params,
                headers={"appKey": tmap_key},
                timeout=20,
            )
            response.raise_for_status()
            address = _tmap_address(response.json().get("addressInfo") or {})
            if not address:
                raise RuntimeError("주소 필드가 비어 있습니다.")
            return address
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"TMAP 역지오코딩 실패: {last_error}")


def reverse_geocode_limited(
    tmap_key: str, lat: float, lng: float, delay: float
) -> str:
    time.sleep(max(0, delay))
    return reverse_geocode(tmap_key, lat, lng)


def _fallback_address(record: dict[str, Any]) -> str:
    road = _clean(record.get("RN_DTL_ADRES"))
    if road:
        return road
    return _clean(record.get("DTL_ADRES"))


def _integer(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _number(value: Any) -> int | float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else round(number, 2)


def convert_record(record: dict[str, Any], address: str) -> dict[str, Any]:
    serial = _clean(record.get("ACMDFCLTY_SN"))
    safe_serial = re.sub(r"[^0-9A-Za-z_-]", "-", serial).strip("-")
    item = {
        "id": f"gumi-relief-{safe_serial}",
        "name": _clean(record.get("VT_ACMDFCLTY_NM")),
        "type": "이재민 임시주거시설",
        "address": address,
        "lat": round(float(record["LA"]), 7),
        "lng": round(float(record["LO"]), 7),
        "capacity": _integer(record.get("VT_ACMD_PSBL_NMPR")),
        "verified": True,
        "source": "safetydata_DSSP-IF-10945",
        "facilitySerial": serial,
        "facilityCategoryCode": _clean(record.get("ACMDFCLTY_SE_CD")),
        "legalDongCode": _clean(record.get("BDONG_CD")),
    }
    area = _number(record.get("FCLTY_AR"))
    if area is not None:
        item["areaM2"] = area
    return item


def fetch_all_records(service_key: str, workers: int) -> list[dict[str, Any]]:
    first_page = fetch_page(service_key, 1)
    total_count = int(first_page.get("totalCount") or 0)
    page_count = max(1, math.ceil(total_count / PAGE_SIZE))
    pages = {1: first_page}
    print(f"fetching {total_count} records across {page_count} pages")

    if page_count > 1:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
            futures = {
                executor.submit(fetch_page, service_key, page_no): page_no
                for page_no in range(2, page_count + 1)
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                pages[futures[future]] = future.result()
                if completed % 5 == 0 or completed == len(futures):
                    print(f"downloaded {completed + 1}/{page_count} pages")

    return [
        record
        for page_no in sorted(pages)
        for record in (pages[page_no].get("body") or [])
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "재난안전데이터 공유 플랫폼에서 구미시 이재민 임시주거시설만 "
            "받아 앱 JSON으로 변환합니다."
        )
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--geocode-workers", type=int, default=1)
    parser.add_argument("--geocode-delay", type=float, default=0.2)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    load_dotenv(BASE_DIR / ".env")
    service_key = os.getenv("SHELTERDATA_SERVICE_KEY", "").strip()
    tmap_key = os.getenv("TMAP_APP_KEY", "").strip()
    if not service_key:
        raise RuntimeError("SHELTERDATA_SERVICE_KEY가 설정되지 않았습니다.")

    all_records = fetch_all_records(service_key, args.workers)
    selected = [record for record in all_records if is_gumi_temporary_housing(record)]

    addresses: dict[str, str] = {}
    missing_addresses = [record for record in selected if not _fallback_address(record)]
    if missing_addresses and not tmap_key:
        raise RuntimeError("주소 보완에 필요한 TMAP_APP_KEY가 설정되지 않았습니다.")
    with ThreadPoolExecutor(max_workers=max(1, args.geocode_workers)) as executor:
        futures = {
            executor.submit(
                reverse_geocode_limited,
                tmap_key,
                float(record["LA"]),
                float(record["LO"]),
                args.geocode_delay,
            ): _clean(record.get("ACMDFCLTY_SN"))
            for record in missing_addresses
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            serial = futures[future]
            try:
                addresses[serial] = future.result()
            except RuntimeError as exc:
                print(f"warning: facility {serial}: {exc}")
            if completed % 20 == 0 or completed == len(futures):
                print(f"resolved {completed}/{len(futures)} addresses")

    by_id: dict[str, dict[str, Any]] = {}
    for record in selected:
        serial = _clean(record.get("ACMDFCLTY_SN"))
        item = convert_record(
            record,
            _fallback_address(record) or addresses.get(serial) or "경상북도 구미시",
        )
        if item["id"] in by_id:
            raise RuntimeError(f"중복 시설 ID: {item['id']}")
        by_id[item["id"]] = item

    shelters = sorted(by_id.values(), key=lambda item: (item["name"], item["id"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(shelters, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"created: {args.output} ({len(shelters)} Gumi temporary housing facilities; "
        f"generated={datetime.now(UTC).isoformat()})"
    )


if __name__ == "__main__":
    main()
