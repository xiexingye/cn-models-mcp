#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
自包含的最小 GIF89a 编码器。

为什么要自己写：Pillow 12 的 GIF 写入器**不支持逐帧延时** —— 实测 save(duration=[...])
与逐帧 frame.info['duration'] 都会把同一个值套到所有帧上（12 秒的动画被写成 137 秒）。
GIF 的 Graphic Control Extension 本身完全支持逐帧延时，所以这里直接按规范写字节流。

用法：
    from gif_encoder import write_gif
    write_gif("out.gif", frames_rgb, durations_ms)
frames_rgb: list[PIL.Image.Image]（会被转成调色板并合并为公共调色板）
"""

from PIL import Image


def _lzw_encode(indices, min_code_size):
    """标准 GIF LZW 编码（参照 GIF89a 规范 / NESdev 的说明实现）。"""
    clear_code = 1 << min_code_size
    end_code = clear_code + 1

    out = bytearray()
    bit_buffer = 0
    bit_count = 0

    def emit(code, width):
        nonlocal bit_buffer, bit_count
        bit_buffer |= code << bit_count
        bit_count += width
        while bit_count >= 8:
            out.append(bit_buffer & 0xFF)
            bit_buffer >>= 8
            bit_count -= 8

    table = {}
    next_code = end_code + 1
    code_size = min_code_size + 1

    def reset_table():
        nonlocal table, next_code, code_size
        table = {bytes([i]): i for i in range(clear_code)}
        next_code = end_code + 1
        code_size = min_code_size + 1

    reset_table()
    emit(clear_code, code_size)

    buffer = b""
    for value in indices:
        ch = bytes([value])
        candidate = buffer + ch
        if candidate in table:
            buffer = candidate
            continue
        emit(table[buffer], code_size)
        if next_code < 4096:
            table[candidate] = next_code
            next_code += 1
            # 码长在 next_code 超过当前可表示范围时增长
            if next_code - 1 == (1 << code_size) and code_size < 12:
                code_size += 1
        else:
            emit(clear_code, code_size)
            reset_table()
        buffer = ch

    if buffer:
        emit(table[buffer], code_size)
    emit(end_code, code_size)

    if bit_count > 0:
        out.append(bit_buffer & 0xFF)

    return bytes(out)


def _sub_blocks(data):
    """把字节流切成 GIF 的子块（每块 <=255 字节，最后以 0 结尾）。"""
    out = bytearray()
    for i in range(0, len(data), 255):
        chunk = data[i:i + 255]
        out.append(len(chunk))
        out += chunk
    out.append(0)
    return bytes(out)


def write_gif(path, frames, durations_ms, loop=0):
    """写出带逐帧延时的 GIF89a。frames 为 PIL RGB 图像列表。"""
    if len(frames) != len(durations_ms):
        raise ValueError("frames 与 durations_ms 数量不一致")

    # 用第一帧的调色板做公共调色板，其余帧按它量化 —— 保证颜色一致、体积可控。
    # 注意：getpalette() 在 P 模式下可能返回 RGB 或 RGBA（1024 字节），
    # 必须显式要 "RGB" 并据此计算全局色表大小，否则文件结构会错位。
    base = frames[0].convert("P", palette=Image.ADAPTIVE, colors=256)
    palette = base.getpalette("RGB") or base.getpalette()
    palette = bytes(palette[:768])
    n_colors = max(2, len(palette) // 3)

    # 全局色表大小必须是 2 的幂，且 >= 实际颜色数
    gct_bits = 1
    while (1 << gct_bits) < n_colors:
        gct_bits += 1
    gct_size = 1 << gct_bits
    palette += bytes(3 * (gct_size - n_colors))  # 补零到完整大小

    width, height = base.size

    def _quantize(frame):
        return frame.convert("RGB").quantize(palette=base, dither=Image.NONE)

    quantized = [_quantize(frame) for frame in frames]

    # 打包字段：全局色表存在(0x80) | 色深 7(0x70) | 色表大小位
    packed = 0x80 | 0x70 | (gct_bits - 1)

    min_code_size = max(2, gct_bits)
    chunks = [
        b"GIF89a",
        # 逻辑屏幕描述符
        width.to_bytes(2, "little"),
        height.to_bytes(2, "little"),
        bytes([packed, 0x00, 0x00]),
        palette,
    ]

    # NETSCAPE2.0 循环扩展
    chunks.append(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01" + loop.to_bytes(2, "little") + b"\x00")

    for frame, delay in zip(quantized, durations_ms):
        delay_cs = max(2, int(round(delay / 10)))  # GIF 延时单位是 1/100 秒，最小 2 避免过快
        # 图形控制扩展：disposal=2(恢复背景), 指定延时
        chunks.append(b"\x21\xF9\x04" + bytes([0x08]) + delay_cs.to_bytes(2, "little") + b"\x00\x00")
        # 图像描述符
        chunks.append(b"\x2C" + (0).to_bytes(2, "little") + (0).to_bytes(2, "little")
                      + width.to_bytes(2, "little") + height.to_bytes(2, "little") + bytes([0x00]))
        indices = list(frame.getdata())
        chunks.append(bytes([min_code_size]) + _sub_blocks(_lzw_encode(indices, min_code_size)))

    chunks.append(b"\x3B")  # trailer

    with open(path, "wb") as fh:
        fh.write(b"".join(chunks))

    return sum(durations_ms) / 1000
