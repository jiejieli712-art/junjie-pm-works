# -*- coding: utf-8 -*-
"""
04_location_fallback_test.py

测试场景：
- 用户授权定位：使用实时经纬度
- 用户未授权定位：使用 IP 所处城市中心点兜底
- 后台调用：选择城市 + 可手动输入经纬度；不输入则用城市中心点
"""

import argparse
from pathlib import Path

from common_meituan import (
    load_json,
    request_by_keyword,
    normalize_products,
    dedup_products,
    filter_local_life,
    save_json,
    summarize_products,
)

DEFAULT_CITY_CENTERS = {
    "徐州": {"longitude": 117.186361, "latitude": 34.260681},
    "南京": {"longitude": 118.796877, "latitude": 32.060255},
    "上海": {"longitude": 121.473701, "latitude": 31.230416},
    "北京": {"longitude": 116.407526, "latitude": 39.904030},
}


def get_city_center(args):
    if args.city_centers:
        data = load_json(args.city_centers)
    else:
        data = DEFAULT_CITY_CENTERS

    if args.city not in data:
        raise ValueError(f"城市中心点配置中找不到城市：{args.city}")

    return data[args.city]


def fetch(args, keyword, lng, lat, scene):
    result = request_by_keyword(
        keyword=keyword,
        longitude=lng,
        latitude=lat,
        page_no=1,
        page_size=args.page_size,
        sort_field=args.sort_field,
        debug=args.debug,
    )
    products = normalize_products(result, keyword=keyword, page_no=1, source_category=scene)
    unique = dedup_products(products)
    kept, excluded = filter_local_life(unique)

    return {
        "scene": scene,
        "longitude": lng,
        "latitude": lat,
        "resultCode": result.get("code"),
        "message": result.get("message"),
        "rawCount": len(products),
        "uniqueCount": len(unique),
        "keptCount": len(kept),
        "excludedCount": len(excluded),
        "summaryKept": summarize_products(kept),
        "productsKept": kept,
        "productsExcluded": excluded,
        "rawResult": result,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", default="酒店")
    parser.add_argument("--real-longitude", type=float, default=None)
    parser.add_argument("--real-latitude", type=float, default=None)
    parser.add_argument("--city", default="徐州")
    parser.add_argument("--city-centers", default=None)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--sort-field", type=int, default=1)
    parser.add_argument("--output-dir", default="output_04_location_fallback")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    city_center = get_city_center(args)

    cases = []

    if args.real_longitude is not None and args.real_latitude is not None:
        cases.append(("real_location", args.real_longitude, args.real_latitude))

    cases.append(("ip_city_fallback_or_backend_city_center", city_center["longitude"], city_center["latitude"]))

    results = {}
    for scene, lng, lat in cases:
        print(f"\n>>> 场景={scene} keyword={args.keyword} lng={lng} lat={lat}")
        data = fetch(args, args.keyword, lng, lat, scene)
        results[scene] = {k: v for k, v in data.items() if k not in ("rawResult",)}
        save_json(out / f"{scene}_raw.json", data["rawResult"])
        save_json(out / f"{scene}_products_kept.json", data["productsKept"])
        save_json(out / f"{scene}_products_excluded.json", data["productsExcluded"])

    save_json(out / "00_location_fallback_summary.json", results)

    report = out / "01_定位与兜底测试报告.txt"
    lines = []
    lines.append("定位与兜底测试报告")
    lines.append("=" * 90)
    lines.append(f"关键词：{args.keyword}")
    lines.append(f"兜底城市：{args.city}")
    lines.append("")
    for scene, data in results.items():
        lines.append(f"## {scene}")
        lines.append(f"- 经纬度：{data['longitude']}, {data['latitude']}")
        lines.append(f"- 接口状态：{data['resultCode']} {data['message']}")
        lines.append(f"- 去重商品数：{data['uniqueCount']}")
        lines.append(f"- 保留商品数：{data['keptCount']}")
        lines.append(f"- bizLine：{data['summaryKept']['bizLine']}")
        lines.append(f"- categoryName：{data['summaryKept']['categoryName']}")
        lines.append("- 样例：")
        for p in data["productsKept"][:20]:
            lines.append(
                f"  - {p.get('name')} | price=¥{p.get('sellPrice')} | "
                f"poi={p.get('poiName')} | distance={p.get('distanceText')}"
            )
        lines.append("")
    lines.append("判断：未授权定位时不能空白，应使用 IP 所处城市中心点兜底，并提示用户开启定位。")
    report.write_text("\n".join(lines), encoding="utf-8")

    print("\n测试完成")
    print("输出目录:", out)
    print("报告:", report)


if __name__ == "__main__":
    main()
