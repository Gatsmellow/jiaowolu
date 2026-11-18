"""生成《产品说明文档》用示意图（目标态）。

第一张：系统结构图 —— 让没有计算机背景的评委一眼看懂
  "你的电脑上跑两个东西，模型是你自己选的，中间没有我们的服务器"。
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

S = 2  # 2 倍超采样，缩小后字更清楚
W, H = 1600, 900
FONT = r"C:\Windows\Fonts\msyh.ttc"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "figs")

INK = "#20242B"
GREY = "#5B6472"
BLUE_F, BLUE_L = "#EDF3FE", "#3D6DB5"
GREEN_F, GREEN_L = "#EEF9F0", "#3F8C55"
ORANGE_F, ORANGE_L = "#FDF3E7", "#B8722C"


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size * S)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    img = Image.new("RGB", (W * S, H * S), "white")
    d = ImageDraw.Draw(img)

    def txt(x, y, s, size=28, fill=INK, anchor="la"):
        d.text((x * S, y * S), s, font=font(size), fill=fill, anchor=anchor)

    def box(x0, y0, x1, y1, fill, line, r=20, w=2):
        d.rounded_rectangle(
            [x0 * S, y0 * S, x1 * S, y1 * S], radius=r * S, fill=fill, outline=line, width=w * S
        )

    def arrow(x, y0, y1, color=GREY, head=9):
        d.line([(x * S, y0 * S), (x * S, y1 * S)], fill=color, width=2 * S)
        for tip, back in ((y1, y1 - head), (y0, y0 + head)):
            d.polygon(
                [(x * S, tip * S), ((x - head) * S, back * S), ((x + head) * S, back * S)],
                fill=color,
            )

    # 标题
    txt(W // 2, 44, "交我录 · 系统结构", 46, INK, anchor="ma")
    txt(W // 2, 108, "打开网页就能用，不需要服务器，不需要安装软件", 26, GREY, anchor="ma")

    # ① 浏览器
    box(80, 170, 1520, 400, BLUE_F, BLUE_L)
    txt(112, 196, "①  浏览器：质控工作台", 34, BLUE_L)
    txt(112, 250, "交我录的全部界面都在这里", 25, GREY)
    txt(112, 300, "指标库与模板      多患者上传与队列      红黄绿核对", 30, INK)
    txt(112, 350, "来源定位与人工裁决      导出 CSV / JSON", 30, INK)

    # ② 本机助手
    box(80, 480, 760, 760, GREEN_F, GREEN_L)
    txt(112, 506, "②  本机小助手", 34, GREEN_L)
    txt(112, 560, "PDF 拆页", 30, INK)
    txt(112, 610, "提取能直接复制的文字", 30, INK)
    txt(112, 660, "把页面转成图片", 30, INK)
    txt(112, 712, "只在你电脑上跑，不联网", 25, GREY)

    # ③ 模型
    box(840, 480, 1520, 760, ORANGE_F, ORANGE_L)
    txt(872, 506, "③  模型服务", 34, ORANGE_L)
    txt(872, 560, "判断这份报告是谁的、属于哪类检查", 30, INK)
    txt(872, 612, "读懂检验值与单位", 30, INK)
    txt(872, 664, "把不同叫法对到同一个指标", 30, INK)
    txt(872, 716, "用你自己申请的账号和额度", 25, GREY)

    # 箭头
    arrow(420, 400, 480)
    arrow(1180, 400, 480)
    txt(440, 414, "PDF 文件进 / 页面图片出", 23, GREY)
    txt(1200, 414, "报告页图进 / 结构化结果出", 23, GREY)

    # 脚注
    txt(W // 2, 812, "没有开发者服务器：报告只经过你自己的电脑，和你自己选择的模型服务。", 27, INK, anchor="ma")

    out = os.path.join(OUT_DIR, "fig01-architecture.png")
    img.resize((W, H), Image.LANCZOS).save(out, quality=95)
    print("saved", out)


if __name__ == "__main__":
    main()
