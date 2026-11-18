"""探测：你的 Key 现在到底能用哪些模型、哪些能看图、浏览器能不能直连。

为什么要"本地实测"而不是查文档：
  1) 厂商文档写的是"平台支持什么"，不是"你这个账号现在能调什么"——模型要开通、
     接入点要绑定，缺一样文档都对、你就是调不通。
  2) 图片能力必须真发一张图才知道。很多模型会"礼貌地"接受图片参数然后瞎编，
     所以这里看的是它能不能读出图上的数字，而不是接口有没有报错。
  3) 浏览器能不能直连，取决于服务器实际返回的响应头（CORS），这个只有真发请求才看得见。

用法：
  python tools\\probe_model.py                 # 自动发现模型并逐个测
  python tools\\probe_model.py --image 报告.png  # 用真实报告图测
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = os.path.join(ROOT, "secrets")
ORIGIN = "http://127.0.0.1:8765"

KEY_FILES = ["ark_api.txt", "ark_key.txt", "api_key.txt", "key.txt"]
CONFIG_FILE = "api.txt"
DEFAULT_BASE = "https://api.deepseek.com"

PROMPT = (
    "这是一张化验单截图。只输出 JSON，不要任何解释，格式："
    '{"items":[{"raw_name":"原文项目名","value":"数值","unit":"单位"}]}'
)


def find_key() -> tuple[str, str]:
    for name in KEY_FILES:
        p = os.path.join(SECRETS, name)
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8-sig") as f:
                key = f.read().strip()
            if key:
                print(f"[ok] 读到 Key：secrets/{name}（长度 {len(key)}，前 4 位 {key[:4]}…）")
                return p, key
    print(f"[x] 在 {SECRETS} 下没找到 Key 文件（找过：{KEY_FILES}）")
    sys.exit(2)


def find_base() -> str:
    p = os.path.join(SECRETS, CONFIG_FILE)
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line.startswith("base_url="):
                    v = line.split("=", 1)[1].strip().rstrip("/")
                    print(f"[ok] 使用自定义地址：{v}")
                    return v
    return DEFAULT_BASE


def make_test_image(path: str | None) -> bytes:
    if path:
        with open(path, "rb") as f:
            return f.read()
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (880, 300), "white")
    d = ImageDraw.Draw(img)
    font = None
    for cand in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"):
        if os.path.exists(cand):
            font = ImageFont.truetype(cand, 28)
            break
    d.text((36, 24), "XX 医院  检验报告单", fill="black", font=font or ImageFont.load_default())
    y = 96
    for r in ["血红蛋白     135    g/L     130-175",
              "白细胞计数   6.52   10^9/L  3.5-9.5",
              "血小板计数   218    10^9/L  125-350"]:
        d.text((36, y), r, fill="black", font=font or ImageFont.load_default())
        y += 58
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def acao(h: dict) -> str | None:
    for k, v in h.items():
        if k.lower() == "access-control-allow-origin":
            return v
    return None


def request(method: str, url: str, key: str, payload=None, timeout=90.0):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Origin", ORIGIN)  # 模拟浏览器页面，看回包带不带 CORS 头
    if data:
        req.add_header("Content-Type", "application/json")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:  # noqa: BLE001
        return None, {}, f"{type(e).__name__}: {e}", time.time() - t0


def err_msg(raw: str) -> str:
    try:
        j = json.loads(raw)
        e = j.get("error") or {}
        if isinstance(e, dict):
            return f"{e.get('code') or e.get('type') or '?'}: {(e.get('message') or '')[:140]}"
        return str(e)[:140]
    except Exception:  # noqa: BLE001
        return raw[:140].replace("\n", " ")


def list_models(base: str, key: str):
    st, h, raw, _ = request("GET", f"{base}/models", key, timeout=30)
    if st != 200:
        print(f"[!] 列模型失败 {st}: {err_msg(raw)}")
        return [], st, acao(h)
    try:
        ids = [m["id"] for m in json.loads(raw).get("data", [])]
    except Exception:  # noqa: BLE001
        print(f"[!] 返回格式不认识：{raw[:200]}")
        return [], st, acao(h)
    print(f"[ok] 这个 Key 能看到 {len(ids)} 个模型：{', '.join(ids)}")
    print(f"     CORS 头（GET /models）：{acao(h)}")
    return ids, st, acao(h)


def probe_vision(base: str, model: str, key: str, img: bytes, max_tokens: int = 300) -> dict:
    b64 = base64.b64encode(img).decode()
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
    }
    st, h, raw, dt = request("POST", f"{base}/chat/completions", key, payload)
    got = ("135" in raw) and ("g/L" in raw or "g/l" in raw.lower())
    out = {"model": model, "status": st, "sees_image": got, "latency_s": round(dt, 2), "acao": acao(h)}
    if st == 200:
        try:
            j = json.loads(raw)
            out["usage"] = j.get("usage")
            out["reply"] = (j["choices"][0]["message"].get("content") or "")[:260]
        except Exception:  # noqa: BLE001
            out["reply"] = raw[:260]
    else:
        out["error"] = err_msg(raw)
    mark = "看图OK" if got else ("能调通" if st == 200 else "失败")
    print(f"[{mark:^6}] {model:<34} HTTP {st} {dt:6.2f}s  CORS={out['acao']}")
    if not got and st == 200:
        print(f"          回复片段：{out.get('reply', '')[:120]!r}")
    if st != 200:
        print(f"          错误：{out['error']}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", help="用真实报告截图测视觉")
    ap.add_argument("--base", help="临时指定接口地址")
    ap.add_argument("--model", help="只测这一个模型")
    ap.add_argument("--max-tokens", type=int, default=300, help="单次回答上限（推理型模型要留够）")
    args = ap.parse_args()

    _, key = find_key()
    base = args.base or find_base()
    print(f"[i] 接口地址：{base}\n")

    img = make_test_image(args.image)
    print(f"[i] 测试图：{len(img)} 字节（一张中文化验单样张，含 135 g/L）\n")

    ids, st, _ = list_models(base, key)
    if args.model:
        ids = [args.model]
    if not ids:
        print("\n列不出模型，改用常见名字盲试：deepseek-chat")
        ids = ["deepseek-chat"]

    results = [probe_vision(base, m, key, img, args.max_tokens) for m in ids[:10]]

    winners = [r for r in results if r.get("sees_image")]
    print("\n=== 结论 ===")
    if winners:
        w = winners[0]
        print(f"能看图的模型：{w['model']}")
        print(f"  单次延迟 {w['latency_s']}s，CORS={w['acao']}")
        if w.get("usage"):
            print(f"  token 用量：{json.dumps(w['usage'], ensure_ascii=False)}")
        print(f"  模型实际读出的内容：{w.get('reply', '')[:400]}")
    else:
        reachable = [r for r in results if r["status"] == 200]
        if reachable:
            print("能调通但没有一个真正读出了图上的数字 —— 这些模型只是接受了图片参数，")
            print("实际看不见图（纯文本模型）。这种最危险：不报错，但结果是编的。")
        else:
            print("一个都没调通，检查 Key 或接口地址。")

    outp = os.path.join(SECRETS, "probe_result.json")
    with open(outp, "w", encoding="utf-8") as f:
        json.dump({"base": base, "models": ids, "results": results}, f, ensure_ascii=False, indent=2)
    print(f"\n明细已写入 {outp}")


if __name__ == "__main__":
    main()
