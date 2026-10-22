"""Identify image format and pixel size from file bytes, without Pillow."""
import struct

FORMATS = {"jpeg": "jpg", "png": "png", "gif": "gif", "webp": "webp"}


def sniff(data):
    """Return (format, width, height); format is None if this isn't a known image."""
    if data[:3] == b"\xff\xd8\xff":
        return ("jpeg",) + _jpeg_size(data)
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return ("png",) + struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        return ("gif",) + struct.unpack("<HH", data[6:10])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ("webp",) + _webp_size(data)
    return None, None, None


def _jpeg_size(data):
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        # SOF markers carry the frame size (C4 DHT, C8 JPG, CC DAC are not frames)
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    return None, None


def _webp_size(data):
    chunk = data[12:16]
    if chunk == b"VP8 " and len(data) >= 30:
        w, h = struct.unpack("<HH", data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    if chunk == b"VP8L" and len(data) >= 25:
        b = data[21:25]
        return 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
    if chunk == b"VP8X" and len(data) >= 30:
        return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
    return None, None
