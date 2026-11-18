#!/usr/bin/env python3
"""交我录 · 本机静态服务

只做三件事：把 app/ 里的文件发出去、回答 /__ping 心跳、别把连接攥死。

为什么不用 python -m http.server：
  1. 它把每个请求都打印到窗口，几十行日志刷过去，真出错了反而看不见；
  2. 它默认用 HTTP/1.0 但行为随版本变化，浏览器有时会攥着一条早就死掉的连接复用，
     表现就是"放一会儿不动，再点就没反应"；
  3. 它没有心跳接口，页面没法知道自己和服务已经断了。

用法：
  python server.py                 # 127.0.0.1:8765，服务 ./app
  python server.py --port 9000
  python server.py --dir app --bind 127.0.0.1
"""

import argparse
import json
import os
import socket
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

STARTED = time.time()
VERSION = "1.0"


class Handler(SimpleHTTPRequestHandler):
    # 每条请求用完就关连接。本地服务不在乎这点开销，
    # 但能保证浏览器不会攥着一条已经失效的长连接反复失败。
    protocol_version = "HTTP/1.0"
    server_version = "JiaoWoLu/" + VERSION

    def setup(self):
        super().setup()
        try:
            # 空闲超过 45 秒就断开，别让死连接占着线程
            self.connection.settimeout(45)
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        except OSError:
            pass

    def end_headers(self):
        # 改代码后刷新就生效，不用清缓存
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__ping" or path.endswith("/__ping"):
            body = json.dumps({
                "ok": True,
                "app": "jiaowolu",
                "version": VERSION,
                "uptime": round(time.time() - STARTED, 1),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        # 只报 4xx/5xx，正常请求不刷屏
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("  ! %s %s\n" % (code, args[0] if args else ""))
            sys.stderr.flush()

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, TimeoutError, socket.timeout):
            # 浏览器关标签页、切网络时会留下半截连接，这不是错误
            self.close_connection = True

    def handle_error(self, request=None, client_address=None):
        # 默认会把整段 traceback 打到窗口里，演示时非常难看
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


def port_busy(host, port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def who_is_there(host, port):
    """问一下端口上那个东西是不是交我录。不是的话返回 None。"""
    import urllib.request
    try:
        with urllib.request.urlopen("http://%s:%d/__ping" % (host, port), timeout=1.5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="交我录 本地静态服务")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--dir", default=os.path.join(here, "app"))
    a = ap.parse_args()

    root = os.path.abspath(a.dir)
    if not os.path.isdir(root):
        sys.stderr.write("目录不存在：%s\n" % root)
        return 2

    # 重要：Windows 下开着 SO_REUSEADDR 时，两个进程能同时"绑上"同一个端口，
    # 谁收到请求说不准——表现出来就是"有时候好用有时候连不上"。所以先问清楚。
    if port_busy(a.bind, a.port):
        info = who_is_there(a.bind, a.port)
        if info and info.get("app") == "jiaowolu":
            print("  已经有一个交我录在跑了：http://%s:%d/" % (a.bind, a.port))
            print("  直接用它就行，不用再开一个窗口。要重开就先关掉原来那个。")
            return 0
        sys.stderr.write("端口 %d 被别的程序占着。换个端口：python server.py --port 8766\n" % a.port)
        return 1

    handler = partial(Handler, directory=root)
    try:
        httpd = Server((a.bind, a.port), handler)
    except OSError as e:
        sys.stderr.write("端口 %d 起不来：%s\n" % (a.port, e))
        sys.stderr.write("大概率是上一次的服务还开着。关掉那个黑窗口，或者重启电脑。\n")
        return 1

    os.chdir(root)
    url = "http://%s:%d/" % (a.bind, a.port)
    print("  交我录已就绪  %s" % url)
    print("  心跳           %s__ping" % url)
    print("  按 Ctrl+C 或者直接关掉这个窗口即可停止。")
    sys.stdout.flush()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
