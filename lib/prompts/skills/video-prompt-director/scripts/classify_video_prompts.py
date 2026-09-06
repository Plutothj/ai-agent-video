#!/usr/bin/env python3
"""Create a transparent index for one-column Chinese video-prompt CSV files.

Usage:
  python3 classify_video_prompts.py input.csv output.csv

This script uses phrase-based, inspectable classifications. Treat results as a
retrieval index and review mixed or low-confidence entries before final curation.
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

TYPE_RULES = {
    "真人短剧/叙事": ["真人实拍", "短剧", "演员", "家庭", "职场", "情感", "现实主义"],
    "3D漫剧/动画": ["3D 漫剧", "3D漫剧", "动画", "UE5", "CG", "建模", "风格化光影"],
    "武侠/奇幻动作": ["武侠", "修仙", "妖", "法术", "战斗", "剑气", "变身", "神殿", "妖气"],
    "口播/访谈": ["口播", "讲解", "访谈", "讲师", "演讲", "台词", "口型"],
    "公益/纪实/服务": ["社区", "养老", "纪实", "公益", "服务", "温暖群像"],
}

TECHNIQUE_RULES = {
    "单镜头": ["景别", "运镜方式", "机位/角度", "画面内容"],
    "多镜头分镜": ["分镜脚本", "镜头 1", "镜 1", "镜头一", "总时长", "第一段"],
    "资产参考绑定": ["@图片", "<主体", "人物形象权重", "固定场景", "站位参考"],
    "全局稳定性": ["不跳帧", "不漂移", "无角色漂移", "无模型穿模", "无画面撕裂", "无字幕"],
    "音画/台词": ["音效", "声音设计", "台词", "音画同步", "口型同步"],
}


def count_matches(text: str, phrases: list[str]) -> int:
    return sum(text.count(phrase) for phrase in phrases)


def title(text: str) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    bracket = re.search(r"【([^】]{2,50})】", compact)
    if bracket:
        return bracket.group(1)[:72]
    return compact[:72]


def classify(text: str) -> tuple[str, int, str, str]:
    scores = {name: count_matches(text, phrases) for name, phrases in TYPE_RULES.items()}
    ordered = sorted(scores.items(), key=lambda pair: pair[1], reverse=True)
    primary = ordered[0][0]
    confidence = ordered[0][1] - ordered[1][1]
    related = ";".join(name for name, value in ordered[1:] if value > 0)
    techniques = ";".join(name for name, phrases in TECHNIQUE_RULES.items() if count_matches(text, phrases) > 0)
    return primary, confidence, related, techniques


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: classify_video_prompts.py input.csv output.csv")
    source, target = map(Path, sys.argv[1:])
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["id", "primary_type", "confidence", "related_types", "techniques", "characters", "title", "prompt"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for index, row in enumerate(rows, 1):
            prompt = row.get("prompt", "").strip()
            primary, confidence, related, techniques = classify(prompt)
            writer.writerow({
                "id": index,
                "primary_type": primary,
                "confidence": confidence,
                "related_types": related,
                "techniques": techniques,
                "characters": len(prompt),
                "title": title(prompt),
                "prompt": prompt,
            })


if __name__ == "__main__":
    main()
