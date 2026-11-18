"""探测国内主流大模型 API 是否允许浏览器直连（CORS 预检）。

浏览器从 http://127.0.0.1:8765 这类前端页面直接 POST /chat/completions 时，
会先发一个 OPTIONS 预检请求；只有响应带 Access-Control-Allow-Origin 才能通过。
本脚本不需要 API Key，只发预检与一个无鉴权的 POST，用于确定架构分支。

用法：python tools/probe_cors.py
"""
import json
import socket
import ssl
import urllib.error
import urllib.request

ORIGIN = "http://127.0.0.1:8765"

ENDPOINTS = [
    ("火山方舟/豆包", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"),
    ("阿里百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"),
    ("智谱", "https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    ("DeepSeek", "https://api.deepseek.com/chat/completions"),
    ("月之暗面", "https://api.moonshot.cn/v1/chat/completions"),
    ("硅基流动", "https://api.siliconflow.cn/v1/chat/completions"),
]


def preflight(url: str, timeout: float = 12.0):
    req = urllib.request.Request(url, method="OPTIONS")
    req.add_header("Origin", ORIGIN)
    req.add_header("Access-Control-Request-Method", "POST")
    req.add_header("Access-Control-Request-Headers", "authorization,content-type")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return None, {"_error": f"{type(e).__name__}: {e}"}


def unauth_post(url: str, timeout: float = 15.0):
    body = json.dumps({"model": "probe", "messages": [{"role": "user", "content": "hi"}]}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Origin", ORIGIN)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer invalid-probe-key")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)
    except Exception as e:  # noqa: BLE001
        return None, {"_error": f"{type(e).__name__}: {e}"}


def summarize(name, url):
    st, h = preflight(url)
    acao = h.get("Access-Control-Allow-Origin") or h.get("access-control-allow-origin")
    acah = h.get("Access-Control-Allow-Headers") or h.get("access-control-allow-headers")
    err = h.get("_error")
    st2, h2 = unauth_post(url) if not err else (None, {})
    acao2 = h2.get("Access-Control-Allow-Origin") or h2.get("access-control-allow-origin")
    return {
        "provider": name,
        "url": url,
        "preflight_status": st,
        "preflight_acao": acao,
        "preflight_acah": acah,
        "post_status": st2,
        "post_acao": acao2,
        "error": err,
        "verdict": "浏览器可直连" if (st and acao) or (st2 and acao2) else "预检未放行，需本地转发",
    }


def main():
    print(f"Origin: {ORIGIN}\n")
    rows = []
    for name, url in ENDPOINTS:
        try:
            rows.append(summarize(name, url))
        except Exception as e:  # noqa: BLE001
            rows.append({"provider": name, "url": url, "error": repr(e), "verdict": "探测失败"})
        r = rows[-1]
        print(
            f"[{r['provider']:<10}] preflight={r.get('preflight_status')} "
            f"ACAO={r.get('preflight_acao')} post={r.get('post_status')} "
            f"postACAO={r.get('post_acao')} -> {r['verdict']}"
        )
        if r.get("error"):
            print(f"             error: {r['error']}")

    print("\n=== JSON ===")
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
