"""任务状态层：用 PowerContext 的 scoped Memory 保存并复用任务进展。

任务状态不是塞进 seekdb 的一张表，而是真正交给 PowerContext：一个固定的
scope（``idempotency_key`` 固定，重启后仍是同一个 scope）+ Memory 条目。
模块重启后重新打开同一个 SQLite 库，按 FTS 检索回读最近的进度快照，并把
「已完成 / 待办」带进下一次上下文。
"""

from __future__ import annotations

import json
from pathlib import Path

from powercontext.builtin.artifacts.memory import MemoryEntryInput
from powercontext.builtin.persistence.sqlite import SQLiteConfig
from powercontext.builtin.runtime import (
    BuiltinConfig,
    RememberMemoryRequest,
    SearchMemoryRequest,
    open_builtin_runtime,
)
from powercontext.builtin.scope import ScopeDraft

SCOPE_KEY = "mm-sdd-pagination-v1"
SCOPE_TITLE = "MiniMax × OceanBase · SDD 分页任务"
SCOPE_SUMMARY = "PAGINATION-SPEC 分页缺陷修复的任务进展与验证结果"
STATE_MARKER = "TASK-STATE-PAYLOAD"


class TaskStateStore:
    """PowerContext Runtime 的一个薄封装，只做「写入进度」和「按查询回读」。"""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.scope_id: str | None = None
        self._context_manager = None
        self._runtime = None
        self._memory = None

    async def open(self) -> "TaskStateStore":
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{self.db_path}"))
        # 保持 async context manager 存活：一旦被 GC，runtime 会立刻关闭。
        self._context_manager = open_builtin_runtime(config)
        self._runtime = await self._context_manager.__aenter__()
        scope = await self._runtime.scopes.create(
            ScopeDraft(title=SCOPE_TITLE, summary=SCOPE_SUMMARY, idempotency_key=SCOPE_KEY)
        )
        self.scope_id = scope.scope_id
        self._memory = self._runtime.memory.for_scope(scope.scope_id)
        return self

    async def close(self) -> None:
        if self._context_manager is not None:
            await self._context_manager.__aexit__(None, None, None)
            self._context_manager = None
            self._runtime = None
            self._memory = None

    async def __aenter__(self) -> "TaskStateStore":
        return await self.open()

    async def __aexit__(self, *exc_info) -> None:
        await self.close()

    # ------------------------------------------------------------------ 写
    async def save(self, record: dict) -> None:
        """把一份任务快照追加进 PowerContext Memory。"""
        assert self._memory is not None, "TaskStateStore 未打开"
        payload = json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True)
        text = (
            f"{STATE_MARKER} {record.get('task_id', 'TASK')} "
            f"status={record.get('status', 'unknown')}\n{payload}"
        )
        await self._memory.remember(
            RememberMemoryRequest(entries=(MemoryEntryInput(kind="task-state", text=text),))
        )

    # ------------------------------------------------------------------ 读
    async def search(self, query: str, *, limit: int = 5) -> list[dict]:
        assert self._memory is not None, "TaskStateStore 未打开"
        page = await self._memory.search(SearchMemoryRequest(query=query, mode="fts", limit=limit))
        hits: list[dict] = []
        for hit in page.hits:
            hits.append(
                {
                    "text": getattr(hit, "text", ""),
                    "score": float(getattr(hit, "score", 0.0) or 0.0),
                    "entry_id": getattr(hit, "entry_id", ""),
                }
            )
        return hits

    async def latest(self, task_id: str = "TASK-PAGINATION-001") -> dict | None:
        """回读最近一次写入的状态快照（重启后仍可用）。"""
        hits = await self.search(f"{STATE_MARKER} {task_id}", limit=5)
        for hit in hits:
            text = hit["text"]
            if STATE_MARKER not in text:
                continue
            start = text.find("{")
            if start < 0:
                continue
            try:
                return json.loads(text[start:])
            except json.JSONDecodeError:
                continue
        return None
