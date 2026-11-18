# -*- coding: utf-8 -*-
"""生成一份"有文字层"的检验报告 PDF（用于验证 PDF 双路径中的文字层分支）。

做法：先写一个 A4 排版的 HTML，再用 Chrome 的 --print-to-pdf 打印成 PDF。
Chrome 打印出来的 PDF 带真实文字层，pdf.js 的 getTextContent 能读到。

用法：
    python tools/make_text_pdf.py            # 只生成 HTML
    （随后由 run_text_pdf.bat / 命令行调用 Chrome 打印）
"""
import os
import sys

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'app', 'test', 'samples')
HTML = os.path.join(OUT_DIR, 'text-layer-report.html')

ROWS = [
    ('白细胞计数（WBC）', '6.83', '10^9/L', '3.5–9.5'),
    ('红细胞计数（RBC）', '4.51', '10^12/L', '4.3–5.8'),
    ('血红蛋白（HGB）', '138', 'g/L', '130–175'),
    ('血小板计数（PLT）', '205', '10^9/L', '125–350'),
    ('淋巴细胞计数', '1.86', '10^9/L', '1.1–3.2'),
]

def main():
    rows = '\n'.join(
        '<tr><td class="n">%s</td><td class="v">%s</td><td class="u">%s</td><td class="r">%s</td></tr>'
        % r for r in ROWS)
    html = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>血常规检验报告单</title>
<style>
  @page {{ size: A4; margin: 18mm 16mm; }}
  body {{ font-family: "Microsoft YaHei", "SimSun", sans-serif; color:#111; }}
  h1 {{ text-align:center; font-size:20pt; margin:0 0 2mm; letter-spacing:1px; }}
  h2 {{ text-align:center; font-size:13pt; font-weight:400; margin:0 0 6mm; color:#333; }}
  .meta {{ display:flex; flex-wrap:wrap; font-size:10.5pt; border-top:1.5px solid #222;
           border-bottom:1.5px solid #222; padding:3mm 0; margin-bottom:5mm; }}
  .meta div {{ width:50%; line-height:1.9; }}
  table {{ width:100%; border-collapse:collapse; font-size:10.5pt; }}
  th {{ text-align:left; font-weight:400; color:#555; padding:2mm 1mm; border-bottom:1px solid #222; }}
  td {{ padding:2.6mm 1mm; border-bottom:.5px solid #ddd; }}
  td.n {{ width:46%; }} td.v {{ width:18%; }} td.u {{ width:18%; }} td.r {{ width:18%; }}
  .foot {{ margin-top:8mm; border-top:1px solid #ccc; padding-top:3mm; font-size:9pt; color:#666; line-height:1.8; }}
</style></head>
<body>
  <h1>上海市某三甲医院</h1>
  <h2>血常规检验报告单</h2>
  <div class="meta">
    <div>姓　名：李国强</div><div>性　别：男</div>
    <div>年　龄：47 岁</div><div>样本号：20261118B0126</div>
    <div>科　别：血液科门诊</div><div>样本类型：静脉血</div>
    <div>采集时间：2026-11-18 07:52</div><div>报告时间：2026-11-18 09:10</div>
  </div>
  <table>
    <thead><tr><th>项目名称</th><th>结果</th><th>单位</th><th>参考范围</th></tr></thead>
    <tbody>
{rows}
    </tbody>
  </table>
  <div class="foot">
    检验者：周晓明　　审核者：陈立<br>
    说明：本报告仅对所检标本负责；参考范围为本实验室成人参考区间。
  </div>
</body></html>""".format(rows=rows)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(HTML, 'w', encoding='utf-8') as f:
        f.write(html)
    print('saved', os.path.abspath(HTML))


if __name__ == '__main__':
    main()
