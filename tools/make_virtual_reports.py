"""生成"虚拟化验单/病历"——版式、信息密度对齐真实报告，但内容全部虚构。

为什么单独写一个：原来的 make_sample_reports.py 是 4 列的简易版式，
用来跑通链路够了，但离真实报告差得远（真实单子是 8 列：序号/代号/项目/
结果/提示/单位/参考区间/测试方法，页眉还有病人号、标本号、仪器、临床诊断）。
拿真实照片测试时，模型会受版式影响，样例太干净反而测不出问题。

用的人全部是虚构的：住院号 90000xxxxx、姓名"李明慧"、电话地址都不写真值。
运行：python tools/make_virtual_reports.py
输出：app/test/samples/virtual/
"""
from __future__ import annotations

import os
import re

from PIL import Image, ImageDraw, ImageFont

W = 1600
S = 2
FONT = r"C:\Windows\Fonts\msyh.ttc"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "test", "samples", "virtual")

INK = "#1a1a1a"
GREY = "#555b61"
LINE = "#b6bcc2"
HEAD = "#eef2f7"
RED = "#c0392b"
BLUE = "#1f5fa8"

HOSP = "上海市某三甲医院"
DEPT = "血液内科病区"

# 虚构患者：整套单据都是这一个人，方便当"一个患者的资料"来演示
PAT = {
    "name": "李明慧",
    "sex": "女",
    "age": "58",
    "mrn": "9000012345",
    "bed": "08",
    "diag": "弥漫大B细胞淋巴瘤",
    "sample_no": "20261120A0521",
}


def f(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size * S)


def canvas(h: int):
    img = Image.new("RGB", (W * S, h * S), "white")
    d = ImageDraw.Draw(img)

    def t(x, y, s, size=24, fill=INK, anchor="la"):
        d.text((x * S, y * S), s, font=f(size), fill=fill, anchor=anchor)

    def line(x0, y0, x1, y1, fill=LINE, w=1):
        d.line([(x0 * S, y0 * S), (x1 * S, y1 * S)], fill=fill, width=w * S)

    def rect(x0, y0, x1, y1, fill):
        d.rectangle([x0 * S, y0 * S, x1 * S, y1 * S], fill=fill)

    return img, d, t, line, rect


def head(t, line, title: str, date: str, instrument: str = "", extra: str = "", pat=None):
    """页眉：医院 + 报告名 + 病人信息三行 + 分隔线"""
    t(80, 44, HOSP, 34)
    t(W - 80, 52, "医学检验科", 22, GREY, anchor="ra")
    t(W // 2, 96, title, 30, RED, anchor="ma")
    line(70, 150, W - 70, 150, INK, 2)

    pat = pat or PAT
    t(80, 172, "姓　　名：" + pat["name"], 22)
    t(560, 172, "科　　室：" + DEPT, 22)
    t(1120, 172, "病 人 号：" + pat["mrn"], 22)
    t(80, 210, "性　　别：" + pat["sex"], 22)
    t(560, 210, "病　　区：" + DEPT, 22)
    t(1120, 210, "标 本 号：" + pat["sample_no"], 22)
    t(80, 248, "年　　龄：" + pat["age"] + "岁", 22)
    t(560, 248, "床　　号：" + pat["bed"], 22)
    t(1120, 248, "检测仪器：" + (instrument or "—"), 22)
    t(80, 286, "申请项目：" + extra, 22)
    t(760, 286, "临床诊断：" + pat["diag"], 22)
    t(80, 322, "采样时间：" + date, 22)
    line(70, 358, W - 70, 358)


def foot(t, line, date: str):
    t(80, 0, "备注：", 22, GREY)          # y 由调用方补
    t(80, 0, "", 22)


COLS = [
    ("序号", 80), ("代号", 150), ("项目名称", 250), ("结果", 690),
    ("提示", 810), ("单位", 900), ("参考区间", 1080), ("测试方法", 1400),
]


def table(t, line, rect, y0: int, rows) -> int:
    """八列表格，返回结束的 y"""
    h = 40
    rect(70, y0, W - 70, y0 + h, HEAD)
    for name, x in COLS:
        t(x, y0 + 9, name, 21, GREY)
    y = y0 + h
    line(70, y, W - 70, y, INK, 2)
    for i, (no, code, name, val, flag, unit, ref, method) in enumerate(rows):
        t(80, y + 10, no, 21, GREY)
        t(150, y + 10, code, 21, GREY)
        t(250, y + 10, name, 22)
        color = RED if flag == "↑" else (BLUE if flag == "↓" else INK)
        t(690, y + 10, val, 22, color)
        if flag:
            t(812, y + 10, flag, 22, color)
        t(900, y + 10, unit, 21)
        t(1080, y + 10, ref, 21)
        t(1400, y + 10, method, 19, GREY)
        y += h
        line(70, y, W - 70, y)
    return y


def rows_of(data):
    """data: (code,name,val,flag,unit,ref,method) -> 加序号"""
    return [(str(i + 1).rjust(2), *r) for i, r in enumerate(data)]


# ---------------- 各页面数据（全部虚构，但量级贴近淋巴瘤患者） ----------------

CBC = [
    ("WBC", "＊白细胞计数", "6.83", "", "10^9/L", "3.5—9.5", "流式＋激光＋染色"),
    ("RBC", "＊红细胞计数", "3.61", "↓", "10^12/L", "3.8—5.1", "电阻抗法"),
    ("HGB", "＊血红蛋白", "96", "↓", "g/L", "115—150", "光电比色法"),
    ("PLT", "＊血小板计数", "188", "", "10^9/L", "125—350", "电阻抗法"),
    ("%NEUT", "中性粒细胞百分比", "78.9", "↑", "%", "40—75", "计算"),
    ("%LYMPH", "淋巴细胞百分比", "13.2", "↓", "%", "20—50", "计算"),
    ("NEUT_C", "中性粒细胞计数", "5.39", "", "10^9/L", "1.8—6.3", "流式＋激光＋染色"),
    ("LYMPH_C", "淋巴细胞计数", "0.90", "↓", "10^9/L", "1.1—3.2", "流式＋激光＋染色"),
    ("MONO_C", "单核细胞计数", "0.42", "", "10^9/L", "0.1—0.6", "流式＋激光＋染色"),
    ("HCT", "＊红细胞压积", "0.315", "↓", "L/L", "0.35—0.45", "电阻抗法"),
    ("MCV", "＊红细胞平均体积", "87.3", "", "fL", "82—100", "电阻抗法"),
    ("MCH", "＊平均血红蛋白量", "26.6", "↓", "pg", "27—34", "计算"),
    ("MCHC", "＊平均血红蛋白浓度", "305", "↓", "g/L", "316—354", "计算"),
]

CHEM = [
    ("K", "＊钾", "3.71", "", "mmol/L", "3.5—5.3", "离子选择电极法"),
    ("Na", "＊钠", "139", "", "mmol/L", "137—147", "离子选择电极法"),
    ("CL", "＊氯", "104", "", "mmol/L", "99—110", "离子选择电极法"),
    ("Ca", "＊钙", "2.19", "", "mmol/L", "2.11—2.52", "偶氮胂Ⅲ法"),
    ("P", "＊磷", "1.16", "", "mmol/L", "0.85—1.51", "磷钼酸法"),
    ("TBIL", "＊总胆红素", "13.8", "", "μmol/L", "3.4—17.1", "钒酸盐氧化法"),
    ("DBIL", "＊直接胆红素", "4.6", "", "μmol/L", "≤8", "钒酸盐氧化法"),
    ("IBIL", "间接胆红素", "9.2", "", "μmol/L", "1.7—10.2", "计算"),
    ("ALT", "＊丙氨酸氨基转移酶", "46", "↑", "U/L", "7—40", "IFCC法"),
    ("AST", "＊天门冬氨酸氨基转移酶", "38", "↑", "U/L", "13—35", "IFCC法"),
    ("LDH", "＊乳酸脱氢酶", "328", "↑", "U/L", "120—250", "IFCC法"),
    ("ALP", "＊碱性磷酸酶", "88", "", "U/L", "35—100", "IFCC法"),
    ("GGT", "＊γ-谷氨酰转肽酶", "52", "", "U/L", "7—45", "IFCC法"),
    ("TP", "＊总蛋白", "58.6", "↓", "g/L", "65—85", "双缩脲法"),
    ("ALB", "＊白蛋白", "34.2", "↓", "g/L", "40—55", "溴甲酚绿法"),
    ("GLB", "球蛋白", "24.4", "", "g/L", "20—40", "计算"),
    ("Crea", "＊肌酐", "62", "", "μmol/L", "41—81", "肌氨酸氧化酶法"),
    ("Urea", "＊尿素", "6.4", "", "mmol/L", "3.1—8.8", "紫外-谷氨酸脱氢酶法"),
    ("GLU", "＊葡萄糖", "5.12", "", "mmol/L", "3.9—6.1", "葡萄糖氧化酶法"),
]

COAG = [
    ("PT", "凝血酶原时间", "12.4", "", "Sec", "10—13", "凝固法"),
    ("INR", "国际标准化比值", "1.06", "", "", "0.8—1.5", "计算"),
    ("APTT", "部分凝血活酶时间", "29.8", "", "Sec", "21.1—32.5", "凝固法"),
    ("TT", "凝血酶时间", "16.2", "", "Sec", "14—21", "凝固法"),
    ("FIB", "纤维蛋白原", "5.21", "↑", "g/L", "2—4", "凝固法"),
    ("FDP", "纤维蛋白(原)降解产物", "3.6", "", "μg/mL", "0—5", "免疫比浊法"),
    ("DDIMER", "D-二聚体", "0.86", "↑", "mg/L FEU", "0—0.5", "免疫比浊法"),
]

IMMU = [
    ("IGG", "免疫球蛋白IgG", "16.8", "↑", "g/L", "7.0—16.0", "免疫比浊法"),
    ("IGA", "免疫球蛋白IgA", "2.31", "", "g/L", "0.7—4.0", "免疫比浊法"),
    ("IGM", "免疫球蛋白IgM", "0.86", "", "g/L", "0.4—2.3", "免疫比浊法"),
    ("B2MG", "β2-微球蛋白", "3.62", "↑", "mg/L", "1.0—3.0", "免疫比浊法"),
    ("SF", "铁蛋白", "512", "↑", "ng/mL", "13—150", "化学发光法"),
    ("ESR", "红细胞沉降率", "46", "↑", "mm/h", "0—20", "魏氏法"),
    ("IFFE", "血免疫固定电泳", "阴性", "", "", "阴性", "琼脂糖凝胶电泳"),
    ("CIMU", "血清M蛋白检测", "未检出", "", "", "未检出", "免疫固定电泳"),
]

INFECT = [
    ("HBSAG", "乙型肝炎表面抗原", "阴性", "", "", "阴性", "化学发光法"),
    ("HBSAB", "乙型肝炎表面抗体", "阳性", "", "", "阴性/阳性", "化学发光法"),
    ("HBEAG", "乙型肝炎e抗原", "阴性", "", "", "阴性", "化学发光法"),
    ("HBEAB", "乙型肝炎e抗体", "阴性", "", "", "阴性", "化学发光法"),
    ("HBCAB", "乙型肝炎核心抗体", "阳性", "", "", "阴性", "化学发光法"),
    ("HBCAB_IGM", "乙型肝炎核心抗体IgM", "阴性", "", "", "阴性", "化学发光法"),
    ("HCVAB", "丙型肝炎病毒抗体", "阴性", "", "", "阴性", "化学发光法"),
    ("HBV_DNA", "乙型肝炎病毒核酸定量", "<500", "", "IU/mL", "<500", "PCR法"),
    ("EBV_DNA", "EB病毒DNA定量", "1.2E+03", "↑", "copies/mL", "<500", "PCR法"),
]

FISH = [
    ("FISH_BCL2", "BCL2 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_BCL6", "BCL6 基因断裂", "阳性", "", "", "阴性", "FISH"),
    ("FISH_CMYC", "C-MYC 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_TP53", "TP53 基因缺失", "阴性", "", "", "阴性", "FISH"),
    ("FISH_IRF4", "IRF4 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_MALT1", "MALT1 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_CCND1", "CCND1 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_ALK", "ALK 基因断裂", "阴性", "", "", "阴性", "FISH"),
    ("FISH_MYC_IGH", "MYC/IGH 融合", "阴性", "", "", "阴性", "FISH"),
    ("FISH_BCL2_IGH", "BCL2/IGH 融合", "阴性", "", "", "阴性", "FISH"),
    ("FISH_BCL6_IGH", "BCL6/IGH 融合", "阴性", "", "", "阴性", "FISH"),
    ("FISH_P53_DEL", "17p13(TP53) 缺失", "阴性", "", "", "阴性", "FISH"),
    ("FISH_1P36", "1p36 缺失", "阴性", "", "", "阴性", "FISH"),
    ("FISH_IGH", "IGH 基因重排", "阳性", "", "", "阴性", "FISH"),
    ("FISH_IGK", "IGK 基因重排", "阳性", "", "", "阴性", "FISH"),
    ("FISH_IGL", "IGL 基因重排", "阴性", "", "", "阴性", "FISH"),
]


def wrap_lines(text: str, width: int) -> list[str]:
    """按"拉丁串/单字"切块排版，数字和单位粘在一起不被拆开"""
    text = re.sub(r"(\d)\s+([A-Za-zμ%/^])", "\\1\u00a0\\2", text)
    chunks = re.findall(r"[A-Za-z0-9.\^/%<>×·μ\u00a0\-]+|.", text)
    out, line = [], ""
    for ch in chunks:
        if len(line) + len(ch) > width and line:
            out.append(line)
            line = ""
        line += ch
    if line:
        out.append(line)
    return out


def lab_report(filename: str, title: str, data, date: str,
               instrument: str = "", extra: str = "", note: str = "带＊项目为检验结果互认项目。", pat=None, outdir=None):
    rows = data
    H = 470 + len(rows) * 40 + 230
    img, d, t, line, rect = canvas(H)
    head(t, line, title, date, instrument, extra, pat)
    y0 = 380
    if note:
        t(80, y0 - 34, note, 20, GREY)
    y = table(t, line, rect, y0, rows_of(rows))
    line(70, y + 40, W - 70, y + 40)
    t(80, y + 60, "检验者：周晓岚　　　　审核者：陈立群", 21, GREY)
    t(80, y + 96, "注：此结果仅对本次标本负责；如有疑问，请在报告发布一周内提出。", 19, GREY)
    img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(outdir or OUT, filename), quality=90)
    print("  " + filename, img.size)


def text_report(filename: str, title: str, blocks, date: str, instrument: str = "—", extra: str = "", pat=None, outdir=None):
    """段落型文书：出院记录、病理报告、影像报告"""
    lines_all = []
    for kind, body in blocks:
        if kind == "h":
            lines_all.append(("h", body))
        else:
            for ln in wrap_lines(body, 62):
                lines_all.append(("p", ln))
    H = 470 + len(lines_all) * 40 + 200
    img, d, t, line, rect = canvas(H)
    head(t, line, title, date, instrument, extra, pat)
    y = 388
    for kind, body in lines_all:
        if kind == "h":
            t(80, y, body, 24, INK)
            y += 46
        else:
            t(80, y, body, 22)
            y += 40
    line(70, y + 30, W - 70, y + 30)
    t(80, y + 50, "记录医师：尹桂香　　　　审核医师：何雪梅", 21, GREY)
    t(80, y + 86, "本文件为演示用虚构资料，不含任何真实患者信息。", 19, GREY)
    img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(outdir or OUT, filename), quality=90)
    print("  " + filename, img.size)


def form_report(filename: str, title: str, fields, date: str, extra: str = "", pat=None, outdir=None):
    """表格型文书：病案首页"""
    H = 470 + max(1, (len(fields) + 1) // 2) * 52 + 220
    img, d, t, line, rect = canvas(H)
    head(t, line, title, date, "—", extra, pat)
    y = 384
    colw = (W - 140) // 2
    for i, (label, value) in enumerate(fields):
        col = i % 2
        row = i // 2
        x = 80 + col * colw
        yy = y + row * 52
        t(x, yy, label, 21, GREY)
        t(x + 170, yy, value, 22)
    rows = (len(fields) + 1) // 2
    line(70, y + rows * 52 + 8, W - 70, y + rows * 52 + 8)
    t(80, y + rows * 52 + 28, "科主任：陈祖聪　　质控医师：赵维成　　质控护士：董露露", 21, GREY)
    t(80, y + rows * 52 + 64, "本文件为演示用虚构资料，不含任何真实患者信息。", 19, GREY)
    img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(outdir or OUT, filename), quality=90)
    print("  " + filename, img.size)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    d1 = "2026-11-20 07:42"
    print("生成虚拟单据：")

    lab_report("vr-cbc-20261120.jpg", "血常规报告单", CBC, d1,
               instrument="血球仪BC-7500", extra="血常规（急查）")
    lab_report("vr-chem-20261120.jpg", "生化检验报告单", CHEM, d1,
               instrument="生化仪cobas8000", extra="肝肾功能＋电解质＋血糖")
    lab_report("vr-coag-20261120.jpg", "凝血功能检验报告单", COAG, d1,
               instrument="血凝仪CS5100", extra="凝血功能常规")
    lab_report("vr-immu-20261120.jpg", "免疫学检验报告单", IMMU, d1,
               instrument="免疫分析仪cobas8000", extra="免疫球蛋白＋β2微球蛋白＋铁蛋白")
    lab_report("vr-infect-20261120.jpg", "病毒学检验报告单", INFECT, d1,
               instrument="全自动免疫分析仪", extra="乙肝五项＋丙肝抗体＋病毒核酸")
    lab_report("vr-fish-20261120.jpg", "FISH检测报告单", FISH, d1,
               instrument="荧光显微镜", extra="淋巴瘤相关基因重排检测")

    text_report("vr-patho-20261120.jpg", "病理检查报告单", [
        ("h", "病理诊断"),
        ("p", "（右颈部淋巴结）弥漫大B细胞淋巴瘤，非特殊型，生发中心来源。免疫组化结果见下。"),
        ("h", "免疫组化"),
        ("p", "CD20（+），CD79a（+），CD3（-），CD5（-），CD10（+），BCL-2（+），BCL-6（+），"
              "MUM-1（-），CD30（-），CD21（残留FDC网+），Ki-67（70%+），CD19（+），"
              "CD22（+），CD38（-），CD138（-），P53（-），C-MYC（+，约20%），CyclinD1（-），"
              "SOX-11（-），EBER（-），CD4（-），CD8（-），CD56（-），PD-L1（-），"
              "CD68（散在+），GATA3（-），ALK（-），TIA-1（-），GramB（-），CD2（-），CD7（-）。"),
        ("h", "送检标本"),
        ("p", "右颈部淋巴结切除标本一枚，大小约 2.5cm×1.8cm×1.2cm。"),
    ], "2026-11-20 15:08", "荧光显微镜", "右颈部淋巴结切除标本")

    form_report("vr-course-20261120.jpg", "住院病案首页", [
        ("姓名：", PAT["name"]), ("性别：", pat["sex"]),
        ("住院号：", pat["mrn"]), ("就诊年龄：", pat["age"] + " 岁"),
        ("年龄：", pat["age"]), ("就诊日期：", "2026-11-18"),
        ("诊断分型：", "弥漫大B细胞淋巴瘤（非特殊型，Ⅳ期）"), ("民族：", "汉族"),
        ("户籍：", "上海市浦东新区"), ("身份证号：", "310115196801011234"),
        ("联系电话：", "13800138000"), ("其他联系方式：", "李伟；13900139000"),
        ("联系地址：", "上海市浦东新区某某路 128 号"), ("就诊医院：", HOSP),
    ], "2026-11-20 09:00")

    text_report("vr-discharge-20261120.jpg", "出院记录", [
        ("h", "入院诊断：1. 弥漫大B细胞淋巴瘤（Ⅳ期）"),
        ("h", "出院诊断：1. 恶性肿瘤靶向治疗 2. 弥漫大B细胞淋巴瘤 3. 轻度贫血"),
        ("h", "住院经过："),
        ("p", "入院后完善相关检查，2026-11-18 血常规：白细胞计数 6.83×10^9/L，"
              "血红蛋白 96 g/L，血小板计数 188×10^9/L；2026-11-18 生化：乳酸脱氢酶 328 U/L，"
              "谷丙转氨酶 46 U/L，白蛋白 34.2 g/L，肌酐 62 μmol/L，钾 3.71 mmol/L；"
              "2026-11-18 EBV-DNA 1.2E+03 copies/mL。2026-11-19 行 R-CHOP 方案化疗，过程顺利。"),
        ("h", "出院医嘱："),
        ("p", "1. 注意休息，避免受凉；2. 出院后 1 周复查血常规、肝肾功能；"
              "3. 下次入院时间 2026-12-10；4. 不适随诊。"),
    ], "2026-11-20 16:30", "—", "出院记录")


if __name__ == "__main__":
    main()
