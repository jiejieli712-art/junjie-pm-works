# -*- coding: utf-8 -*-
"""
美团商品查询接口：非美食类商品搜索测试脚本

用途：
1. 使用 query_coupon 的 searchText 搜索酒店、洗浴、足疗、KTV、电影、景点等非美食类商品。
2. 观察接口是否返回酒店、休闲娱乐、丽人、运动健身等非餐饮商品。
3. 输出原始 JSON、标准化商品 JSON、关键词汇总、测试报告。

运行前设置环境变量：
PowerShell:
$env:MT_APP_KEY="你的AppKey"
$env:MT_APP_SECRET="你的AppSecret"

默认运行：
py -u .\美团非美食商品搜索测试.py

指定关键词：
py -u .\美团非美食商品搜索测试.py --keywords "酒店,洗浴,足疗,KTV,电影,景点"

多页测试：
py -u .\美团非美食商品搜索测试.py --max-pages 3

只看 platform=2 的返回：
py -u .\美团非美食商品搜索测试.py --filter-platform 2

排除餐饮类关键词结果：
py -u .\美团非美食商品搜索测试.py --exclude-food

说明：
- searchText 是全品类搜索。脚本默认不在请求里传 platform / bizLine，避免限制召回。
- 经纬度会自动乘以 1000000。
- 下一页如果接口返回 searchId，脚本会自动带上 searchId。
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import time
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

import requests


API_URL = "https://media.meituan.com/cps_open/common/api/v1/query_coupon"
METHOD = "POST"

DEFAULT_KEYWORDS = [
    "酒店", "洗浴", "足疗", "按摩", "KTV", "电影", "景点", "美容", "美发", "健身"
]


def coordinate_to_api_value(value: float) -> int:
    return int(round(float(value) * 1_000_000))


def json_body_bytes(body: dict) -> bytes:
    return json.dumps(
        body,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def content_md5_base64(body_bytes: bytes) -> str:
    return base64.b64encode(hashlib.md5(body_bytes).digest()).decode("utf-8")


def hmac_sha256_base64(secret: str, string_to_sign: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def build_sign_headers(app_key: str, app_secret: str, body: dict):
    """
    已验证通过的签名方式：

    POST
    Content-MD5
    S-Ca-App:xxx
    S-Ca-Timestamp:xxx
    /cps_open/common/api/v1/query_coupon

    注意：body 参数不参与 stringToSign 拼接。
    """
    timestamp = str(int(time.time() * 1000))
    body_bytes = json_body_bytes(body)
    md5_value = content_md5_base64(body_bytes)
    path = urlparse(API_URL).path

    headers_string = f"S-Ca-App:{app_key}\nS-Ca-Timestamp:{timestamp}\n"
    string_to_sign = f"{METHOD}\n{md5_value}\n{headers_string}{path}"
    signature = hmac_sha256_base64(app_secret, string_to_sign)

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "S-Ca-App": app_key,
        "S-Ca-Timestamp": timestamp,
        "S-Ca-Signature": signature,
        "S-Ca-Signature-Headers": "S-Ca-App,S-Ca-Timestamp",
        "Content-MD5": md5_value,
    }
    return body_bytes, headers, string_to_sign


def query_coupon(body: dict, debug: bool = False) -> dict:
    app_key = (os.getenv("MT_APP_KEY") or "").strip()
    app_secret = (os.getenv("MT_APP_SECRET") or "").strip()

    if not app_key or not app_secret:
        raise RuntimeError("请先设置环境变量 MT_APP_KEY 和 MT_APP_SECRET")

    body_bytes, headers, string_to_sign = build_sign_headers(app_key, app_secret, body)

    if debug:
        print("\n========== Request Body ==========")
        print(body_bytes.decode("utf-8"))
        print("\n========== StringToSign ==========")
        print(string_to_sign)

    resp = requests.post(API_URL, data=body_bytes, headers=headers, timeout=25)

    try:
        result = resp.json()
    except Exception:
        raise RuntimeError(f"接口返回非 JSON：HTTP {resp.status_code}\n{resp.text}")

    result["_debug"] = {
        "httpStatus": resp.status_code,
        "requestBody": body,
        "contentMd5": headers.get("Content-MD5"),
    }
    return result


def parse_keywords(text: str | None) -> list[str]:
    if not text:
        return DEFAULT_KEYWORDS
    result = []
    for part in text.replace("，", ",").split(","):
        kw = part.strip()
        if kw:
            result.append(kw)
    return result


def is_present(value) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def money_text(value):
    if value is None or value == "":
        return None
    try:
        return f"{float(value):.2f}"
    except Exception:
        return str(value)


def normalize_product(raw: dict, keyword: str, page_no: int, index: int) -> dict:
    detail = raw.get("couponPackDetail") or {}
    deliverable = raw.get("deliverablePoiInfo") or {}
    available = raw.get("availablePoiInfo") or {}
    brand = raw.get("brandInfo") or {}
    commission = raw.get("commissionInfo") or {}
    valid_time = raw.get("couponValidTimeInfo") or {}
    purchase_limit = raw.get("purchaseLimitInfo") or {}

    product_label = detail.get("productLabel") or {}
    price_power = product_label.get("pricePowerLabel") or {}

    labels = []
    for key in ["historyPriceLabel", "beatMTLabel"]:
        if price_power.get(key):
            labels.append(price_power.get(key))
    for key in ["productRankLabel", "dianPingRankLabel"]:
        if product_label.get(key):
            labels.append(str(product_label.get(key)))

    return {
        "keyword": keyword,
        "pageNo": page_no,
        "index": index,
        "productViewSign": detail.get("productViewSign"),
        "skuViewId": detail.get("skuViewId"),
        "name": detail.get("name"),
        "specification": detail.get("specification"),
        "headUrl": detail.get("headUrl"),
        "platform": detail.get("platform"),
        "bizLine": detail.get("bizLine"),
        "categoryName": detail.get("categoryName"),
        "saleStatus": detail.get("saleStatus"),
        "saleVolume": detail.get("saleVolume"),
        "couponNum": detail.get("couponNum"),
        "validTime": detail.get("validTime"),
        "startTime": detail.get("startTime"),
        "endTime": detail.get("endTime"),
        "originalPrice": money_text(detail.get("originalPrice")),
        "sellPrice": money_text(detail.get("sellPrice")),
        "historyPriceLabel": price_power.get("historyPriceLabel"),
        "beatMTLabel": price_power.get("beatMTLabel"),
        "productRankLabel": product_label.get("productRankLabel"),
        "dianPingRankLabel": product_label.get("dianPingRankLabel"),
        "labels": labels,
        "brandName": brand.get("brandName"),
        "brandLogoUrl": brand.get("brandLogoUrl"),
        "availablePoiNum": available.get("availablePoiNum"),
        "availableCityNum": available.get("availableCityNum"),
        "commissionPercent": commission.get("commissionPercent"),
        "commission": commission.get("commission"),
        "poiName": deliverable.get("poiName"),
        "poiLogoUrl": deliverable.get("poiLogoUrl"),
        "deliveryDistance": deliverable.get("deliveryDistance"),
        "distributionCost": deliverable.get("distributionCost"),
        "deliveryDuration": deliverable.get("deliveryDuration"),
        "lastDeliveryFee": deliverable.get("lastDeliveryFee"),
        "singleDayPurchaseLimit": purchase_limit.get("singleDayPurchaseLimit"),
        "purchaseLimitInfo": purchase_limit,
        "couponValidTimeType": valid_time.get("couponValidTimeType"),
        "couponValidDay": valid_time.get("couponValidDay"),
        "couponValidSTime": valid_time.get("couponValidSTime"),
        "couponValidETime": valid_time.get("couponValidETime"),
    }


def normalize_products(result: dict, keyword: str, page_no: int) -> list[dict]:
    return [
        normalize_product(raw, keyword=keyword, page_no=page_no, index=i)
        for i, raw in enumerate(result.get("data") or [], start=1)
    ]


def build_search_body(args, keyword: str, page_no: int, search_id: str | None = None) -> dict:
    body = {
        "searchText": keyword,
        "longitude": coordinate_to_api_value(args.longitude),
        "latitude": coordinate_to_api_value(args.latitude),
        "pageNo": page_no,
        "pageSize": args.page_size,
    }
    if args.sort_field is not None:
        body["sortField"] = args.sort_field
    if search_id:
        body["searchId"] = search_id
    return body


def apply_local_filter(products: list[dict], args) -> list[dict]:
    result = products

    if args.filter_platform is not None:
        result = [p for p in result if p.get("platform") == args.filter_platform]

    if args.filter_biz_line is not None:
        result = [p for p in result if p.get("bizLine") == args.filter_biz_line]

    if args.exclude_food:
        food_words = [
            "美食", "餐饮", "小吃", "快餐", "咖啡", "饮品", "奶茶", "火锅", "烧烤", "烘焙", "甜品",
            "汉堡", "炸鸡", "面包", "蛋糕", "茶饮"
        ]
        filtered = []
        for p in result:
            text = " ".join([
                str(p.get("name") or ""),
                str(p.get("categoryName") or ""),
                str(p.get("brandName") or ""),
            ])
            if not any(w in text for w in food_words):
                filtered.append(p)
        result = filtered

    return result


def product_key(p: dict) -> str:
    return p.get("productViewSign") or p.get("skuViewId") or f"{p.get('name')}|{p.get('sellPrice')}"


def deduplicate_products(products: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for p in products:
        key = product_key(p)
        if key in seen:
            continue
        seen.add(key)
        result.append(p)
    return result


def summarize_products(products: list[dict]) -> dict:
    platform_counter = Counter()
    biz_line_counter = Counter()
    category_counter = Counter()
    brand_counter = Counter()
    field_hits = defaultdict(int)

    fields = [
        "name", "headUrl", "platform", "bizLine", "categoryName", "saleVolume", "originalPrice", "sellPrice",
        "brandName", "commissionPercent", "commission", "poiName", "deliveryDistance", "distributionCost",
        "deliveryDuration", "lastDeliveryFee",
    ]

    for p in products:
        platform_counter[str(p.get("platform"))] += 1
        biz_line_counter[str(p.get("bizLine"))] += 1
        category_counter[str(p.get("categoryName"))] += 1
        brand_counter[str(p.get("brandName"))] += 1
        for f in fields:
            if is_present(p.get(f)):
                field_hits[f] += 1

    return {
        "total": len(products),
        "platformDistribution": dict(platform_counter.most_common()),
        "bizLineDistribution": dict(biz_line_counter.most_common()),
        "categoryDistribution": dict(category_counter.most_common(40)),
        "brandDistribution": dict(brand_counter.most_common(40)),
        "fieldHits": {
            f: {
                "hit": field_hits[f],
                "total": len(products),
                "rate": round(field_hits[f] / len(products), 4) if products else 0,
            }
            for f in fields
        },
    }


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def print_products(products: list[dict], limit: int = 10):
    for p in products[:limit]:
        print(
            f"  {p.get('keyword')} P{p.get('pageNo')}-{p.get('index')}. "
            f"{p.get('name')} | "
            f"platform={p.get('platform')} | bizLine={p.get('bizLine')} | "
            f"category={p.get('categoryName')} | "
            f"brand={p.get('brandName')} | "
            f"price=¥{p.get('sellPrice')} | sales={p.get('saleVolume')} | "
            f"poi={p.get('poiName')} | distance={p.get('deliveryDistance')}"
        )


def write_report(path: Path, args, all_products: list[dict], keyword_summaries: dict, filtered_products: list[dict]):
    summary_all = summarize_products(all_products)
    summary_filtered = summarize_products(filtered_products)

    lines = []
    lines.append("美团商品查询接口：非美食类商品搜索测试报告")
    lines.append("=" * 90)
    lines.append("")
    lines.append("一、测试参数")
    lines.append(f"- keywords: {', '.join(parse_keywords(args.keywords))}")
    lines.append(f"- longitude: {args.longitude}")
    lines.append(f"- latitude: {args.latitude}")
    lines.append(f"- pageSize: {args.page_size}")
    lines.append(f"- maxPages: {args.max_pages}")
    lines.append(f"- sortField: {args.sort_field}")
    lines.append(f"- filterPlatform: {args.filter_platform}")
    lines.append(f"- filterBizLine: {args.filter_biz_line}")
    lines.append(f"- excludeFood: {args.exclude_food}")
    lines.append("")

    lines.append("二、总体结果")
    lines.append(f"- 原始去重商品数：{len(all_products)}")
    lines.append(f"- 本地筛选后商品数：{len(filtered_products)}")
    lines.append("")

    lines.append("三、按关键词统计")
    lines.append("-" * 90)
    for kw, data in keyword_summaries.items():
        lines.append(
            f"- {kw}: 原始 {data['rawCount']} 条，去重 {data['uniqueCount']} 条，"
            f"筛选后 {data['filteredCount']} 条，hasNext={data['lastHasNext']}，searchId={data['lastSearchId']}"
        )

    lines.append("")
    lines.append("四、原始结果 platform 分布")
    for k, v in summary_all["platformDistribution"].items():
        lines.append(f"- platform={k}: {v}")

    lines.append("")
    lines.append("五、原始结果 bizLine 分布")
    for k, v in summary_all["bizLineDistribution"].items():
        lines.append(f"- bizLine={k}: {v}")

    lines.append("")
    lines.append("六、原始结果 categoryName Top40")
    for k, v in summary_all["categoryDistribution"].items():
        lines.append(f"- {k}: {v}")

    lines.append("")
    lines.append("七、筛选后 categoryName Top40")
    for k, v in summary_filtered["categoryDistribution"].items():
        lines.append(f"- {k}: {v}")

    lines.append("")
    lines.append("八、字段命中率")
    for f, data in summary_all["fieldHits"].items():
        lines.append(f"- {f}: {data['hit']}/{data['total']}，rate={data['rate']}")

    lines.append("")
    lines.append("九、筛选后商品样例")
    lines.append("-" * 90)
    for p in filtered_products[:100]:
        lines.append(
            f"{p.get('keyword')} P{p.get('pageNo')}-{p.get('index')}. "
            f"{p.get('name')} | platform={p.get('platform')} | bizLine={p.get('bizLine')} | "
            f"category={p.get('categoryName')} | brand={p.get('brandName')} | "
            f"price=¥{p.get('sellPrice')} | sales={p.get('saleVolume')} | "
            f"poi={p.get('poiName')} | distance={p.get('deliveryDistance')}"
        )

    lines.append("")
    lines.append("十、结论建议")
    lines.append("1. searchText 是全品类搜索，适合验证酒店、洗浴、足疗、KTV、电影、景点等非餐饮商品是否会返回。")
    lines.append("2. 后端不要在搜索请求里写死餐饮 platform/bizLine；先看真实返回，再按 platform/bizLine/categoryName 做业务筛选。")
    lines.append("3. 如果当前业务仍叫“平价优选餐饮”，后端必须过滤非餐饮结果；如果要扩展为本地生活优惠，可保留非美食类商品。")
    lines.append("4. 前端展示仍然遵循：字段有值才展示，无值不展示。")

    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="美团商品查询接口：非美食类商品搜索测试脚本")
    parser.add_argument("--keywords", default=None, help='关键词，逗号分隔，例如 "酒店,洗浴,足疗,KTV,电影,景点"')
    parser.add_argument("--longitude", type=float, default=117.186361, help="经度")
    parser.add_argument("--latitude", type=float, default=34.260681, help="纬度")
    parser.add_argument("--page-size", type=int, default=20, help="每页数量")
    parser.add_argument("--max-pages", type=int, default=2, help="每个关键词最多查询页数")
    parser.add_argument("--sort-field", type=int, default=1, help="排序字段；不想传则传 -1")
    parser.add_argument("--filter-platform", type=int, default=None, help="本地筛选 platform，例如 2")
    parser.add_argument("--filter-biz-line", type=int, default=None, help="本地筛选 bizLine")
    parser.add_argument("--exclude-food", action="store_true", help="本地简单排除餐饮/美食类结果")
    parser.add_argument("--output-dir", default="meituan_non_food_search_output", help="输出目录")
    parser.add_argument("--sleep-seconds", type=float, default=0.4, help="请求间隔")
    parser.add_argument("--debug", action="store_true", help="打印签名调试信息")
    args = parser.parse_args()
    if args.sort_field == -1:
        args.sort_field = None
    return args


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    keywords = parse_keywords(args.keywords)

    print("========== 测试配置 ==========")
    print("keywords:", keywords)
    print("longitude:", args.longitude)
    print("latitude:", args.latitude)
    print("pageSize:", args.page_size)
    print("maxPages:", args.max_pages)
    print("sortField:", args.sort_field)
    print("output_dir:", output_dir)

    all_products = []
    all_raw_results = {}
    keyword_summaries = {}

    for keyword in keywords:
        print("\n" + "=" * 90)
        print(f"开始搜索关键词：{keyword}")
        print("=" * 90)

        keyword_products = []
        keyword_raw_results = []
        search_id = None
        last_has_next = None
        last_search_id = None

        for page_no in range(1, args.max_pages + 1):
            body = build_search_body(args, keyword=keyword, page_no=page_no, search_id=search_id)
            print(f"\n>>> 请求 keyword={keyword} pageNo={page_no}")
            print(json.dumps(body, ensure_ascii=False, indent=2))

            result = query_coupon(body, debug=args.debug)
            keyword_raw_results.append(result)

            code = result.get("code")
            message = result.get("message")
            has_next = result.get("hasNext")
            returned_search_id = result.get("searchId")

            print("HTTP Status:", result.get("_debug", {}).get("httpStatus"))
            print("code:", code, "| message:", message, "| hasNext:", has_next, "| searchId:", returned_search_id)

            if code != 0:
                print("接口返回非成功，停止该关键词后续分页。")
                break

            products = normalize_products(result, keyword=keyword, page_no=page_no)
            keyword_products.extend(products)

            print("本页商品数:", len(products))
            print_products(products, limit=8)

            last_has_next = has_next
            last_search_id = returned_search_id

            if returned_search_id:
                search_id = returned_search_id
            if not has_next:
                break
            if args.sleep_seconds > 0:
                time.sleep(args.sleep_seconds)

        unique_products = deduplicate_products(keyword_products)
        filtered_products = apply_local_filter(unique_products, args)
        all_products.extend(unique_products)
        all_raw_results[keyword] = keyword_raw_results

        keyword_summaries[keyword] = {
            "rawCount": len(keyword_products),
            "uniqueCount": len(unique_products),
            "filteredCount": len(filtered_products),
            "lastHasNext": last_has_next,
            "lastSearchId": last_search_id,
        }

        safe_keyword = keyword.replace("/", "_").replace("\\", "_").replace(":", "_")
        save_json(output_dir / f"{safe_keyword}_raw_results.json", keyword_raw_results)
        save_json(output_dir / f"{safe_keyword}_products.json", keyword_products)
        save_json(output_dir / f"{safe_keyword}_products_unique.json", unique_products)
        save_json(output_dir / f"{safe_keyword}_products_filtered.json", filtered_products)

    all_products_unique = deduplicate_products(all_products)
    filtered_all = apply_local_filter(all_products_unique, args)

    save_json(output_dir / "00_all_raw_results.json", all_raw_results)
    save_json(output_dir / "01_all_products_unique.json", all_products_unique)
    save_json(output_dir / "02_all_products_filtered.json", filtered_all)
    save_json(output_dir / "03_keyword_summaries.json", keyword_summaries)
    save_json(output_dir / "04_summary_all.json", {
        "all": summarize_products(all_products_unique),
        "filtered": summarize_products(filtered_all),
        "keywordSummaries": keyword_summaries,
    })

    report_path = output_dir / "05_非美食商品搜索测试报告.txt"
    write_report(report_path, args, all_products_unique, keyword_summaries, filtered_all)

    print("\n" + "=" * 90)
    print("测试完成")
    print("=" * 90)
    print("输出目录:", output_dir)
    print("总商品去重数:", len(all_products_unique))
    print("本地筛选后商品数:", len(filtered_all))
    print("报告:", report_path)
    print("汇总 JSON:", output_dir / "04_summary_all.json")
    print("筛选后商品 JSON:", output_dir / "02_all_products_filtered.json")
    print("\n建议先打开：05_非美食商品搜索测试报告.txt")


if __name__ == "__main__":
    main()
