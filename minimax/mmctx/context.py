"""上下文选择：从 seekdb 的检索结果里挑出本次任务真正需要的规格、代码和测试。

选择规则
--------
1. seekdb 按向量距离 + 关键词命中返回候选片段；
2. 按 ``spec`` / ``code`` / ``test`` 分组，每组最多 4 条，避免上下文被单一文件淹没；
3. 验证样例声明了「必须出现的来源」，缺哪条就按符号精确回查补上，并在输出里
   标记 ``required=true``，让评审能逐条核对；
4. 如果 PowerContext 里有这个任务的历史状态，一并带上「已完成 / 待办」。
"""

from __future__ import annotations

from datetime import datetime, timezone

MAX_PER_KIND = 4


def _entry(hit, *, required: bool = False) -> dict:
    return {
        "symbol": hit.symbol,
        "source": hit.source,
        "path": hit.path,
        "lines": [hit.start_line, hit.end_line],
        "score": round(float(hit.score), 4),
        "distance": round(float(hit.distance), 4),
        "matched": list(hit.matched),
        "required": required,
        "text": hit.text,
    }


def _select(store, task: str, *, limit: int) -> dict[str, list]:
    hits = store.search(task, limit=limit)
    grouped: dict[str, list] = {"spec": [], "code": [], "test": []}
    seen: set[str] = set()
    for hit in hits:
        bucket = grouped.get(hit.kind)
        if bucket is None or len(bucket) >= MAX_PER_KIND:
            continue
        if hit.chunk_id in seen:
            continue
        seen.add(hit.chunk_id)
        bucket.append(hit)
    return grouped


def _present(grouped: dict[str, list], requirement: dict) -> bool:
    kind = requirement["kind"]
    for hit in grouped.get(kind, []):
        if requirement.get("symbol") and hit.symbol != requirement["symbol"]:
            continue
        if requirement.get("path") and hit.path != requirement["path"]:
            continue
        return True
    return False


def _pin(store, requirement: dict):
    """按符号/路径精确回查一条来源。"""
    return store.find(
        kind=requirement["kind"],
        symbol=requirement.get("symbol"),
        path=requirement.get("path"),
    )


def build_context(
    store,
    task: str,
    *,
    required_sources: list[dict] | None = None,
    resume_state: dict | None = None,
    limit: int = 24,
) -> dict:
    grouped = _select(store, task, limit=limit)

    required_sources = required_sources or []
    checks: list[dict] = []
    for requirement in required_sources:
        if not _present(grouped, requirement):
            pinned = _pin(store, requirement)
            if pinned is not None:
                grouped.setdefault(requirement["kind"], []).append(pinned)
        checks.append(
            {
                "kind": requirement["kind"],
                "symbol": requirement.get("symbol", ""),
                "path": requirement.get("path", ""),
                "present": _present(grouped, requirement),
            }
        )

    def render(kind: str) -> list[dict]:
        rows = []
        for hit in grouped.get(kind, []):
            required = any(
                check["present"] and check["kind"] == kind
                and (not check["symbol"] or check["symbol"] == hit.symbol)
                and (not check["path"] or check["path"] == hit.path)
                for check in checks
            )
            rows.append(_entry(hit, required=required))
        rows.sort(key=lambda row: (not row["required"], -row["score"]))
        return rows

    context = {
        "task": task,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "retrieval": {
            "engine": f"seekdb({store.vector_mode} search + keyword)",
            "table": "mm_material_chunks",
            "candidates": sum(len(grouped.get(kind, [])) for kind in grouped),
        },
        "specs": render("spec"),
        "code": render("code"),
        "tests": render("test"),
        "required_check": checks,
    }
    if resume_state:
        context["resume"] = {
            "task_id": resume_state.get("task_id"),
            "status": resume_state.get("status"),
            "completed": resume_state.get("completed", []),
            "todo": resume_state.get("todo", []),
            "verification": resume_state.get("verification", {}),
            "updated_at": resume_state.get("updated_at"),
        }
    return context


def context_sources(context: dict) -> list[str]:
    sources = []
    for kind in ("specs", "code", "tests"):
        for row in context.get(kind, []):
            sources.append(f"{row['symbol']} @ {row['source']}")
    return sources


def check_required(context: dict) -> tuple[bool, list[str]]:
    missing = [
        f"{check['kind']}:{check['symbol'] or check['path']}"
        for check in context.get("required_check", [])
        if not check["present"]
    ]
    return (not missing, missing)
