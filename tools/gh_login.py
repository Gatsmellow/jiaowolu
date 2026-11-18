"""GitHub 设备码登录：把「登录」这一步留给人来做，其它全自动。

运行后会打印一个形如 XXXX-XXXX 的一次性代码，用户打开
https://github.com/login/device 输进去即可；脚本在后台轮询，
拿到令牌后写进 secrets/github_token.txt，并把账号名打印出来。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = "178c6fc778ccc68e1d6a"  # GitHub CLI 的公开客户端 ID，和 `gh auth login --web` 同一个
SCOPE = "repo"
DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "secrets", "github_token.txt")


def post_form(url, data, headers=None):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "jiaowolu-setup")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    start = post_form(DEVICE_CODE_URL, {"client_id": CLIENT_ID, "scope": SCOPE})
    if "device_code" not in start:
        print("申请设备码失败:", start, flush=True)
        return 1

    code = start["user_code"]
    interval = int(start.get("interval", 5))
    expires = int(start.get("expires_in", 900))
    uri = start.get("verification_uri", "https://github.com/login/device")

    print("=" * 46, flush=True)
    print("请在浏览器打开：", uri, flush=True)
    print("输入这个代码：", code, flush=True)
    print("=" * 46, flush=True)
    print("等待授权中……", flush=True)

    deadline = time.time() + expires
    while time.time() < deadline:
        time.sleep(interval)
        try:
            res = post_form(TOKEN_URL, {
                "client_id": CLIENT_ID,
                "device_code": start["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            })
        except urllib.error.HTTPError as e:
            res = json.loads(e.read().decode())

        err = res.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        if err:
            print("授权失败:", err, res.get("error_description", ""), flush=True)
            return 1

        token = res.get("access_token")
        if not token:
            print("没有拿到令牌:", res, flush=True)
            return 1

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8", newline="\n") as f:
            f.write(token + "\n")

        req = urllib.request.Request(USER_URL)
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "jiaowolu-setup")
        with urllib.request.urlopen(req, timeout=30) as r:
            me = json.loads(r.read().decode())

        print("登录成功，账号：", me.get("login"), flush=True)
        print("令牌已存到 secrets/github_token.txt", flush=True)
        return 0

    print("等待超时，请重新运行。", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
