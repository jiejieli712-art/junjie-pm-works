# -*- coding: utf-8 -*-
"""
03_hotel_brand_filter_test.py

测试场景：
- 用户进入酒店住宿页
- 默认请求“酒店”
- 用户多选品牌，最多 5 个
- 后端用品牌名作为关键词补充请求美团
- 商品入库/更新并识别品牌
- 按我方品牌字段 OR 过滤
- 返回符合品牌条件的酒店商品
"""

import argparse
import time
from pathlib import Path

from common_meituan import (
    request_by_keyword,
    normalize_products,
    dedup_products,
    filter_local_life,
    save_json,
    summarize_products,
)
from common_brand_ai import load_brand_library, normalize_brand_lib, classify_brand


def parse_brands(text: str) -> list[str]:
    return [x.strip() for x in text.replace("，", ",").split(",") if x.strip()]


def fetch_keyword(args, keyword: str, source_category: str = "hotel"):
    all_products = []
    search_id = None
    for page_no in range(1, args.max_pages + 1):
        print(f"\n>>> 请求 keyword={keyword} page={page_no}")
        result = request_by_keyword(
            keyword=keyword,
            longitude=args.longitude,
            latitude=args.latitude,
            page_no=page_no,
            page_size=args.page_size,
            sort_field=args.sort_field,
            search_id=search_id,
            debug=args.debug,
        )
        print("code:", result.get("code"), "| message:", result.get("message"),
              "| hasNext:", result.get("hasNext"))
        if result.get("code") != 0:
            break
        products = normalize_products(result, keyword=keyword, page_no=page_no, source_category=source_category)
        all_products.extend(products)

        if result.get("searchId"):
            search_id = result.get("searchId")
        if not result.get("hasNext"):
            break
        time.sleep(args.sleep_seconds)
    return all_products


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brands", required=True, help="多选品牌，逗号分隔，最多5个，例如：如家,亚朵")
    parser.add_argument("--brand-library", default="brand_library_sample.json")
    parser.add_argument("--longitude", type=float, default=117.186361)
    parser.add_argument("--latitude", type=float, default=34.260681)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--sort-field", type=int, default=1)
    parser.add_argument("--output-dir", default="output_03_hotel_brand_filter")
    parser.add_argument("--sleep-seconds", type=float, default=0.4)
    parser.add_argument("--rule-only", action="store_true")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    selected = parse_brands(args.brands)
    if len(selected) > 5:
        raise ValueError("最多选择 5 个品牌")

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    brands = normalize_brand_lib(load_brand_library(args.brand_library))
    brand_names = {b["name"] for b in brands}
    for b in selected:
        if b not in brand_names:
            raise ValueError(f"品牌库中不存在品牌：{b}")

    # 方案 C：默认请求“酒店” + 品牌名关键词补充请求
    keywords = ["酒店"] + selected

    products = []
    for kw in keywords:
        products.extend(fetch_keyword(args, kw))

    unique = dedup_products(products)
    kept, excluded = filter_local_life(unique)

    classified = []
    for i, p in enumerate(kept, start=1):
        print(f"\n>>> 品牌识别 {i}/{len(kept)} {p.get('name')}")
        final_brand, source, reason = classify_brand(
            p, brands, rule_only=args.rule_only, debug=args.debug
        )
        q = dict(p)
        q["myBrand"] = final_brand
        q["brandSource"] = source
        q["brandReason"] = reason
        classified.append(q)

    # OR 关系过滤
    selected_set = set(selected)
    filtered = [p for p in classified if p.get("myBrand") in selected_set]

    save_json(out / "00_all_products_unique.json", unique)
    save_json(out / "01_products_kept_after_rule_filter.json", kept)
    save_json(out / "02_products_excluded.json", excluded)
    save_json(out / "03_products_classified.json", classified)
    save_json(out / "04_products_filtered_by_selected_brands.json", filtered)
    save_json(out / "05_summary.json", {
        "selectedBrands": selected,
        "requestKeywords": keywords,
        "uniqueCount": len(unique),
        "keptCount": len(kept),
        "filteredCount": len(filtered),
        "summaryFiltered": summarize_products(filtered),
    })

    report = out / "06_酒店品牌多选筛选测试报告.txt"
    lines = []
    lines.append("酒店品牌多选筛选测试报告")
    lines.append("=" * 90)
    lines.append(f"选择品牌：{', '.join(selected)}")
    lines.append(f"请求关键词：{', '.join(keywords)}")
    lines.append(f"召回去重商品数：{len(unique)}")
    lines.append(f"规则过滤后商品数：{len(kept)}")
    lines.append(f"品牌过滤后商品数：{len(filtered)}")
    lines.append("")
    lines.append("筛选结果样例：")
    for p in filtered[:80]:
        lines.append(
            f"- [{p.get('myBrand')}] {p.get('name')} | price=¥{p.get('sellPrice')} | "
            f"poi={p.get('poiName')} | distance={p.get('distanceText')} | source={p.get('brandSource')}"
        )
    report.write_text("\n".join(lines), encoding="utf-8")

    print("\n测试完成")
    print("输出目录:", out)
    print("报告:", report)


if __name__ == "__main__":
    main()
