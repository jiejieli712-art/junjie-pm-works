# -*- coding: utf-8 -*-
"""
酒店品牌识别公共工具：
- 加载我方品牌库
- 规则兜底匹配
- 调用千问 / OpenAI-compatible Chat Completions API
"""

import json
import os
import re
from pathlib import Path

import requests


def load_json(path: str | Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_brand_library(path: str | Path) -> list[dict]:
    data = load_json(path)
    if isinstance(data, dict):
        return data.get("brands") or []
    return data


def normalize_brand_lib(brands: list[dict]) -> list[dict]:
    out = []
    for b in brands:
        name = b.get("name") or b.get("brandName")
        if not name:
            continue
        aliases = b.get("aliases") or b.get("alias") or []
        if isinstance(aliases, str):
            aliases = [x.strip() for x in aliases.replace("，", ",").split(",") if x.strip()]
        out.append({
            "name": name,
            "aliases": aliases,
            "isHot": bool(b.get("isHot", False)),
            "sort": b.get("sort", 999),
        })
    return out


def rule_match_brand(product: dict, brands: list[dict]) -> str | None:
    text = f"{product.get('name') or ''} {product.get('brandNameFromMeituan') or ''} {product.get('poiName') or ''}"
    for b in brands:
        keys = [b["name"]] + b.get("aliases", [])
        for k in keys:
            if k and k in text:
                return b["name"]
    return None


def call_qwen_brand(product: dict, brands: list[dict], debug: bool = False) -> dict:
    api_key = os.getenv("QWEN_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("请先设置 QWEN_API_KEY")

    base_url = os.getenv(
        "QWEN_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    )
    model = os.getenv("QWEN_MODEL", "qwen-plus")

    brand_text = "\n".join([
        f"- {b['name']}（别名：{', '.join(b.get('aliases', [])) or '无'}）"
        for b in brands
    ])

    prompt = f"""
你是酒店商品品牌归类助手。

任务：
根据商品名称和美团返回的 brandName，在【我方品牌库】中选择最匹配的品牌。
只能输出品牌库中存在的品牌名称。
如果无法判断，输出 UNKNOWN。

【我方品牌库】
{brand_text}

【商品信息】
商品名称：{product.get('name') or ''}
美团 brandName：{product.get('brandNameFromMeituan') or ''}
门店名称：{product.get('poiName') or ''}

请严格返回 JSON，不要输出其他内容：
{{
  "brand": "品牌库中的品牌名或UNKNOWN",
  "reason": "简短原因"
}}
""".strip()

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你只返回合法 JSON。"},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    resp = requests.post(base_url, headers=headers, json=payload, timeout=40)
    if debug:
        print(resp.status_code, resp.text[:1000])

    resp.raise_for_status()
    data = resp.json()

    content = data["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            return json.loads(m.group(0))
        return {"brand": "UNKNOWN", "reason": "AI 返回非 JSON"}


def classify_brand(product: dict, brands: list[dict], *, rule_only: bool = False, debug: bool = False) -> tuple[str, str, str]:
    """
    返回: (最终品牌, 来源, 原因)
    来源: AI / RULE / RULE_ONLY / UNKNOWN
    """
    brand_names = {b["name"] for b in brands}
    rule_brand = rule_match_brand(product, brands)

    if rule_only:
        return rule_brand or "UNKNOWN", ("RULE_ONLY" if rule_brand else "UNKNOWN"), "仅规则匹配"

    try:
        ai = call_qwen_brand(product, brands, debug=debug)
        ai_brand = ai.get("brand") or "UNKNOWN"
        if ai_brand not in brand_names:
            ai_brand = "UNKNOWN"
        if ai_brand != "UNKNOWN":
            return ai_brand, "AI", ai.get("reason") or ""
    except Exception as e:
        return rule_brand or "UNKNOWN", ("RULE" if rule_brand else "UNKNOWN"), f"AI失败：{e}"

    return rule_brand or "UNKNOWN", ("RULE" if rule_brand else "UNKNOWN"), "AI未知，规则兜底"
