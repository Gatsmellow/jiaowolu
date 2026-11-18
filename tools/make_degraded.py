# -*- coding: utf-8 -*-
"""
把合成报告"退化"成真实拍摄的样子，用来做没有真实照片时的替代验证。

四级退化，逐级加码：
  L1 手机随手拍，光线正常
  L2 斜着拍，一边有阴影
  L3 光线差 + 手抖 + 噪点
  L4 对着电脑屏幕拍（摩尔纹 + 反光 + 色偏）

产出放在 app/test/degraded/，不进仓库（.gitignore 已排除）。
用法：python tools/make_degraded.py
"""
import os
import math
import random
from PIL import Image, ImageEnhance, ImageFilter, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "app", "test", "samples")
OUT = os.path.join(ROOT, "app", "test", "degraded")

random.seed(20261118)


def load(name):
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    return im


def pad(im, frac=0.06, color=(238, 236, 232)):
    w, h = im.size
    px, py = int(w * frac), int(h * frac)
    canvas = Image.new("RGB", (w + px * 2, h + py * 2), color)
    canvas.paste(im, (px, py))
    return canvas


def rotate(im, deg, color=(240, 239, 236)):
    return im.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=color)


def perspective(im, strength):
    """轻微透视：像手机没有正对着纸拍。"""
    w, h = im.size
    s = strength
    # QUAD 的顺序是：左上、左下、右下、右上（PIL 文档），顺序错了图会翻过去
    dst = [
        (w * s, h * s * 0.6),          # 左上
        (0, h * (1 - s * 0.8)),        # 左下
        (w * (1 - s), h * (1 - s * 0.2)),  # 右下
        (w * (1 - s * 0.5), 0),        # 右上
    ]
    quad = [c for pt in dst for c in pt]
    return im.transform((w, h), Image.QUAD, quad, resample=Image.BICUBIC, fillcolor=(245, 244, 240))


def side_shadow(im, side="left", power=0.55):
    """一侧被手或身体挡住光。"""
    w, h = im.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    steps = 48
    for i in range(steps):
        t = i / steps
        if side == "left":
            x0, x1 = 0, int(w * (0.10 + 0.55 * t))
        else:
            x0, x1 = int(w * (0.90 - 0.55 * t)), w
        d.rectangle([x0, 0, x1, h], fill=int(255 * power * (1 - t) ** 1.6))
    mask = mask.filter(ImageFilter.GaussianBlur(w // 25))
    dark = Image.new("RGB", (w, h), (28, 26, 24))
    return Image.composite(dark, im, mask.point(lambda v: int(v)))


def glare(im, cx=0.72, cy=0.18, r=0.30, alpha=140):
    """顶灯在纸面上的反光。"""
    w, h = im.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    bw, bh = int(w * r), int(h * r * 0.7)
    d.ellipse([int(w * cx - bw), int(h * cy - bh), int(w * cx + bw), int(h * cy + bh)], fill=alpha)
    layer = layer.filter(ImageFilter.GaussianBlur(w // 18))
    white = Image.new("RGB", (w, h), (255, 255, 254))
    return Image.composite(white, im, layer)


def vignette(im, power=0.42):
    w, h = im.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    d.ellipse([-w * 0.15, -h * 0.15, w * 1.15, h * 1.15], fill=255)
    layer = layer.filter(ImageFilter.GaussianBlur(w // 6))
    dark = Image.new("RGB", (w, h), (16, 15, 14))
    inv = layer.point(lambda v: int((255 - v) * power))
    return Image.composite(dark, im, inv)


def moire(im, period=4.0, strength=16):
    """拍屏幕时像素栅格与相机采样打架。"""
    w, h = im.size
    stripes = Image.new("L", (w, h), 0)
    px = stripes.load()
    for x in range(w):
        v = int(128 + 127 * math.sin(x * 2 * math.pi / period))
        for y in range(0, h):
            px[x, y] = v
    stripes = stripes.point(lambda v: int(abs(v - 128) / 128 * strength))
    tint = Image.new("RGB", (w, h), (60, 80, 120))
    return Image.composite(tint, im, stripes)


def noise(im, amount=9):
    w, h = im.size
    px = im.load()
    for _ in range(int(w * h * 0.18)):
        x, y = random.randrange(w), random.randrange(h)
        r, g, b = px[x, y]
        d = random.randint(-amount, amount)
        px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))
    return im


def shrink(im, scale):
    w, h = im.size
    small = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return small


def save(im, name, quality, max_width=None):
    if max_width and im.size[0] > max_width:
        r = max_width / im.size[0]
        im = im.resize((max_width, int(im.size[1] * r)), Image.LANCZOS)
    path = os.path.join(OUT, name)
    im.save(path, "JPEG", quality=quality, subsampling=2)
    return path, im.size, os.path.getsize(path)


def level1(im):
    im = pad(im, 0.05)
    im = rotate(im, 1.4)
    im = ImageEnhance.Brightness(im).enhance(1.04)
    im = ImageEnhance.Contrast(im).enhance(0.96)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    return im, 78


def level2(im):
    im = pad(im, 0.08)
    im = rotate(im, 2.8)
    im = side_shadow(im, "left", 0.5)
    im = ImageEnhance.Contrast(im).enhance(0.9)
    im = im.filter(ImageFilter.GaussianBlur(1.0))
    return im, 62


def level3(im):
    im = pad(im, 0.08)
    im = rotate(im, -4.5)
    im = side_shadow(im, "right", 0.62)
    im = vignette(im, 0.5)
    im = glare(im, 0.3, 0.14, 0.26, 120)
    im = ImageEnhance.Brightness(im).enhance(0.93)
    im = ImageEnhance.Contrast(im).enhance(0.82)
    im = im.filter(ImageFilter.GaussianBlur(1.5))
    im = noise(im, 10)
    return im, 46


def level4(im):
    im = pad(im, 0.10, (200, 200, 205))
    im = moire(im, 4.0, 18)
    im = glare(im, 0.55, 0.22, 0.34, 150)
    im = ImageEnhance.Color(im).enhance(0.75)
    im = ImageEnhance.Brightness(im).enhance(1.06)
    im = ImageEnhance.Contrast(im).enhance(0.88)
    im = im.filter(ImageFilter.GaussianBlur(0.9))
    return im, 58


def level5(im):
    """明显不合格的照片：对不上焦、光又暗、还小。用来找"什么时候开始读不对"。"""
    im = pad(im, 0.08)
    im = rotate(im, -6.5)
    im = side_shadow(im, "left", 0.72)
    im = vignette(im, 0.62)
    im = glare(im, 0.42, 0.5, 0.36, 165)
    im = ImageEnhance.Brightness(im).enhance(0.86)
    im = ImageEnhance.Contrast(im).enhance(0.72)
    im = im.filter(ImageFilter.GaussianBlur(2.4))
    im = noise(im, 16)
    return im, 34


LEVELS = [
    ("L1", "随手拍，光线正常", level1, 0.85),
    ("L2", "斜着拍，一边阴影", level2, 0.72),
    ("L3", "光线差+手抖+噪点", level3, 0.58),
    ("L4", "对着屏幕拍", level4, 0.80),
    ("L5", "拍糊了还偏暗", level5, 0.42),
]

SOURCES = [
    ("cbc-20261110.jpg", "cbc"),
    ("bio-20261110.jpg", "bio"),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        os.remove(os.path.join(OUT, name))
    print("%-6s %-22s %-10s %-12s %s" % ("级别", "说明", "文件", "尺寸", "大小"))
    print("-" * 66)
    for tag, desc, fn, scale in LEVELS:
        for src, short in SOURCES:
            im = load(src)
            im, q = fn(im)
            im = shrink(im, scale)
            out, size, nbytes = save(im, "%s-%s.jpg" % (short, tag), q)
            print("%-6s %-22s %-10s %-12s %.0f KB" % (tag, desc, os.path.basename(out), "%dx%d" % size, nbytes / 1024))
    print("\n输出目录：%s" % OUT)


if __name__ == "__main__":
    main()
