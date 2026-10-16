"""协议模块（契约 v0.6 §3.1）：报告块解析、通知模板、人工回执的 parse_quality。"""

from __future__ import annotations

import json

from speclock2.protocol import notices
from speclock2.protocol.report import FILES_LIMIT, SUMMARY_LIMIT, parse_output

BLOCK = '<<<SL2-REPORT\n{body}\nSL2-REPORT>>>'


def _block(**fields) -> str:
    data = {"status": "done", "summary": "做完了", "files": ["a/b.txt"], "issues": []}
    data.update(fields)
    return BLOCK.format(body=json.dumps(data, ensure_ascii=False))


def test_valid_block():
    r = parse_output("干完了\n" + _block())
    assert r == {"status": "done", "summary": "做完了", "files_changed": ["a/b.txt"],
                 "issues": [], "parse_quality": "structured"}


def test_last_block_wins():
    text = _block(summary="第一个") + "\n中间文字\n" + _block(summary="第二个", status="partial")
    r = parse_output(text)
    assert r["summary"] == "第二个" and r["status"] == "partial"


def test_invalid_json():
    r = parse_output("<<<SL2-REPORT\n{坏的\nSL2-REPORT>>>")
    assert r["parse_quality"] == "invalid"
    assert r["issues"]


def test_invalid_status_value():
    assert parse_output(_block(status="great"))["parse_quality"] == "invalid"


def test_legacy_files_line():
    r = parse_output("任务完成。FILES: a.txt b.txt")
    assert r["parse_quality"] == "legacy"
    assert r["files_changed"] == ["a.txt", "b.txt"]


def test_no_block_no_files_uses_tail():
    text = "x" * 500 + "结尾"
    r = parse_output(text)
    assert r["parse_quality"] == "none"
    assert len(r["summary"]) == SUMMARY_LIMIT and r["summary"].endswith("结尾")
    assert r["files_changed"] == []


def test_path_with_spaces():
    r = parse_output(_block(files=["docs/my file.md", "b.txt"]))
    assert r["files_changed"] == ["docs/my file.md", "b.txt"]


def test_files_over_limit_truncated():
    r = parse_output(_block(files=[f"f{i}.txt" for i in range(FILES_LIMIT + 20)]))
    assert len(r["files_changed"]) == FILES_LIMIT
    assert r["parse_quality"] == "structured"


def test_summary_over_limit_truncated():
    r = parse_output(_block(summary="长" * 1000))
    assert len(r["summary"]) == SUMMARY_LIMIT


def test_crlf_newlines():
    text = _block().replace("\n", "\r\n")
    r = parse_output(text)
    assert r["parse_quality"] == "structured" and r["files_changed"] == ["a/b.txt"]


def test_nonzero_exit_forces_failed():
    r = parse_output(_block(status="done"), exit_code=2)
    assert r["status"] == "failed"
    assert r["files_changed"] == ["a/b.txt"]  # 其余字段照常解析


def test_notice_templates_read_report():
    report = {"status": "partial", "summary": "写了一半", "files_changed": ["a.txt", "b.txt"],
              "issues": ["缺依赖"], "parse_quality": "structured"}
    text = notices.task_completed("T-0001", "backend", report)
    assert text.startswith("系统通知：") and "partial" in text and "写了一半" in text
    assert "2 个" in text and "缺依赖" in text
    assert "boom" in notices.task_failed("T-0001", "backend", {"summary": "boom"}, "err")
    assert "看门狗" in notices.task_timeout("T-0001", "backend", {}, "2026-01-01")


def test_manual_receipt_parse_quality(client):
    client.post("/api/projects", json={"slug": "pm", "name": "pm"})
    r = client.post("/api/p/pm/tech-orders", json={
        "intent": "x", "scope": ["./"], "acceptance": []})
    tid = r.json()["task_id"]
    client.post(f"/api/p/pm/tasks/{tid}/dispatch", json={"watchdog_minutes": 30})
    client.post(f"/api/p/pm/tasks/{tid}/receipt", json={
        "files_changed": ["a.txt"], "self_check": "ok", "summary": "手工"})
    pkgs = client.get("/api/p/pm/packages").json()["items"]
    receipt = pkgs[0]["tasks"][0]["receipt"]
    assert receipt["report"]["parse_quality"] == "manual"
    events = client.get("/api/p/pm/events?type=task.report").json()["items"]
    assert len(events) == 1 and events[0]["payload"]["parse_quality"] == "manual"
