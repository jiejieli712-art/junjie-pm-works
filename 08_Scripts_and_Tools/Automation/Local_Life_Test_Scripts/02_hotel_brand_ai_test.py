# -*- coding: utf-8 -*-
"""
02_hotel_brand_ai_test.py

测试场景：
- 酒店商品首次入库/更新时，同步调用千问 AI 识别我方品牌字段。
- 品牌库由后台手动维护。
- AI 只能在品牌库范围内选择品牌。
- AI 失败时使用规则兜底，不阻塞商品返回。
"""

import argparse
import time
from pathlib import Path

from common_meituan import load_json, save_json
from common_brand_ai import load_brand_library, normalize_brand_lib, classify_brand


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--products", required=True, help="hotel_products_kept.json")
    parser.add_argument("--brand-library", default="brand_library_sample.json")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--output-dir", default="output_02_hotel_brand_ai")
    parser.add_argument("--sleep-seconds", type=float, default=0.2)
    parser.add_argument("--rule-only", action="store_true", help="不调用千问，只用规则匹配")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    products = load_json(args.products)
    if args.limit and args.limit > 0:
        products = products[:args.limit]

    brands = normalize_brand_lib(load_brand_library(args.brand_library))

    results = []
    for i, p in enumerate(products, start=1):
        print(f"\n>>> {i}/{len(products)} {p.get('name')}")
        final_brand, source, reason = classify_brand(
            p,
            brands,
            rule_only=args.rule_only,
            debug=args.debug
        )

        row = {
            "productName": p.get("name"),
            "meituanBrandName": p.get("brandNameFromMeituan"),
            "poiName": p.get("poiName"),
            "finalBrand": final_brand,
            "brandSource": source,
            "reason": reason,
            "product": p,
        }
        print("识别品牌:", final_brand, "| 来源:", source, "| 原因:", reason)
        results.append(row)

        time.sleep(args.sleep_seconds)

    summary = {
        "total": len(results),
        "knownBrandCount": sum(1 for r in results if r["finalBrand"] != "UNKNOWN"),
        "unknownBrandCount": sum(1 for r in results if r["finalBrand"] == "UNKNOWN"),
        "byBrand": {}
    }
    for r in results:
        summary["byBrand"][r["finalBrand"]] = summary["byBrand"].get(r["finalBrand"], 0) + 1

    save_json(out / "00_brand_ai_results.json", results)
    save_json(out / "01_brand_ai_summary.json", summary)

    report = out / "02_酒店品牌AI识别测试报告.txt"
    lines = []
    lines.append("酒店品牌 AI 识别测试报告")
    lines.append("=" * 90)
    lines.append(f"测试商品数：{summary['total']}")
    lines.append(f"识别到品牌：{summary['knownBrandCount']}")
    lines.append(f"未知品牌：{summary['unknownBrandCount']}")
    lines.append("")
    lines.append("品牌分布：")
    for k, v in sorted(summary["byBrand"].items(), key=lambda x: -x[1]):
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("样例：")
    for r in results[:80]:
        lines.append(f"- {r['productName']} => {r['finalBrand']}（{r['brandSource']}）")
    report.write_text("\n".join(lines), encoding="utf-8")

    print("\n测试完成")
    print("输出目录:", out)
    print("报告:", report)


if __name__ == "__main__":
    main()
