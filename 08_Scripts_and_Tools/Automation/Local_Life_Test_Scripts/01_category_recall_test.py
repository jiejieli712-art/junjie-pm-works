# -*- coding: utf-8 -*-
"""
01_category_recall_test.py

测试场景：
- 本地生活 5 个一级分类
- 多关键词召回
- 合并去重
- 规则过滤餐饮/电影/无关商品
"""

import argparse
import time
from pathlib import Path

from common_meituan import (
    request_by_keyword,
    normalize_products,
    dedup_products,
    filter_local_life,
    summarize_products,
    save_json,
)

CATEGORY_KEYWORDS = {
    "hotel": {"label": "酒店住宿", "keywords": ["酒店"], "need_test": False},
    "leisure": {"label": "休闲娱乐", "keywords": ["洗浴", "足疗", "按摩", "SPA", "KTV"], "need_test": False},
    "scenic": {"label": "景点门票", "keywords": ["景点", "乐园", "门票"], "need_test": True},
    "beauty_hair": {"label": "美容美发", "keywords": ["美容", "美发", "美甲", "美睫", "护理"], "need_test": False},
    "fitness": {"label": "运动健身", "keywords": ["健身", "瑜伽", "普拉提", "运动"], "need_test": True},
}


def parse_categories(text: str | None):
    if not text:
        return list(CATEGORY_KEYWORDS.keys())
    return [x.strip() for x in text.replace("，", ",").split(",") if x.strip()]


def run_category(args, category_code: str, cfg: dict):
    all_raw = []
    all_products = []

    for keyword in cfg["keywords"]:
        search_id = None
        for page_no in range(1, args.max_pages + 1):
            print(f"\n>>> 分类={cfg['label']} keyword={keyword} page={page_no}")

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
            all_raw.append(result)

            print("code:", result.get("code"), "| message:", result.get("message"),
                  "| hasNext:", result.get("hasNext"), "| searchId:", result.get("searchId"))

            if result.get("code") != 0:
                break

            products = normalize_products(
                result,
                keyword=keyword,
                page_no=page_no,
                source_category=category_code
            )
            all_products.extend(products)

            if result.get("searchId"):
                search_id = result.get("searchId")
            if not result.get("hasNext"):
                break

            time.sleep(args.sleep_seconds)

    unique = dedup_products(all_products)
    kept, excluded = filter_local_life(unique)

    return {
        "categoryCode": category_code,
        "categoryLabel": cfg["label"],
        "needTest": cfg["need_test"],
        "keywords": cfg["keywords"],
        "rawCount": len(all_products),
        "uniqueCount": len(unique),
        "keptCount": len(kept),
        "excludedCount": len(excluded),
        "summaryAll": summarize_products(unique),
        "summaryKept": summarize_products(kept),
        "rawResults": all_raw,
        "productsAll": unique,
        "productsKept": kept,
        "productsExcluded": excluded,
    }


def write_report(path: Path, results: dict):
    lines = []
    lines.append("本地生活分类召回与过滤测试报告")
    lines.append("=" * 90)
    lines.append("")
    lines.append("一、分类总览")
    for code, data in results.items():
        mark = "【需测试确认】" if data["needTest"] else ""
        lines.append(
            f"- {data['categoryLabel']}({code}){mark}: "
            f"关键词={','.join(data['keywords'])}，"
            f"原始={data['rawCount']}，去重={data['uniqueCount']}，"
            f"保留={data['keptCount']}，过滤={data['excludedCount']}"
        )

    lines.append("")
    lines.append("二、各分类保留商品分布")
    for code, data in results.items():
        lines.append("")
        lines.append(f"## {data['categoryLabel']}({code})")
        lines.append(f"- 保留商品数：{data['keptCount']}")
        lines.append(f"- 平台分布：{data['summaryKept']['platform']}")
        lines.append(f"- bizLine 分布：{data['summaryKept']['bizLine']}")
        lines.append(f"- categoryName 分布：{data['summaryKept']['categoryName']}")
        lines.append(f"- sourceKeyword 分布：{data['summaryKept']['sourceKeyword']}")

        samples = data["productsKept"][:20]
        lines.append("- 样例：")
        for p in samples:
            lines.append(
                f"  - {p.get('name')} | keyword={p.get('sourceKeyword')} | "
                f"category={p.get('categoryName')} | price=¥{p.get('sellPrice')} | "
                f"poi={p.get('poiName')} | distance={p.get('distanceText')}"
            )

    lines.append("")
    lines.append("三、判断建议")
    lines.append("- 若某分类保留商品数过少，首版可隐藏该入口。")
    lines.append("- 若过滤商品很多，说明关键词或过滤规则需要优化。")
    lines.append("- 景点门票、运动健身属于需测试确认分类，上线前重点看商品相关性。")
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--longitude", type=float, default=117.186361)
    parser.add_argument("--latitude", type=float, default=34.260681)
    parser.add_argument("--categories", default=None, help="hotel,leisure,scenic,beauty_hair,fitness")
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--sort-field", type=int, default=1)
    parser.add_argument("--output-dir", default="output_01_category_recall")
    parser.add_argument("--sleep-seconds", type=float, default=0.4)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    results = {}
    for code in parse_categories(args.categories):
        if code not in CATEGORY_KEYWORDS:
            print(f"跳过未知分类：{code}")
            continue

        result = run_category(args, code, CATEGORY_KEYWORDS[code])
        results[code] = {k: v for k, v in result.items() if k != "rawResults"}

        save_json(out / f"{code}_raw_results.json", result["rawResults"])
        save_json(out / f"{code}_products_all.json", result["productsAll"])
        save_json(out / f"{code}_products_kept.json", result["productsKept"])
        save_json(out / f"{code}_products_excluded.json", result["productsExcluded"])

    save_json(out / "00_summary.json", results)
    write_report(out / "00_分类召回与过滤测试报告.txt", results)

    print("\n测试完成")
    print("输出目录:", out)
    print("报告:", out / "00_分类召回与过滤测试报告.txt")


if __name__ == "__main__":
    main()
