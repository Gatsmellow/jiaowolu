"""把 docx 的段落和表格逐行打印出来，带编号，方便对照修改。"""
import sys

from docx import Document


def main(path: str) -> None:
    doc = Document(path)
    body = doc.element.body
    ti = 0
    pi = 0
    print("=== BODY ITEMS IN ORDER ===")
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            para = doc.paragraphs[pi]
            text = para.text.strip()
            pi += 1
            if text:
                print(f"[P{pi:03d}] {text}")
        elif tag == "tbl":
            table = doc.tables[ti]
            ti += 1
            print(f"--- TABLE {ti} ({len(table.rows)}x{len(table.columns)}) ---")
            for ri, row in enumerate(table.rows):
                cells = [c.text.strip().replace("\n", " / ") for c in row.cells]
                print(f"[T{ti}-R{ri:02d}] " + " | ".join(cells))


if __name__ == "__main__":
    main(sys.argv[1])
