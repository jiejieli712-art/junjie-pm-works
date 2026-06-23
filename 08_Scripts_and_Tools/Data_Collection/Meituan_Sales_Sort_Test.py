# -*- coding: utf-8 -*-
"""
美团商品查询接口：到店榜单 sortField=2 销量排序是否生效测试脚本

测试目标：
1. 使用相同的 platform、listTopiId、经纬度，请求两次美团 query_coupon：
   A. 入参带 sortField=2
   B. 入参不带 sortField
2. 对比两次返回的商品顺序是否完全一致。
3. 检查 sortField=2 返回结果是否大致按销量降序排列。
4. 输出原始 JSON、标准化商品 JSON、排序对比报告 TXT。

运行前设置环境变量：
PowerShell:
$env:MT_APP_KEY="你的AppKey"
$env:MT_APP_SECRET="你的AppSecret"

默认运行：
py -u .\美团到店榜单销量排序测试.py

指定榜单：
py -u .\美团到店榜单销量排序测试.py --list-topic-id 3

测试其他榜单：
py -u .\美团到店榜单销量排序测试.py --list-topic-id 2
py -u .\美团到店榜单销量排序测试.py --list-topic-id 5

默认参数：
platform=2
bizLine=1
sortField=2
listTopiId=3
longitude=117.186361
latitude=34.260681
"""

import argparse
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


API_URL = "https://media.meituan.com/cps_open/common/api/v1/query_coupon"
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
    """
    已验证成功的美团签名方式：

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
        print("\n========== Content-MD5 ==========")
        print(headers.get("Content-MD5"))
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
        "contentMd5": headers.get("Content-MD5")
    }

    return result


def build_base_body(args, include_sort_field: bool) -> dict:
    body = {
        "platform": args.platform,
        "listTopiId": args.list_topic_id,
        "longitude": coordinate_to_api_value(args.longitude),
        "latitude": coordinate_to_api_value(args.latitude),
        "pageNo": args.page_no,
        "pageSize": args.page_size
    }

    if args.biz_line is not None:
        body["bizLine"] = args.biz_line

    if args.city_id is not None:
        body["cityId"] = args.city_id

    if args.business_area_id is not None:
        body["businessAreaId"] = args.business_area_id

    if include_sort_field:
        body["sortField"] = args.sort_field

    return body


def parse_sale_volume(value) -> int:
    """
    将 saleVolume 转成可比较数字。

    兼容：
    - 热销120
    - 1000+
    - 1万+
    - 2.3万+
    - None
    """
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


def normalize_product(raw: dict, index: int) -> dict:
    detail = raw.get("couponPackDetail") or {}
    deliverable = raw.get("deliverablePoiInfo") or {}
    product_label = detail.get("productLabel") or {}
    price_power = product_label.get("pricePowerLabel") or {}

    sale_volume = detail.get("saleVolume")

    labels = []
    for key in ["historyPriceLabel", "beatMTLabel"]:
        if price_power.get(key):
            labels.append(price_power.get(key))
    for key in ["productRankLabel", "dianPingRankLabel"]:
        if product_label.get(key):
            labels.append(str(product_label.get(key)))

    return {
        "index": index,
        "productViewSign": detail.get("productViewSign") or "",
        "skuViewId": detail.get("skuViewId") or "",
        "name": detail.get("name") or "",
        "headUrl": detail.get("headUrl") or "",
        "platform": detail.get("platform"),
        "bizLine": detail.get("bizLine"),
        "categoryName": detail.get("categoryName"),
        "saleVolume": sale_volume,
        "saleVolumeNumber": parse_sale_volume(sale_volume),
        "originalPrice": detail.get("originalPrice"),
        "sellPrice": detail.get("sellPrice"),
        "saleStatus": detail.get("saleStatus"),
        "labels": labels,
        "poiName": deliverable.get("poiName"),
        "deliveryDistance": deliverable.get("deliveryDistance"),
        "distributionCost": deliverable.get("distributionCost"),
        "deliveryDuration": deliverable.get("deliveryDuration"),
        "lastDeliveryFee": deliverable.get("lastDeliveryFee")
    }


def normalize_products(result: dict) -> list[dict]:
    return [
        normalize_product(raw, index=i)
        for i, raw in enumerate(result.get("data") or [], start=1)
    ]


def product_key(item: dict, fallback_index: int = 0) -> str:
    """
    用于判断两个列表是否同一个商品。
    优先使用 productViewSign，其次 skuViewId，最后 name + price。
    """
    if item.get("productViewSign"):
        return "sign:" + item["productViewSign"]
    if item.get("skuViewId"):
        return "sku:" + item["skuViewId"]
    if item.get("name") and item.get("sellPrice") is not None:
        return f"name_price:{item.get('name')}|{item.get('sellPrice')}"
    return f"index:{fallback_index}"


def order_signature(items: list[dict]) -> list[str]:
    return [product_key(item, i) for i, item in enumerate(items)]


def is_sales_desc(items: list[dict]) -> dict:
    """
    判断列表是否按 saleVolumeNumber 降序。
    saleVolumeNumber=-1 代表无法解析，忽略这类商品。
    """
    comparable = [item for item in items if item.get("saleVolumeNumber", -1) >= 0]

    violations = []
    for i in range(len(comparable) - 1):
        cur = comparable[i]
        nxt = comparable[i + 1]
        if cur["saleVolumeNumber"] < nxt["saleVolumeNumber"]:
            violations.append({
                "index": i + 1,
                "currentName": cur.get("name"),
                "currentSaleVolume": cur.get("saleVolume"),
                "currentSaleVolumeNumber": cur.get("saleVolumeNumber"),
                "nextName": nxt.get("name"),
                "nextSaleVolume": nxt.get("saleVolume"),
                "nextSaleVolumeNumber": nxt.get("saleVolumeNumber")
            })

    return {
        "comparableCount": len(comparable),
        "isDescending": len(violations) == 0,
        "violations": violations
    }


def compare_orders(items_with_sort: list[dict], items_without_sort: list[dict]) -> dict:
    keys_with = order_signature(items_with_sort)
    keys_without = order_signature(items_without_sort)

    same_count = len(keys_with) == len(keys_without)
    same_order = same_count and keys_with == keys_without
    same_set = set(keys_with) == set(keys_without)

    position_changes = []
    without_pos = {key: idx + 1 for idx, key in enumerate(keys_without)}

    for idx, key in enumerate(keys_with, start=1):
        old_pos = without_pos.get(key)
        if old_pos is not None and old_pos != idx:
            product = items_with_sort[idx - 1]
            position_changes.append({
                "productName": product.get("name"),
                "productKey": key,
                "withSortPosition": idx,
                "withoutSortPosition": old_pos,
                "saleVolume": product.get("saleVolume"),
                "saleVolumeNumber": product.get("saleVolumeNumber")
            })

    keys_without_set = set(keys_without)
    keys_with_set = set(keys_with)
    only_with = [items_with_sort[i] for i, key in enumerate(keys_with) if key not in keys_without_set]
    only_without = [items_without_sort[i] for i, key in enumerate(keys_without) if key not in keys_with_set]

    return {
        "withSortCount": len(items_with_sort),
        "withoutSortCount": len(items_without_sort),
        "sameCount": same_count,
        "sameSet": same_set,
        "sameOrder": same_order,
        "positionChangeCount": len(position_changes),
        "positionChanges": position_changes,
        "onlyWithSort": only_with,
        "onlyWithoutSort": only_without,
        "withSortSalesDescCheck": is_sales_desc(items_with_sort),
        "withoutSortSalesDescCheck": is_sales_desc(items_without_sort)
    }


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def print_products(title: str, items: list[dict]):
    print("\n" + title)
    print("-" * 90)
    if not items:
        print("无商品")
        return

    for item in items:
        print(
            f"{item['index']:02d}. {item.get('name')} | "
            f"saleVolume={item.get('saleVolume')}({item.get('saleVolumeNumber')}) | "
            f"price={item.get('sellPrice')} | "
            f"poiName={item.get('poiName')} | "
            f"distance={item.get('deliveryDistance')} | "
            f"sign={(item.get('productViewSign') or '')[:22]}..."
        )


def build_report(args, with_sort_body, without_sort_body, with_sort_items, without_sort_items, compare_result) -> str:
    lines = []

    lines.append("美团到店榜单 sortField=2 销量排序测试报告")
    lines.append("=" * 90)
    lines.append("")
    lines.append("一、测试参数")
    lines.append(f"- platform: {args.platform}")
    lines.append(f"- bizLine: {args.biz_line}")
    lines.append(f"- listTopiId: {args.list_topic_id}")
    lines.append(f"- sortField: {args.sort_field}")
    lines.append(f"- longitude: {args.longitude}")
    lines.append(f"- latitude: {args.latitude}")
    lines.append("")

    lines.append("二、请求体对比")
    lines.append("A. 带 sortField 请求：")
    lines.append(json.dumps(with_sort_body, ensure_ascii=False, indent=2))
    lines.append("")
    lines.append("B. 不带 sortField 请求：")
    lines.append(json.dumps(without_sort_body, ensure_ascii=False, indent=2))
    lines.append("")

    lines.append("三、核心对比结论")
    lines.append(f"- 带 sortField 返回商品数：{compare_result['withSortCount']}")
    lines.append(f"- 不带 sortField 返回商品数：{compare_result['withoutSortCount']}")
    lines.append(f"- 两次返回商品集合是否相同：{'是' if compare_result['sameSet'] else '否'}")
    lines.append(f"- 两次返回商品顺序是否完全相同：{'是' if compare_result['sameOrder'] else '否'}")
    lines.append(f"- 发生位置变化的商品数：{compare_result['positionChangeCount']}")
    lines.append("")

    with_desc = compare_result["withSortSalesDescCheck"]
    without_desc = compare_result["withoutSortSalesDescCheck"]

    lines.append("四、销量降序检查")
    lines.append(f"- 带 sortField=2 是否按销量降序：{'是' if with_desc['isDescending'] else '否'}")
    lines.append(f"- 不带 sortField 是否按销量降序：{'是' if without_desc['isDescending'] else '否'}")
    lines.append(f"- 带 sortField 可解析销量商品数：{with_desc['comparableCount']}")
    lines.append(f"- 不带 sortField 可解析销量商品数：{without_desc['comparableCount']}")
    lines.append("")

    lines.append("五、判断")
    if compare_result["sameOrder"]:
        lines.append("两次返回顺序完全一致。可能原因：")
        lines.append("1. 当前 listTopiId 榜单本身默认就是销量排序；")
        lines.append("2. 当前 listTopiId 榜单不受 sortField=2 影响；")
        lines.append("3. 该榜单接口按固定榜单规则返回，排序参数被忽略。")
    else:
        lines.append("两次返回顺序不一致，说明 sortField=2 可能影响了榜单返回顺序。")
        if with_desc["isDescending"]:
            lines.append("并且带 sortField=2 的结果通过了销量降序检查，基本可以认为销量排序生效。")
        else:
            lines.append("但带 sortField=2 的结果没有通过严格销量降序检查，可能排序依据不是 saleVolume 字段，或 saleVolume 文案不是准确排序值。")

    lines.append("")
    lines.append("六、带 sortField=2 商品顺序")
    for item in with_sort_items:
        lines.append(
            f"{item['index']:02d}. {item.get('name')} | "
            f"saleVolume={item.get('saleVolume')}({item.get('saleVolumeNumber')}) | "
            f"price={item.get('sellPrice')} | poiName={item.get('poiName')}"
        )

    lines.append("")
    lines.append("七、不带 sortField 商品顺序")
    for item in without_sort_items:
        lines.append(
            f"{item['index']:02d}. {item.get('name')} | "
            f"saleVolume={item.get('saleVolume')}({item.get('saleVolumeNumber')}) | "
            f"price={item.get('sellPrice')} | poiName={item.get('poiName')}"
        )

    if compare_result["positionChanges"]:
        lines.append("")
        lines.append("八、位置变化明细")
        for change in compare_result["positionChanges"]:
            lines.append(
                f"- {change['productName']}："
                f"不带 sortField 第 {change['withoutSortPosition']} 位 → "
                f"带 sortField 第 {change['withSortPosition']} 位，"
                f"销量={change['saleVolume']}({change['saleVolumeNumber']})"
            )

    if with_desc["violations"]:
        lines.append("")
        lines.append("九、带 sortField=2 的销量降序异常点")
        for v in with_desc["violations"]:
            lines.append(
                f"- 第 {v['index']} 位 {v['currentName']} "
                f"销量 {v['currentSaleVolume']}({v['currentSaleVolumeNumber']}) "
                f"< 下一位 {v['nextName']} "
                f"销量 {v['nextSaleVolume']}({v['nextSaleVolumeNumber']})"
            )

    return "\n".join(lines)


def parse_args():
    parser = argparse.ArgumentParser(description="美团到店榜单 sortField=2 销量排序测试脚本")

    parser.add_argument("--platform", type=int, default=2, help="平台类型，默认 2=到店")
    parser.add_argument("--biz-line", type=int, default=1, help="二级业务，默认 1=到店餐饮；如果不想传，设置为 -1")
    parser.add_argument("--list-topic-id", type=int, default=3, help="榜单 ID，默认 3=同城热销")
    parser.add_argument("--sort-field", type=int, default=2, help="排序字段，默认 2=销量排序")
    parser.add_argument("--longitude", type=float, default=117.186361, help="经度")
    parser.add_argument("--latitude", type=float, default=34.260681, help="纬度")
    parser.add_argument("--page-no", type=int, default=1)
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--city-id", type=int, default=None)
    parser.add_argument("--business-area-id", type=int, default=None)
    parser.add_argument("--output-dir", default="meituan_dine_sortfield_test_output")
    parser.add_argument("--debug", action="store_true", help="打印签名调试信息")
    parser.add_argument("--sleep-seconds", type=float, default=0.5)

    args = parser.parse_args()

    # 允许用户通过 --biz-line -1 表示不传 bizLine
    if args.biz_line == -1:
        args.biz_line = None

    return args


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("========== 测试配置 ==========")
    print("platform:", args.platform)
    print("bizLine:", args.biz_line)
    print("listTopiId:", args.list_topic_id)
    print("sortField:", args.sort_field)
    print("longitude:", args.longitude)
    print("latitude:", args.latitude)
    print("output_dir:", output_dir)

    with_sort_body = build_base_body(args, include_sort_field=True)
    without_sort_body = build_base_body(args, include_sort_field=False)

    print("\n========== A. 带 sortField 请求 ==========")
    print(json.dumps(with_sort_body, ensure_ascii=False, indent=2))
    with_sort_result = query_coupon(with_sort_body, debug=args.debug)
    with_sort_items = normalize_products(with_sort_result)

    save_json(output_dir / "01_with_sort_raw.json", with_sort_result)
    save_json(output_dir / "02_with_sort_products.json", with_sort_items)

    print("HTTP Status:", with_sort_result.get("_debug", {}).get("httpStatus"))
    print("code:", with_sort_result.get("code"), "| message:", with_sort_result.get("message"))
    print_products("带 sortField=2 返回商品", with_sort_items)

    if args.sleep_seconds > 0:
        time.sleep(args.sleep_seconds)

    print("\n========== B. 不带 sortField 请求 ==========")
    print(json.dumps(without_sort_body, ensure_ascii=False, indent=2))
    without_sort_result = query_coupon(without_sort_body, debug=args.debug)
    without_sort_items = normalize_products(without_sort_result)

    save_json(output_dir / "03_without_sort_raw.json", without_sort_result)
    save_json(output_dir / "04_without_sort_products.json", without_sort_items)

    print("HTTP Status:", without_sort_result.get("_debug", {}).get("httpStatus"))
    print("code:", without_sort_result.get("code"), "| message:", without_sort_result.get("message"))
    print_products("不带 sortField 返回商品", without_sort_items)

    compare_result = compare_orders(with_sort_items, without_sort_items)
    save_json(output_dir / "05_sort_compare_result.json", compare_result)

    report = build_report(
        args=args,
        with_sort_body=with_sort_body,
        without_sort_body=without_sort_body,
        with_sort_items=with_sort_items,
        without_sort_items=without_sort_items,
        compare_result=compare_result
    )
    report_path = output_dir / "06_sortfield_销量排序测试报告.txt"
    report_path.write_text(report, encoding="utf-8")

    print("\n========== 对比结论 ==========")
    print("带 sortField 返回商品数:", compare_result["withSortCount"])
    print("不带 sortField 返回商品数:", compare_result["withoutSortCount"])
    print("商品集合是否相同:", "是" if compare_result["sameSet"] else "否")
    print("商品顺序是否完全相同:", "是" if compare_result["sameOrder"] else "否")
    print("发生位置变化的商品数:", compare_result["positionChangeCount"])
    print("带 sortField=2 是否按销量降序:", "是" if compare_result["withSortSalesDescCheck"]["isDescending"] else "否")
    print("不带 sortField 是否按销量降序:", "是" if compare_result["withoutSortSalesDescCheck"]["isDescending"] else "否")

    print("\n========== 输出文件 ==========")
    print("带 sortField 原始 JSON:", output_dir / "01_with_sort_raw.json")
    print("带 sortField 商品 JSON:", output_dir / "02_with_sort_products.json")
    print("不带 sortField 原始 JSON:", output_dir / "03_without_sort_raw.json")
    print("不带 sortField 商品 JSON:", output_dir / "04_without_sort_products.json")
    print("对比结果 JSON:", output_dir / "05_sort_compare_result.json")
    print("测试报告 TXT:", report_path)

    print("\n建议先打开：", report_path)


if __name__ == "__main__":
    main()
