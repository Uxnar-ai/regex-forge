#!/usr/bin/env python3
"""regexlab —— 正则引擎解剖台。

前端自己写解析器 / Thompson 构造 / 子集构造 / 回溯匹配，Flask 只负责把静态页面发出去。
没有数据库、没有外部请求，一个进程足够。
"""
import os

from flask import Flask, render_template, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", os.environ.get("REGEXLAB_PORT", "8850")))

app = Flask(__name__, static_folder=os.path.join(BASE, "static"))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    return {"ok": True, "service": "regexlab"}


@app.route("/static/<path:name>")
def static_file(name):
    return send_from_directory(app.static_folder, name, max_age=300)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, threaded=True)
