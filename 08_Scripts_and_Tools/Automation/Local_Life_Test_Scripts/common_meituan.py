# -*- coding: utf-8 -*-
"""
美团联盟 query_coupon 公共工具：
- 签名请求
- 商品标准化
- 本地生活过滤
- 多关键词去重
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests


API_URL = os.getenv(
    "MT_QUERY_COUPON_URL",
    "https://media.meituan.com/cps_open/common/api/v1/query_coupon"
)
METHOD = "POST"


def coordinate_to_api_value(value: float) -> int:
    return int(round(float(value) * 1_000_000))


def json_body_bytes(body: dict) -> bytes:
    return json.dumps(
        body,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True
    ).encode("utf-8")


def content_md5_base64(body_bytes: bytes) -> str:
    return base64.b64encode(hashlib.md5(body_bytes).digest()).decode("utf-8")


def hmac_sha256_base64(secret: str, string_to_sign: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def build_sign_headers(app_key: str, app_secret: str, body: dict):
    timestamp = str(int(time.time() * 1000))
    body_bytes = json_body_bytes(body)
    md5_value = content_md5_base64(body_bytes)
    path = urlparse(API_URL).path

    headers_string = (
        f"S-Ca-App:{app_key}\n"
        f"S-Ca-Timestamp:{timestamp}\n"
    )

    string_to_sign = (
        f"{METHOD}\n"
        f"{md5_value}\n"
        f"{headers_string}"
        f"{path}"
    )

    signature = hmac_sha256_base64(app_secret, string_to_sign)

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "S-Ca-App": app_key,
        "S-Ca-Timestamp": timestamp,
        "S-Ca-Signature": signature,
        "S-Ca-Signature-Headers": "S-Ca-App,S-Ca-Timestamp",
        "Content-MD5": md5_value
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

    resp = requests.post(API_URL, data=body_bytes, headers=headers, timeout=30)

    try:
        result = resp.json()
    except Exception:
        raise RuntimeError(f"接口返回非 JSON：HTTP {resp.status_code}\n{resp.text}")

    result["_debug"] = {
        "httpStatus": resp.status_code,
        "requestBody": body,
        "contentMd5": headers.get("Content-MD5")
    }

    return result


def money_text(value):
    if value is None or value == "":
        return None
    try:
        return f"{float(value):.2f}"
    except Exception:
        return str(value)


def parse_sale_volume(value) -> int:
    if value is None:
        return -1

    text = str(value).strip()
    if not text:
        return -1

    m_wan = re.search(r"(\d+(?:\.\d+)?)\s*万", text)
    if m_wan:
        return int(float(m_wan.group(1)) * 10000)

    m = re.search(r"(\d+(?:\.\d+)?)", text)
    if m:
        return int(float(m.group(1)))

    return -1


def normalize_distance(value):
    if value is None or value == "":
        return None, None
    try:
        meter = float(value)
        if meter < 1000:
            return meter, f"{round(meter)}m"
        return meter, f"{meter / 1000:.1f}km"
    except Exception:
        return None, str(value)


def normalize_product(raw: dict, *, source_keyword: str = "", page_no: int = 1, source_category: str = "") -> dict:
    detail = raw.get("couponPackDetail") or {}
    deliverable = raw.get("deliverablePoiInfo") or {}
    available = raw.get("availablePoiInfo") or {}
    brand = raw.get("brandInfo") or {}
    commission = raw.get("commissionInfo") or {}
    purchase = raw.get("purchaseLimitInfo") or {}

    product_label = detail.get("productLabel") or {}
    price_power = product_label.get("pricePowerLabel") or {}

    distance_meter, distance_text = normalize_distance(deliverable.get("deliveryDistance"))

    return {
        "sourceKeyword": source_keyword,
        "sourceCategory": source_category,
        "pageNo": page_no,

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
        "saleVolumeNumber": parse_sale_volume(detail.get("saleVolume")),

        "couponNum": detail.get("couponNum"),
        "validTime": detail.get("validTime"),
        "startTime": detail.get("startTime"),
        "endTime": detail.get("endTime"),

        "originalPrice": money_text(detail.get("originalPrice")),
        "sellPrice": money_text(detail.get("sellPrice")),
        "originalPriceRaw": detail.get("originalPrice"),
        "sellPriceRaw": detail.get("sellPrice"),

        "historyPriceLabel": price_power.get("historyPriceLabel"),
        "beatMTLabel": price_power.get("beatMTLabel"),
        "productRankLabel": product_label.get("productRankLabel"),
        "dianPingRankLabel": product_label.get("dianPingRankLabel"),

        "brandNameFromMeituan": brand.get("brandName") or "",
        "brandLogoUrlFromMeituan": brand.get("brandLogoUrl") or "",

        "availablePoiNum": available.get("availablePoiNum"),
        "availableCityNum": available.get("availableCityNum"),

        "poiName": deliverable.get("poiName"),
        "poiLogoUrl": deliverable.get("poiLogoUrl"),
        "deliveryDistance": deliverable.get("deliveryDistance"),
        "distanceMeter": distance_meter,
        "distanceText": distance_text,
        "distributionCost": deliverable.get("distributionCost"),
        "deliveryDuration": deliverable.get("deliveryDuration"),
        "lastDeliveryFee": deliverable.get("lastDeliveryFee"),

        "commissionPercent": commission.get("commissionPercent"),
        "commission": commission.get("commission"),

        "singleDayPurchaseLimit": purchase.get("singleDayPurchaseLimit"),

        "_raw": raw,
    }


def normalize_products(result: dict, *, keyword: str, page_no: int, source_category: str = "") -> list[dict]:
    return [
        normalize_product(item, source_keyword=keyword, page_no=page_no, source_category=source_category)
        for item in (result.get("data") or [])
    ]


def product_key(p: dict) -> str:
    return (
        p.get("productViewSign")
        or p.get("skuViewId")
        or f"{p.get('name')}|{p.get('sellPrice')}|{p.get('poiName')}"
    )


def dedup_products(products: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for p in products:
        k = product_key(p)
        if k in seen:
            continue
        seen.add(k)
        out.append(p)
    return out


FOOD_WORDS = [
    "美食", "餐饮", "外卖", "套餐饭", "小吃", "快餐", "咖啡", "奶茶", "饮品",
    "火锅", "烧烤", "炸鸡", "汉堡", "披萨", "面", "粉", "饭", "蛋糕",
    "甜品", "烘焙", "早餐", "午餐", "晚餐"
]

MOVIE_WORDS = ["电影票", "影票", "观影", "影院", "电影"]


def should_exclude_product(p: dict) -> tuple[bool, str]:
    name = str(p.get("name") or "")
    category = str(p.get("categoryName") or "")
    brand = str(p.get("brandNameFromMeituan") or "")
    text = f"{name} {category} {brand}"

    required = ["name", "headUrl", "sellPrice", "poiName"]
    for field in required:
        if not p.get(field):
            return True, f"核心字段缺失: {field}"

    if p.get("platform") == 1:
        return True, "platform=1 外卖/餐饮"

    if any(w in text for w in FOOD_WORDS):
        return True, "餐饮/外卖相关"

    if any(w in text for w in MOVIE_WORDS):
        return True, "电影类首版排除"

    return False, ""


def filter_local_life(products: list[dict]) -> tuple[list[dict], list[dict]]:
    kept = []
    excluded = []
    for p in products:
        exclude, reason = should_exclude_product(p)
        if exclude:
            q = dict(p)
            q["excludeReason"] = reason
            excluded.append(q)
        else:
            kept.append(p)
    return kept, excluded


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: str | Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def summarize_products(products: list[dict]) -> dict:
    from collections import Counter

    def counter(field):
        c = Counter()
        for p in products:
            v = p.get(field)
            c[str(v)] += 1
        return dict(c.most_common(50))

    return {
        "count": len(products),
        "platform": counter("platform"),
        "bizLine": counter("bizLine"),
        "categoryName": counter("categoryName"),
        "sourceKeyword": counter("sourceKeyword"),
        "sourceCategory": counter("sourceCategory"),
        "brandNameFromMeituan": counter("brandNameFromMeituan"),
    }


def request_by_keyword(*, keyword: str, longitude: float, latitude: float, page_no: int = 1,
                       page_size: int = 20, sort_field: int | None = 1,
                       search_id: str | None = None, debug: bool = False) -> dict:
    body = {
        "searchText": keyword,
        "longitude": coordinate_to_api_value(longitude),
        "latitude": coordinate_to_api_value(latitude),
        "pageNo": page_no,
        "pageSize": page_size,
    }

    if sort_field is not None:
        body["sortField"] = sort_field
    if search_id:
        body["searchId"] = search_id

    return query_coupon(body, debug=debug)
