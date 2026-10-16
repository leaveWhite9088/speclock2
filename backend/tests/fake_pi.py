"""假 pi RPC 子进程：读 stdin 命令，回放含 U+2028/U+2029 的事件序列（分帧验证用）。"""

import json
import sys


sys.stdout.reconfigure(encoding="utf-8")  # Windows 管道默认按系统代码页输出


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for raw in sys.stdin.buffer:
    try:
        cmd = json.loads(raw)
    except Exception:
        continue
    ctype = cmd.get("type")
    if ctype == "prompt":
        send({"id": cmd["id"], "type": "response", "command": "prompt",
              "success": True, "data": {"disposition": "started"}})
        # 行内含 raw U+2028/U+2029（JSON 字符串合法）：readline/splitlines 类实现会错误断帧
        send({"type": "message_update", "assistantMessageEvent": {
            "type": "text_delta", "contentIndex": 0, "delta": "你好世界"}})
        send({"type": "message_update", "assistantMessageEvent": {
            "type": "text_delta", "contentIndex": 0, "delta": "段落结束"}})
        send({"type": "message_end", "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "最终回复：行内分隔已处理"}]}})
        send({"type": "agent_settled", "aborted": False})
    elif ctype == "get_session_stats":
        send({"id": cmd["id"], "type": "response", "command": "get_session_stats",
              "success": True,
              "data": {"contextUsage": {"tokens": 170000, "contextWindow": 200000, "percent": 85}}})
sys.stderr.write("fake-pi exit\n")
