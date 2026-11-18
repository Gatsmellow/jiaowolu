# -*- coding: utf-8 -*-
"""把项目里的 Markdown（只覆盖用到的那点语法）转成 docx。

用法：
    python tools/md2docx.py docs/项目报告.md docs/交我录-项目报告.docx

支持的语法：标题(#~####)、表格(| |)、无序列表(- / *)、有序列表(1.)、
代码块(```)、分隔线(---)、行内 **粗体** 与 `代码`、引用(>)。
不追求通用，够这份文档用就行。
"""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm

CN_FONT = "微软雅黑"
MONO_FONT = "Consolas"
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x66, 0x6B, 0x73)
ACCENT = RGBColor(0x1F, 0x4E, 0x8C)


def set_font(run, name=CN_FONT, size=None, bold=None, color=None, mono=False):
    run.font.name = MONO_FONT if mono else name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`)")


def add_rich(par, text, size=10.5, color=INK):
    """处理行内 **粗体** 与 `代码`。"""
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            set_font(par.add_run(text[pos:m.start()]), size=size, color=color)
        chunk = m.group(0)
        if chunk.startswith("**"):
            set_font(par.add_run(chunk[2:-2]), size=size, bold=True, color=color)
        else:
            set_font(par.add_run(chunk[1:-1]), size=size - 0.5, color=ACCENT, mono=True)
        pos = m.end()
    if pos < len(text):
        set_font(par.add_run(text[pos:]), size=size, color=color)


def split_row(line):
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def is_sep(line):
    return bool(re.match(r"^\|[\s:\-\|]+\|$", line.strip()))


def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.makeelement(qn("w:shd"), {
        qn("w:val"): "clear",
        qn("w:color"): "auto",
        qn("w:fill"): hex_fill,
    })
    tc_pr.append(shd)


def add_table(doc, rows):
    header = split_row(rows[0])
    body = [split_row(r) for r in rows[2:]]
    table = doc.add_table(rows=1, cols=len(header))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True

    hdr = table.rows[0].cells
    for i, cell in enumerate(header):
        hdr[i].text = ""
        par = hdr[i].paragraphs[0]
        add_rich(par, cell, size=9.5)
        for run in par.runs:
            run.bold = True
        shade(hdr[i], "E8EEF7")

    # 表头跨页重复
    tr_pr = table.rows[0]._tr.get_or_add_trPr()
    tr_pr.append(tr_pr.makeelement(qn("w:tblHeader"), {qn("w:val"): "true"}))

    for cells in body:
        row = table.add_row().cells
        for i in range(len(header)):
            row[i].text = ""
            add_rich(row[i].paragraphs[0], cells[i] if i < len(cells) else "", size=9.5)

    # 按内容长度分配列宽，最少 2 cm
    total = 16.5
    n = len(header)
    weights = []
    for i in range(n):
        longest = max([len(header[i])] + [len(r[i]) for r in body if i < len(r)])
        weights.append(min(max(longest, 4), 60))
    s = sum(weights)
    widths = [max(2.0, total * w / s) for w in weights]
    scale = total / sum(widths)
    widths = [w * scale for w in widths]
    for row in table.rows:
        for i, cell in enumerate(row.cells):
            cell.width = Cm(widths[i])

    doc.add_paragraph()


def convert(src, dst):
    lines = Path(src).read_text(encoding="utf-8").splitlines()
    doc = Document()

    style = doc.styles["Normal"]
    style.font.name = CN_FONT
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), CN_FONT)
    for section in doc.sections:
        section.left_margin = Cm(2.2)
        section.right_margin = Cm(2.2)
        section.top_margin = Cm(2.0)
        section.bottom_margin = Cm(2.0)

        # 页脚页码
        par = section.footer.paragraphs[0]
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_font(par.add_run("— "), size=9, color=MUTED)
        fld = par.add_run()
        fld._r.append(fld._r.makeelement(qn("w:fldChar"), {qn("w:fldCharType"): "begin"}))
        instr = fld._r.makeelement(qn("w:instrText"), {qn("xml:space"): "preserve"})
        instr.text = "PAGE"
        fld._r.append(instr)
        fld._r.append(fld._r.makeelement(qn("w:fldChar"), {qn("w:fldCharType"): "end"}))
        set_font(par.add_run(" —"), size=9, color=MUTED)

    i = 0
    while i < len(lines):
        line = lines[i]
        s = line.strip()

        if not s:
            i += 1
            continue

        # 代码块
        if s.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            i += 1
            for code in block:
                par = doc.add_paragraph()
                par.paragraph_format.space_after = Pt(0)
                par.paragraph_format.left_indent = Cm(0.5)
                set_font(par.add_run(code), size=8.5, color=RGBColor(0x33, 0x33, 0x33), mono=True)
            doc.add_paragraph()
            continue

        # 表格
        if s.startswith("|") and i + 1 < len(lines) and is_sep(lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            add_table(doc, rows)
            continue

        # 标题
        if s.startswith("#"):
            level = len(s) - len(s.lstrip("#"))
            text = s[level:].strip()
            if level == 1:
                par = doc.add_paragraph()
                par.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_font(par.add_run(text), size=20, bold=True, color=RGBColor(0x11, 0x11, 0x11))
                par.paragraph_format.space_after = Pt(6)
            else:
                sizes = {2: 15, 3: 12.5, 4: 11}
                par = doc.add_paragraph()
                par.paragraph_format.space_before = Pt(12 if level == 2 else 8)
                par.paragraph_format.space_after = Pt(4)
                color = RGBColor(0x1F, 0x4E, 0x8C) if level == 2 else RGBColor(0x22, 0x22, 0x22)
                set_font(par.add_run(text), size=sizes.get(level, 11), bold=True, color=color)
            i += 1
            continue

        # 分隔线
        if s in ("---", "***", "___"):
            par = doc.add_paragraph()
            par.paragraph_format.space_before = Pt(2)
            par.paragraph_format.space_after = Pt(2)
            set_font(par.add_run("—" * 30), size=8, color=RGBColor(0xC8, 0xCD, 0xD4))
            i += 1
            continue

        # 引用
        if s.startswith(">"):
            par = doc.add_paragraph()
            par.paragraph_format.left_indent = Cm(0.6)
            add_rich(par, s.lstrip("> ").strip(), size=9.5, color=MUTED)
            i += 1
            continue

        # 无序列表
        if re.match(r"^[-*]\s+", s):
            par = doc.add_paragraph(style="List Bullet")
            par.paragraph_format.space_after = Pt(2)
            add_rich(par, re.sub(r"^[-*]\s+", "", s))
            i += 1
            continue

        # 有序列表
        m = re.match(r"^(\d+)\.\s+(.*)$", s)
        if m:
            par = doc.add_paragraph()
            par.paragraph_format.left_indent = Cm(0.6)
            par.paragraph_format.space_after = Pt(2)
            set_font(par.add_run(m.group(1) + ". "), bold=True)
            add_rich(par, m.group(2))
            i += 1
            continue

        # 结尾的斜体备注
        if s.startswith("*") and s.endswith("*") and not s.startswith("**"):
            par = doc.add_paragraph()
            run = par.add_run(s.strip("*"))
            set_font(run, size=9, color=MUTED)
            run.italic = True
            i += 1
            continue

        # 普通段落
        par = doc.add_paragraph()
        par.paragraph_format.space_after = Pt(4)
        par.paragraph_format.line_spacing = 1.25
        add_rich(par, s)
        i += 1

    out = Path(dst)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(out)
    print("saved", out, out.stat().st_size, "B")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)
    convert(sys.argv[1], sys.argv[2])
