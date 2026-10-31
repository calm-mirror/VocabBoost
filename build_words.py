# -*- coding: utf-8 -*-
"""
从 ECDICT 数据库生成 VocabBoost 词库 words.json

分级规则（取单词所属的最基础等级）：
    zk                  -> 1 初中
    gk                  -> 2 高中
    cet4                -> 3 大学四级
    cet6 / ky           -> 4 大学六级 / 考研
    ielts / toefl       -> 5 雅思 / 托福
    gre                 -> 6 GRE
    oxford（仅牛津标签） -> 2 高中（牛津核心词）

同时用 COCA 词频做保守校准：极高频词不会被误标成雅思/GRE 词，
但仍然只会「降低」难度，不会把低频难词抬进简单级别。

输出格式：
    [{"w":"单词","p":"/音标/","z":"释义","l":难度1-6,"tags":["gk"]}]
"""
import json
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "ecdict.db")
OUT_FILE = os.path.join(BASE_DIR, "words.json")
LEGACY_FILE = os.path.join(BASE_DIR, "words.legacy.json")

LEVEL_OF_TAG = {
    "zk": 1,
    "gk": 2,
    "cet4": 3,
    "ky": 4,
    "cet6": 4,
    "ielts": 5,
    "toefl": 5,
    "gre": 6,
    "oxford": 2,
}

LEVEL_NAMES = {
    1: "初中",
    2: "高中",
    3: "四级",
    4: "六级/考研",
    5: "雅思/托福",
    6: "GRE",
}


def clean_translation(text):
    """把 ECDICT 的多行释义整理成一行，保留完整多义项。"""
    if text is None:
        return ""
    text = str(text).replace("\r\n", "\n").replace("\r", "\n")
    parts = []
    for line in text.split("\n"):
        line = " ".join(line.split()).strip()
        if line:
            parts.append(line)
    out = "; ".join(parts)
    out = out.replace("；", "; ").replace("，", ", ")
    while "  " in out:
        out = out.replace("  ", " ")
    return out.strip("; ").strip()


def clean_phonetic(value):
    value = (value or "").strip()
    if not value:
        return ""
    if not value.startswith("/"):
        value = "/" + value.strip("/") + "/"
    return value


def clean_english_definition(value):
    """英文释义/详细说明：保留多行内容，整理成一行。"""
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    parts = []
    for line in text.split("\n"):
        line = " ".join(line.split()).strip()
        if line:
            parts.append(line)
    return "; ".join(parts).strip("; ").strip()


def normalize_word(word):
    return (word or "").strip()


def frequency_cap(frq):
    """COCA 词频排名 -> 难度上限；0/空表示没有排名，不参与校准。"""
    try:
        frq = int(frq)
    except (TypeError, ValueError):
        return 9
    if frq <= 0:
        return 9
    if frq <= 400:
        return 1
    if frq <= 1500:
        return 2
    if frq <= 3000:
        return 3
    if frq <= 5500:
        return 4
    return 9


def main():
    if not os.path.exists(DB_FILE):
        print("找不到 ecdict.db，无法生成词库。")
        print("请把 ECDICT 的 ecdict.db 放到程序目录后重新运行。")
        return 2

    if os.path.exists(OUT_FILE) and not os.path.exists(LEGACY_FILE):
        try:
            os.replace(OUT_FILE, LEGACY_FILE)
            print("已备份旧词库 -> words.legacy.json")
        except OSError:
            pass

    print("正在读取 ECDICT 数据库……")
    conn = sqlite3.connect(DB_FILE)
    conn.text_factory = str
    cur = conn.cursor()

    cur.execute("PRAGMA table_info(stardict)")
    columns = {row[1] for row in cur.fetchall()}
    exchange_field = "exchange" if "exchange" in columns else "''"

    query = f"""
        SELECT word, phonetic, translation, tag, oxford, {exchange_field},
               frq, bnc, collins, definition, pos, detail
        FROM stardict
        WHERE translation IS NOT NULL AND translation != ''
          AND word IS NOT NULL AND word != ''
        ORDER BY CASE WHEN frq > 0 THEN frq ELSE 999999 END ASC
    """
    cur.execute(query)

    seen = set()
    words = []
    skipped = 0

    for raw_word, phonetic, translation, tag_str, oxford, exchange, frq, bnc, collins, definition, pos, detail in cur:
        word = normalize_word(raw_word)
        if not word or word.lower() in seen:
            continue

        # 只保留 2~20 个字母的纯英文单词
        if len(word) < 2 or len(word) > 20 or not word.isalpha():
            skipped += 1
            continue

        tags = str(tag_str).split() if tag_str else []
        if not tags and int(oxford or 0) == 1:
            tags = ["oxford"]

        levels = [LEVEL_OF_TAG[t] for t in tags if t in LEVEL_OF_TAG]
        if not levels:
            skipped += 1
            continue

        z = clean_translation(translation)
        if not z:
            skipped += 1
            continue

        # 去掉纯缩写、纯大写且不是中高考核心的噪声词
        if word.isupper() and len(word) < 4 and not ({"zk", "gk"} & set(tags)):
            skipped += 1
            continue

        seen.add(word.lower())
        item = {
            "w": word,
            "p": clean_phonetic(phonetic),
            "z": z,
            "l": min(min(levels), frequency_cap(frq)),
            "tags": [t for t in tags if t in LEVEL_OF_TAG],
        }
        exchange_text = str(exchange or "").strip()
        if exchange_text:
            item["x"] = exchange_text[:500]
        definition_text = clean_english_definition(definition)
        if definition_text:
            item["d"] = definition_text[:2000]
        pos_text = str(pos or "").strip()
        if pos_text:
            item["pos"] = pos_text[:120]
        detail_text = clean_english_definition(detail)
        if detail_text:
            item["det"] = detail_text[:2000]
        if str(collins or "").strip().isdigit():
            item["c"] = int(collins)
        if str(oxford or "").strip().isdigit() and int(oxford) == 1:
            item["o"] = 1
        if str(frq or "").strip().isdigit() and int(frq) > 0:
            item["f"] = int(frq)
        if str(bnc or "").strip().isdigit() and int(bnc) > 0:
            item["b"] = int(bnc)
        words.append(item)

    conn.close()

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False, separators=(",", ":"))

    counts = {i: 0 for i in range(1, 7)}
    for item in words:
        counts[item["l"]] += 1

    size_mb = os.path.getsize(OUT_FILE) / 1024 / 1024
    print(f"完成：{len(words)} 个单词，{size_mb:.2f} MB（跳过 {skipped} 条）")
    for level in range(1, 7):
        print(f"  L{level} {LEVEL_NAMES[level]:<8} {counts[level]:>6} 词")
    return 0


if __name__ == "__main__":
    sys.exit(main())
