#!/usr/bin/env python3
"""Classify a one-column Chinese image-prompt CSV into a reusable asset index.

Usage:
  python3 classify_prompts.py input.csv output.csv

The classifier is intentionally transparent: it applies weighted phrase matches
and keeps all scores so mixed assets can be reviewed rather than silently lost.
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

CATEGORY_RULES = {
    "人物": {
        "角色设定/三视图": ["角色设定", "三视图", "正面、侧面、背面", "身份特征", "角色信息", "标准站姿", "角色档案"],
        "肖像/人像": ["人物肖像", "人像摄影", "近距离肖像", "面部特征", "五官比例", "头部肖像", "眼神"],
        "服装与造型": ["服装", "发型", "体型特征", "妆容", "气质描述", "穿着", "人物主体"],
    },
    "场景": {
        "室内建筑": ["室内", "住宅", "公寓", "玄关", "房间", "办公", "酒店", "审讯室", "室内空场景", "硬装"],
        "室外/自然": ["森林", "山脉", "海岸", "湖泊", "沙漠", "草原", "瀑布", "峡谷", "自然环境", "户外"],
        "奇幻/历史建筑": ["中世纪", "哥特", "神殿", "地牢", "王宫", "祭祀", "遗迹", "龙族", "石质穹顶"],
        "空间摄影": ["场景定位", "空间结构", "建筑细节", "空间与场景架构", "环境叙事", "陈设细节"],
    },
    "道具": {
        "武器/仪式器物": ["武器设计", "长剑", "匕首", "法杖", "祭祀器物", "护甲", "道具设定", "器物主体"],
        "产品/包装": ["产品设计", "产品包装", "品牌产品", "商品展示", "产品摄影", "包装结构"],
        "饰品/工具/家具": ["饰品设计", "器物设计", "设备产品", "工具设计", "家具设计", "摆件设计", "单一道具", "物件主体"],
    },
}

NEGATED_TERMS = ("无人物", "不出现人物", "画面无任何人物", "无道具", "不含道具", "无武器")


def score(text: str, terms: list[str]) -> int:
    clean = text
    for term in NEGATED_TERMS:
        clean = clean.replace(term, "")
    return sum(clean.count(term) for term in terms)


def classify(text: str) -> tuple[str, str, int, str]:
    scores: dict[str, int] = {}
    subtype_scores: dict[tuple[str, str], int] = {}
    for category, subtypes in CATEGORY_RULES.items():
        category_score = 0
        for subtype, terms in subtypes.items():
            value = score(text, terms)
            subtype_scores[(category, subtype)] = value
            category_score += value
        scores[category] = category_score

    primary = max(scores, key=scores.get)
    best_subtype = max(
        (key for key in subtype_scores if key[0] == primary),
        key=lambda key: subtype_scores[key],
    )[1]
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    confidence = ordered[0][1] - ordered[1][1]
    related = ";".join(category for category, value in ordered[1:] if value > 0)
    return primary, best_subtype, confidence, related


def compact_title(text: str) -> str:
    line = re.sub(r"\s+", " ", text).strip()
    line = re.sub(r"^【[^】]{2,30}】", "", line).strip()
    return line[:72]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: classify_prompts.py input.csv output.csv")
    source, target = map(Path, sys.argv[1:])
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["id", "primary_category", "subtype", "confidence", "related_categories", "characters", "title", "prompt"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for index, row in enumerate(rows, 1):
            text = row.get("prompt", "").strip()
            category, subtype, confidence, related = classify(text)
            writer.writerow({
                "id": index,
                "primary_category": category,
                "subtype": subtype,
                "confidence": confidence,
                "related_categories": related,
                "characters": len(text),
                "title": compact_title(text),
                "prompt": text,
            })


if __name__ == "__main__":
    main()
