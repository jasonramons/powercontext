"""代码修改的应用、快照与差异。"""

from __future__ import annotations

import difflib
import json
from datetime import datetime, timezone
from pathlib import Path


def read_text(path: Path) -> str:
    return path.read_text("utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, "utf-8")


def unified_diff(before: str, after: str, relative_path: str) -> str:
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{relative_path}",
            tofile=f"b/{relative_path}",
            n=3,
        )
    )


def apply_files(root: Path, files: list[dict]) -> list[str]:
    """把模型给出的完整文件内容落盘，返回写入的相对路径。"""
    written = []
    for item in files:
        relative = str(item["path"]).replace("\\", "/").lstrip("/")
        if relative.startswith("..") or ":" in relative:
            raise ValueError(f"拒绝写入越界路径：{relative}")
        if not relative.startswith("business/app/"):
            raise ValueError(f"只允许修改 business/app/ 下的实现文件：{relative}")
        target = root / relative
        write_text(target, str(item["content"]))
        written.append(relative)
    return written


def save_snapshot(path: Path, content: str) -> None:
    write_text(path, content)


def load_generation_files(path: Path) -> list[dict]:
    data = json.loads(path.read_text("utf-8"))
    payload = json.loads(_extract_json(data["response"]))
    return payload["files"]


def _extract_json(text: str) -> str:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("记录里没有 JSON 负载")
    return text[start:end + 1]


def write_diff_record(path: Path, before: str, after: str, relative_path: str, generation: dict | None = None) -> str:
    diff = unified_diff(before, after, relative_path)
    header = [
        f"# 代码差异 · {relative_path}",
        f"# 生成时间：{datetime.now(timezone.utc).isoformat(timespec='seconds')}",
    ]
    if generation:
        header.append(
            f"# MiniMax：{generation.get('model')} · generation={generation.get('generation_id')} "
            f"· round={generation.get('round')} · mode={generation.get('mode')}"
        )
    write_text(path, "\n".join(header) + "\n\n" + diff)
    return diff
