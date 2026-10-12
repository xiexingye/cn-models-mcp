#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 _selftest/demo-frames.json 渲染成 docs/demo.gif

字体策略：ASCII 用 Consolas（等宽，代码好看），CJK 用微软雅黑（否则中文是豆腐块）。
逐字符选字体是必要的 —— Pillow 不做自动字体回退。

用法： python scripts/render-demo-gif.py
"""

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "_selftest" / "demo-frames.json"
OUT = ROOT / "docs" / "demo.gif"

# ---------- 画布与配色（GitHub Dark）----------
W, H = 900, 560
PAD, CHROME_H = 22, 34
FONT_PX = 15
LINE_H = 24

BG = (13, 17, 23)
CHROME = (22, 27, 34)
TEXT = (201, 209, 217)
PROMPT = (126, 231, 135)
TOOL = (88, 166, 255)
ARG = (139, 148, 158)
META = (210, 168, 255)
ANSWER = (230, 237, 243)
VERDICT = (255, 212, 121)
DOT_R, DOT_Y, DOT_G = (255, 95, 86), (255, 189, 46), (39, 201, 63)

COLORS = {
    "prompt": PROMPT, "prompt2": PROMPT, "tool": TOOL,
    "toolarg": ARG, "meta": META, "answer": ANSWER,
    "verdict": VERDICT, "blank": TEXT,
}

FONTS = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
REG = str(FONTS / "consola.ttf")
BOLD = str(FONTS / "consolab.ttf")
CJK = str(FONTS / "msyh.ttc")

f_latin = ImageFont.truetype(REG, FONT_PX)
f_latin_b = ImageFont.truetype(BOLD, FONT_PX)
f_cjk = ImageFont.truetype(CJK, FONT_PX)
f_cjk_b = ImageFont.truetype(CJK, FONT_PX)
f_title = ImageFont.truetype(REG, 12)

ADV_LATIN = f_latin.getlength("M")
ADV_CJK = FONT_PX + 1.5


def is_wide(ch: str) -> bool:
    """CJK / 全角字符判断"""
    o = ord(ch)
    return (
        0x1100 <= o <= 0x115F or 0x2E80 <= o <= 0xA4CF or 0xAC00 <= o <= 0xD7A3
        or 0xF900 <= o <= 0xFAFF or 0xFE30 <= o <= 0xFE6F or 0xFF00 <= o <= 0xFF60
        or 0xFFE0 <= o <= 0xFFE6 or 0x3000 <= o <= 0x303F
    )


def adv(ch: str) -> float:
    return ADV_CJK if is_wide(ch) else f_latin.getlength(ch)


def wrap(text: str, max_w: float):
    """按像素宽度折行（中文可任意断行，英文尽量按空格断）"""
    lines, cur, cur_w = [], "", 0.0
    for ch in text:
        a = adv(ch)
        if cur_w + a > max_w and cur:
            lines.append(cur)
            cur, cur_w = "", 0.0
        cur += ch
        cur_w += a
    if cur:
        lines.append(cur)
    return lines or [""]


def draw_text(dr: ImageDraw.ImageDraw, x: float, y: float, text: str, color, bold=False):
    """逐字符绘制：ASCII 用 Consolas，CJK 用雅黑"""
    cx = float(x)
    for ch in text:
        if is_wide(ch):
            f = f_cjk_b if bold else f_cjk
        else:
            f = f_latin_b if bold else f_latin
        dr.text((cx, y), ch, font=f, fill=color)
        cx += adv(ch)


def render(lines):
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    dr.rectangle([0, 0, W, CHROME_H], fill=CHROME)
    for i, c in enumerate((DOT_R, DOT_Y, DOT_G)):
        x = 18 + i * 22
        dr.ellipse([x, 12, x + 11, 23], fill=c)
    draw_text(dr, 88, 10, "Claude Code  —  cn-models-mcp", ARG)

    y = 48
    max_w = W - PAD * 2
    for ln in lines:
        if ln["kind"] == "blank":
            y += LINE_H
            continue
        color = COLORS.get(ln["kind"], TEXT)
        bold = ln["kind"] in ("tool", "verdict")
        for seg in wrap(ln["text"], max_w):
            draw_text(dr, PAD, y, seg, color, bold)
            y += LINE_H
        if y > H - 10:
            break
    return img


def main():
    if not DATA.exists():
        print(f"找不到 {DATA}，请先跑 node _selftest/make-demo.mjs", file=sys.stderr)
        return 1
    data = json.loads(DATA.read_text(encoding="utf-8"))
    tr = data["transcript"]

    frames, delays = [], []

    def add(img, ms):
        frames.append(img)
        delays.append(ms)

    # 阶段 1：打字机（前两行）
    first, second = tr[0], tr[1]
    for n in range(1, len(first["text"]) + 1, 2):
        add(render([{**first, "text": first["text"][:n]}, {**second, "text": ""}]), 40)
    for n in range(1, len(second["text"]) + 1, 2):
        add(render([first, {**second, "text": second["text"][:n]}]), 40)
    visible = [first, second]
    add(render(visible), 350)

    # 阶段 2：工具调用出现 —— 这里“等待真实回复”用较长延时体现（真实耗时 3.2s）
    visible.append(tr[2])
    add(render(visible), 500)

    visible.append(tr[3])
    add(render(visible), 2600)          # 对应真实的 3183ms 调用耗时

    visible.append(tr[4])
    visible.append(tr[5])
    visible.append(tr[6])
    add(render(visible), 900)           # 计费行出现，多停一会儿让人看清

    # 阶段 3：逐行吐出回答
    for ln in tr[7:]:
        visible.append(ln)
        is_verdict = ln["kind"] == "verdict"
        add(render(visible), 420 if not is_verdict else 1800)

    # 定格
    add(render(visible), 2500)

    OUT.parent.mkdir(parents=True, exist_ok=True)

    # 用自带的最小 GIF 编码器写文件。
    # 为什么不用 Pillow 的 save(save_all=True)：它**不支持逐帧延时** —— 实测
    # duration=[...] 与逐帧 frame.info['duration'] 都会把同一个值套到所有帧上，
    # 12 秒的动画被写成 137 秒、看起来像卡住/加载不出来。GIF 的 Graphic Control
    # Extension 本身完全支持逐帧延时，所以这里直接按规范写字节流。
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gif_encoder import write_gif

    total_s = write_gif(OUT, frames, delays, loop=0)

    # 写完自查：逐帧 seek 读回延时（不要用 ImageSequence.Iterator，它复用对象，
    # .info 会被末帧覆盖，导致误判为"全部帧延时相同"）
    with Image.open(OUT) as check:
        got = []
        for i in range(check.n_frames):
            check.seek(i)
            got.append(check.info.get("duration"))
        n_frames_written = check.n_frames

    ok_delay = got == delays
    size_kb = OUT.stat().st_size / 1024
    print(f"  帧数: {len(frames)}（写回 {n_frames_written}）")
    print(f"  时长: {total_s:.1f} 秒")
    print(f"  延时校验: {'[OK] 与设计一致' if ok_delay else '[FAIL] ' + str(got[:8])}")
    print(f"  尺寸: {W}x{H}")
    print(f"  [OK] 已写出 {OUT} ({size_kb:.0f} KB)")

    if not ok_delay:
        return 2
    if total_s > 30:
        print(f"  [警告] 总时长 {total_s:.0f} 秒过长，检查延时")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
