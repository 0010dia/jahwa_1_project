from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import seed_demo_flood_reports


def main() -> None:
    result = seed_demo_flood_reports()
    print(
        f"데모 침수 데이터 {result['inserted']}건을 추가했습니다. "
        f"정의된 샘플은 총 {result['total']}건입니다."
    )


if __name__ == "__main__":
    main()
