"""被派发 harness 替身（B 阶段自测）：模拟 pi --mode json 的 NDJSON 输出。

用法：python fake_harness.py [--sleep 秒] [--fail] <prompt>
- prompt 中以「FILE: <相对仓库根的路径>」开头的行指定要写的文件；
  未指定时默认写 backend/hello-from-agent.txt（对应 R-M2 自指派小任务）；
- --sleep：模拟长任务（上限 15s，防测试进程泄漏）；--fail：模拟崩溃（exit 1）；
- 输出 assistant message_end（含 usage 与「FILES: ...」清单行），供派发执行器解析。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path.cwd()  # 派发器保证 cwd=仓库根；以 cwd 为基准写文件


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    # 测试探针：SPECLOCK2_FAKE_RECORD_ARGV=path 时把收到的完整命令行落盘，供断言接续参数
    record = os.environ.get("SPECLOCK2_FAKE_RECORD_ARGV")
    if record:
        Path(record).write_text(json.dumps(sys.argv), encoding="utf-8")

    args = sys.argv[1:]
    sleep_s, fail, plain, positional = 0.0, False, False, []
    i = 0
    while i < len(args):
        if args[i] == "--sleep":
            sleep_s = float(args[i + 1])
            i += 2
        elif args[i] == "--fail":
            fail = True
            i += 1
        elif args[i] == "--plain":
            plain = True  # 模拟 mcode：只输出纯文本，不发 NDJSON
            i += 1
        else:
            positional.append(args[i])
            i += 1
    prompt = " ".join(positional)
    started = time.time()

    if sleep_s:
        time.sleep(min(sleep_s, 15.0))
    if fail:
        sys.stderr.write("fake-harness: 模拟崩溃\n")
        sys.exit(1)

    files: list[str] = []
    for m in re.finditer(r"FILE:\s*(\S+)", prompt):  # 行内搜索：prompt 可能不换行
        target = REPO_ROOT / m.group(1).lstrip("/\\")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"written by fake_harness at {time.strftime('%H:%M:%S')}", encoding="utf-8")
        files.append(target.relative_to(REPO_ROOT).as_posix())
    if not files:
        default = REPO_ROOT / "backend" / "hello-from-agent.txt"
        default.parent.mkdir(parents=True, exist_ok=True)  # cwd 是任意绑定仓库，不保证有 backend/
        default.write_text("hello from fake harness", encoding="utf-8")
        files = ["backend/hello-from-agent.txt"]

    duration_ms = round((time.time() - started) * 1000)
    text = f"任务完成：写入 {len(files)} 个文件。FILES: {' '.join(files)}"
    if plain:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
        sys.exit(0)
    send({"type": "message_start", "message": {"role": "user", "content": prompt}})
    send({"type": "message_end", "message": {
        "role": "assistant",
        "content": [{"type": "text",
                     "text": f"任务完成：写入 {len(files)} 个文件。FILES: {' '.join(files)}"}],
        "usage": {"input": 1200, "output": 80, "cacheRead": 0, "cacheWrite": 0,
                  "totalTokens": 1280, "cost": {"total": 0.001}},
        "durationMs": duration_ms,
    }})
    send({"type": "agent_end", "messages": [], "willRetry": False})


if __name__ == "__main__":
    main()
