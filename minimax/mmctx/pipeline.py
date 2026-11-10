"""命令实现：初始化、上下文、规格重导入、生成、测试、状态与演示流程。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import apply as apply_mod
from .context import build_context, check_required, context_sources
from .materials import chunks_for_spec_file, collect_chunks
from .minimax_client import (
    Generation,
    MiniMaxClient,
    append_session_record,
    load_generation,
    save_generation,
)
from .prompting import parse_model_output, render_prompt, write_prompt_record
from .seekdb_store import SeekDBStore
from .state import TaskStateStore

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SEEKDB_DIR = DATA_DIR / "seekdb"
PC_DB = DATA_DIR / "powercontext.db"
RECORDS = ROOT / "records"
GEN_DIR = RECORDS / "generations"
SNAPSHOT_DIR = RECORDS / "snapshots"
TASK_FILE = ROOT / "samples" / "task.json"
IMPL = "business/app/orderkit/pagination.py"
TARGET_TESTS = "business/tests/test_pagination_target.py"
REGRESSION_TESTS = "business/tests/test_pagination_regression.py"
SPEC_V2 = ROOT / "materials" / "updates" / "pagination.spec.v2.md"
SNAPSHOT_BEFORE = SNAPSHOT_DIR / "pagination.before.py"
SNAPSHOT_AFTER = SNAPSHOT_DIR / "pagination.after.py"
RECORDED_GENERATION = GEN_DIR / "gen-001.json"


class Reporter:
    """同时写终端和 records/ 下的运行日志。"""

    def __init__(self, log_path: Path | None = None) -> None:
        self.lines: list[str] = []
        self.log_path = log_path

    def __call__(self, message: str = "") -> None:
        print(message, flush=True)
        self.lines.append(message)

    def flush(self) -> None:
        if self.log_path is None:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        header = [
            "# MiniMax × OceanBase · SDD 上下文模块运行日志",
            f"# 生成时间：{datetime.now(timezone.utc).isoformat(timespec='seconds')}",
            f"# Python：{sys.version.split()[0]} · 平台：{sys.platform}",
            "",
        ]
        self.log_path.write_text("\n".join(header + self.lines) + "\n", "utf-8")


def load_task() -> dict:
    return json.loads(TASK_FILE.read_text("utf-8"))


def open_store() -> SeekDBStore:
    return SeekDBStore(SEEKDB_DIR, RECORDS / "db-queries.log")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- 初始化
async def ingest_all(store: SeekDBStore, report=print) -> dict:
    chunks = collect_chunks(ROOT)
    by_doc: dict[str, list] = {}
    for chunk in chunks:
        by_doc.setdefault(chunk.doc_key, []).append(chunk)
    inserted = 0
    for doc_key, doc_chunks in sorted(by_doc.items()):
        count = store.replace_document(doc_key, doc_chunks)
        inserted += count
        report(f"  · 导入 {doc_key}: {count} 个片段（{doc_chunks[0].kind}）")
    store.replace_document("PAGINATION-SPEC", by_doc.get("PAGINATION-SPEC", []))
    stats = store.stats()
    return {"documents": len(by_doc), "chunks_written": inserted, "stats": stats}


async def cmd_init(_args) -> int:
    store = await open_store().open()
    try:
        print("初始化 seekdb 并导入工程资料…")
        result = await ingest_all(store)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        store.close()


# --------------------------------------------------------------------------- 上下文
async def _build(store: SeekDBStore, task: str, resume_state: dict | None = None) -> dict:
    spec = load_task()
    return build_context(
        store,
        task,
        required_sources=spec.get("required_sources", []),
        resume_state=resume_state,
    )


async def ensure_initialized(store: SeekDBStore, report=print) -> bool:
    """资料表为空时自动导入，保证任何入口单独运行都能拿到上下文。"""
    stats = store.stats()
    if stats["chunks_total"] > 0:
        return False
    report("资料表为空，自动执行一次初始化导入…")
    await ingest_all(store, report=report)
    return True


def print_context(context: dict, report=print) -> None:
    ok, missing = check_required(context)
    report(f"任务：{context['task']}")
    report(f"检索：{context['retrieval']['engine']} · 候选 {context['retrieval']['candidates']} 条")
    for kind, title in (("specs", "规格"), ("code", "代码"), ("tests", "测试")):
        report(f"\n[{title}]")
        for row in context[kind]:
            flag = " ★必需" if row["required"] else ""
            report(f"  - {row['symbol']} @ {row['source']}{flag} (score={row['score']})")
    report("\n[必需来源核对]")
    for check in context["required_check"]:
        mark = "OK " if check["present"] else "缺失"
        report(f"  - [{mark}] {check['kind']}:{check['symbol'] or check['path']}")
    if context.get("resume"):
        resume = context["resume"]
        report(f"\n[PowerContext 任务状态] status={resume.get('status')}")
        report(f"  已完成：{'；'.join(resume.get('completed') or []) or '无'}")
        report(f"  待办：{'；'.join(resume.get('todo') or []) or '无'}")
    report(f"\n必需来源：{'全部命中' if ok else '缺失 ' + ', '.join(missing)}")


async def cmd_context(args) -> int:
    task = args.task or load_task()["task"]
    store = await open_store().open()
    try:
        await ensure_initialized(store)
        async with TaskStateStore(PC_DB) as state:
            resume = await state.latest(load_task()["task_id"])
        context = await _build(store, task, resume_state=resume)
        if args.json:
            print(json.dumps(context, ensure_ascii=False, indent=2))
        else:
            print_context(context)
            print(f"\n来源清单：{len(context_sources(context))} 条")
        return 0
    finally:
        store.close()


async def cmd_reimport(args) -> int:
    path = Path(args.spec)
    if not path.is_absolute():
        path = ROOT / path
    store = await open_store().open()
    try:
        chunks = chunks_for_spec_file(ROOT, path)
        if not chunks:
            print(f"规格文件没有可导入的小节：{path}")
            return 1
        doc_key = chunks[0].doc_key
        store.replace_document(doc_key, chunks)
        print(f"重新导入 {path.relative_to(ROOT)} → doc_key={doc_key}")
        for chunk in chunks:
            print(f"  · {chunk.symbol} ({chunk.start_line}-{chunk.end_line})")
        print(f"旧版本片段已被替换，共写入 {len(chunks)} 条。")
        return 0
    finally:
        store.close()


# --------------------------------------------------------------------------- 测试
def parse_pytest(output: str) -> dict:
    passed = re.search(r"(\d+) passed", output)
    failed = re.search(r"(\d+) failed", output)
    errors = re.search(r"(\d+) error", output)
    return {
        "passed": int(passed.group(1)) if passed else 0,
        "failed": int(failed.group(1)) if failed else 0,
        "errors": int(errors.group(1)) if errors else 0,
    }


def run_pytest(targets: list[str], log_name: str | None = None) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "business" / "app")
    env.pop("PYTEST_ADDOPTS", None)
    command = [sys.executable, "-m", "pytest", *targets, "-q", "--no-header", "-p", "no:cacheprovider"]
    started = datetime.now(timezone.utc)
    process = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
    output = (process.stdout or "") + (process.stderr or "")
    counts = parse_pytest(output)
    result = {
        "command": " ".join(["python", "-m", "pytest", *targets]),
        "exit_code": process.returncode,
        "passed": counts["passed"],
        "failed": counts["failed"],
        "errors": counts["errors"],
        "started_at": started.isoformat(timespec="seconds"),
        "output": output,
    }
    if log_name:
        path = RECORDS / log_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "\n".join(
                [
                    f"$ {result['command']}",
                    f"# exit_code={result['exit_code']} passed={result['passed']} "
                    f"failed={result['failed']} errors={result['errors']}",
                    "",
                    output,
                ]
            ),
            "utf-8",
        )
        result["log"] = str(path.relative_to(ROOT))
    return result


async def cmd_test(args) -> int:
    targets = []
    if args.which in ("target", "all"):
        targets.append(TARGET_TESTS)
    if args.which in ("regression", "all"):
        targets.append(REGRESSION_TESTS)
    result = run_pytest(targets, log_name=f"test-{args.which}.log")
    print(f"$ {result['command']}")
    print(f"exit_code={result['exit_code']} passed={result['passed']} failed={result['failed']}")
    print(result["output"][-2000:])
    return 0 if result["exit_code"] == 0 else 1


# --------------------------------------------------------------------------- 生成
def _current_files(paths: list[str]) -> dict[str, str]:
    return {path: (ROOT / path).read_text("utf-8") for path in paths}


async def _generate(
    context: dict,
    *,
    live: bool,
    round_number: int,
    generation_id: str,
    report=print,
    failure_log: str | None = None,
) -> Generation:
    files = _current_files([IMPL])
    messages = render_prompt(context, files)
    if failure_log:
        messages.append(
            {
                "role": "user",
                "content": "上一轮的目标测试失败输出如下，请据此修正，仍然只输出 JSON：\n\n"
                f"```text\n{failure_log[-4000:]}\n```",
            }
        )
    write_prompt_record(RECORDS / "prompts" / f"{generation_id}.md", messages)

    if live:
        client = MiniMaxClient()
        response = client.chat(messages)
        generation = Generation(
            generation_id=generation_id,
            created_at=_now(),
            model=response["model"],
            mode="live",
            messages=messages,
            response=response["text"],
            usage=response.get("usage", {}),
            latency_ms=response.get("latency_ms", 0),
            round=round_number,
        )
        save_generation(GEN_DIR / f"{generation_id}.json", generation)
        append_session_record(RECORDS / "minimax-session.jsonl", generation, {"request_id": response.get("request_id", "")})
        report(f"  · MiniMax 实时调用完成：{generation.latency_ms} ms，prompt_sha256={generation.prompt_sha256[:16]}")
    else:
        path = RECORDS / "generations" / f"{generation_id}.json"
        if not path.exists():
            raise FileNotFoundError(f"没有回放记录 {path}，请用 --live 先跑一次真实生成")
        generation = load_generation(path)
        append_session_record(RECORDS / "minimax-session.jsonl", generation, {"replayed": True})
        report(f"  · 回放 MiniMax 记录 {path.name}（原模型 {generation.model}，{generation.latency_ms} ms）")
    return generation


async def cmd_generate(args) -> int:
    task = args.task or load_task()["task"]
    store = await open_store().open()
    try:
        await ensure_initialized(store)
        async with TaskStateStore(PC_DB) as state:
            resume = await state.latest(load_task()["task_id"])
        context = await _build(store, task, resume_state=resume)
        generation = await _generate(
            context,
            live=args.live,
            round_number=1,
            generation_id=args.generation_id,
        )
        print(f"已保存 {RECORDS / 'generations' / (args.generation_id + '.json')}")
        print(generation.response[:800])
        return 0
    finally:
        store.close()


async def cmd_apply(args) -> int:
    record_path = Path(args.generation)
    if not record_path.is_absolute():
        record_path = ROOT / record_path
    generation = load_generation(record_path)
    payload = parse_model_output(generation.response)
    if not SNAPSHOT_BEFORE.exists():
        apply_mod.save_snapshot(SNAPSHOT_BEFORE, (ROOT / IMPL).read_text("utf-8"))
    written = apply_mod.apply_files(ROOT, payload["files"])
    before = (SNAPSHOT_BEFORE).read_text("utf-8")
    after = (ROOT / IMPL).read_text("utf-8")
    apply_mod.save_snapshot(SNAPSHOT_AFTER, after)
    diff = apply_mod.write_diff_record(
        RECORDS / "pagination.diff", before, after, IMPL, generation.to_dict()
    )
    print(f"应用 {len(written)} 个文件：{', '.join(written)}")
    print(f"差异 {len(diff.splitlines())} 行 → records/pagination.diff")
    print(payload.get("summary", ""))
    return 0


# --------------------------------------------------------------------------- 状态
async def cmd_state(args) -> int:
    task_id = load_task()["task_id"]
    async with TaskStateStore(PC_DB) as state:
        latest = await state.latest(task_id)
        history = await state.search(f"TASK-STATE-PAYLOAD {task_id}", limit=10)
        scope_id = state.scope_id
    RECORDS.mkdir(parents=True, exist_ok=True)
    with (RECORDS / "state-reuse.log").open("a", encoding="utf-8") as handle:
        handle.write(
            f"[{_now()}] 读取 PowerContext scope={scope_id} 状态条数={len(history)} "
            f"status={(latest or {}).get('status')} 已完成={len((latest or {}).get('completed', []))}\n"
        )
    if args.json:
        print(json.dumps({"scope_id": scope_id, "latest": latest}, ensure_ascii=False, indent=2))
        return 0 if latest else 1
    if latest is None:
        print("PowerContext 里还没有这个任务的状态（空状态）。")
        return 1
    print(f"PowerContext scope: {scope_id}")
    print(f"状态条数: {len(history)}")
    print(json.dumps(latest, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------- 演示
async def cmd_demo(args) -> int:
    report = Reporter(RECORDS / "demo-run.log")
    task_spec = load_task()
    task = task_spec["task"]
    demo_generation = args.generation or "gen-001"

    report("=" * 78)
    report("MiniMax × OceanBase · SDD 上下文模块演示")
    report("=" * 78)

    # 0) 环境
    report("\n[0/6] 运行环境")
    report(f"  · Python {sys.version.split()[0]} · 平台 {sys.platform}")
    import powercontext  # noqa: F401

    report(f"  · PowerContext {getattr(powercontext, '__version__', 'unknown')}（{Path(powercontext.__file__).parent}）")
    import pylibseekdb

    report(f"  · pylibseekdb {getattr(pylibseekdb, '__version__', 'unknown')}")

    # 1) 干净状态 + 初始化
    if not args.keep_data:
        shutil.rmtree(DATA_DIR, ignore_errors=True)
        report("\n[1/6] 清空 data/（空状态开始），初始化 seekdb 并导入资料")
    else:
        report("\n[1/6] 复用已有 data/，重新导入资料")
    if not SNAPSHOT_BEFORE.exists():
        apply_mod.save_snapshot(SNAPSHOT_BEFORE, (ROOT / IMPL).read_text("utf-8"))
        report(f"  · 记录修改前代码快照 → {SNAPSHOT_BEFORE.relative_to(ROOT)}")
    else:
        apply_mod.save_snapshot(ROOT / IMPL, SNAPSHOT_BEFORE.read_text("utf-8"))
        report(f"  · 已恢复基线实现（{SNAPSHOT_BEFORE.relative_to(ROOT)}）")
    store = await open_store().open()
    try:
        ingest = await ingest_all(store, report=report)
        report(f"  · seekdb 统计：{json.dumps(ingest['stats']['chunks_by_kind'], ensure_ascii=False)}")

        # 2) 上下文
        report("\n[2/6] 构建开发上下文（规格 v1）")
        context = await _build(store, task)
        print_context(context, report=report)
        ok, missing = check_required(context)
        if not ok:
            report(f"!! 必需来源缺失：{missing}")
            report.flush()
            return 2

        # 3) MiniMax 生成 + 应用 + 测试
        report("\n[3/6] 交给 MiniMax 生成修改，并运行目标测试")
        generation = await _generate(
            context,
            live=args.live,
            round_number=1,
            generation_id=demo_generation,
            report=report,
        )
        payload = parse_model_output(generation.response)
        apply_mod.save_snapshot(SNAPSHOT_AFTER, payload["files"][0]["content"])
        written = apply_mod.apply_files(ROOT, payload["files"])
        report(f"  · 应用文件：{', '.join(written)}")
        before = SNAPSHOT_BEFORE.read_text("utf-8")
        after = (ROOT / IMPL).read_text("utf-8")
        diff = apply_mod.write_diff_record(
            RECORDS / "pagination.diff", before, after, IMPL, generation.to_dict()
        )
        report(f"  · 代码差异 {len(diff.splitlines())} 行 → records/pagination.diff")
        target = run_pytest([TARGET_TESTS], log_name="test-after-target.log")
        report(f"  · 目标测试：exit={target['exit_code']} passed={target['passed']} failed={target['failed']}")
        regression = run_pytest([REGRESSION_TESTS], log_name="test-after-regression.log")
        report(f"  · 回归测试：exit={regression['exit_code']} passed={regression['passed']} failed={regression['failed']}")
        if target["exit_code"] != 0 or regression["exit_code"] != 0:
            report(target["output"][-3000:])
            report.flush()
            return 3

        # 4) 规格变更 → 重新导入
        report("\n[4/6] 规格变更（v1 → v2）后重新导入，上下文必须跟着变")
        old_spec = next((row for row in context["specs"] if row["symbol"] == "SPEC-PAGE-002"), None)
        report(f"  · 变更前 SPEC-PAGE-002：{_first_line(old_spec)}")
        await ingest_all(store, report=lambda line: None)  # 代码已修改，重新索引代码片段
        chunks = chunks_for_spec_file(ROOT, SPEC_V2)
        store.replace_document(chunks[0].doc_key, chunks)
        report(f"  · 重新导入 {SPEC_V2.relative_to(ROOT)}（{len(chunks)} 条，doc_key={chunks[0].doc_key}）")
        context_v2 = await _build(store, task)
        new_spec = next((row for row in context_v2["specs"] if row["symbol"] == "SPEC-PAGE-002"), None)
        report(f"  · 变更后 SPEC-PAGE-002：{_first_line(new_spec)}")
        report(f"  · 来源：{new_spec['source'] if new_spec else '未命中'}")
        changed = bool(old_spec and new_spec and old_spec["text"] != new_spec["text"])
        report(f"  · 上下文是否使用新规格：{'是' if changed else '否'}")
        if not changed:
            report.flush()
            return 4

        # 5) 保存状态到 PowerContext
        report("\n[5/6] 把任务状态写入 PowerContext")
        record = {
            "task_id": task_spec["task_id"],
            "task": task,
            "status": "done",
            "completed": ["ingest", "context", "minimax-generation", "apply", "tests"],
            "todo": [],
            "context_sources": context_sources(context),
            "spec_version": 2,
            "verification": {
                "target": {"passed": target["passed"], "failed": target["failed"]},
                "regression": {"passed": regression["passed"], "failed": regression["failed"]},
            },
            "generation": {
                "id": generation.generation_id,
                "model": generation.model,
                "prompt_sha256": generation.prompt_sha256,
            },
            "updated_at": _now(),
        }
        async with TaskStateStore(PC_DB) as state:
            await state.save(record)
            scope_id = state.scope_id
        report(f"  · 已写入 scope {scope_id}（PowerContext Memory）")

        # 6) 重启模块 → 读回状态 → 用于后续上下文
        report("\n[6/6] 重启模块（新进程）后读回状态，并用于后续上下文")
        resumed = _restart_and_read()
        report(f"  · 子进程读回 status={resumed.get('status')}，已完成 {len(resumed.get('completed', []))} 项")
        resume_context = await _build(store, task, resume_state=resumed)
        report(f"  · 新上下文里的 resume.completed：{'；'.join(resume_context['resume']['completed'])}")
        rendered = render_prompt(resume_context, _current_files([IMPL]))[1]["content"]
        report(f"  · 该状态已进入提示词：{'是' if '已完成' in rendered else '否'}")
        report("\n全部六项必做行为演示完成。")
        report("  · 目标测试日志：records/test-after-target.log")
        report("  · 回归测试日志：records/test-after-regression.log")
        report("  · 数据库查询日志：records/db-queries.log")
        report("  · MiniMax 调用记录：records/minimax-session.jsonl")
        report("  · 前后快照与 diff：records/snapshots/、records/pagination.diff")
        report.flush()
        return 0
    finally:
        store.close()


def _first_line(row: dict | None) -> str:
    if not row:
        return "（未命中）"
    for line in row["text"].splitlines():
        if line.strip() and not line.startswith("#"):
            return line.strip()[:120]
    return row["text"][:120]


def _restart_and_read() -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT)
    process = subprocess.run(
        [sys.executable, "-m", "mmctx.cli", "state", "--json"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        raise RuntimeError(f"重启后读取状态失败：{process.stderr[:500]}")
    payload = json.loads(process.stdout)
    return payload.get("latest") or {}


# --------------------------------------------------------------------------- 验证
async def cmd_verify(args) -> int:
    report = Reporter(RECORDS / "verify-run.log")
    before_snapshot = SNAPSHOT_BEFORE.read_text("utf-8")
    after_snapshot = SNAPSHOT_AFTER.read_text("utf-8")

    report("[1/5] 恢复修改前代码快照")
    apply_mod.save_snapshot(ROOT / IMPL, before_snapshot)
    report(f"  · {IMPL} 已恢复为基线（{len(before_snapshot.splitlines())} 行）")

    report("\n[2/5] 修改前运行目标测试（应失败）")
    before = run_pytest([TARGET_TESTS], log_name="test-before-target.log")
    report(f"  · exit={before['exit_code']} passed={before['passed']} failed={before['failed']}")
    report("  · " + (before["output"].strip().splitlines()[-1] if before["output"].strip() else "无输出"))

    report("\n[3/5] 应用修改后代码并运行同一组目标测试（应通过）")
    apply_mod.save_snapshot(ROOT / IMPL, after_snapshot)
    target = run_pytest([TARGET_TESTS], log_name="test-after-target.log")
    report(f"  · exit={target['exit_code']} passed={target['passed']} failed={target['failed']}")

    report("\n[4/5] 运行回归测试")
    regression = run_pytest([REGRESSION_TESTS], log_name="test-after-regression.log")
    report(f"  · exit={regression['exit_code']} passed={regression['passed']} failed={regression['failed']}")

    if not args.keep:
        apply_mod.save_snapshot(ROOT / IMPL, before_snapshot)
        report("\n[5/5] 已恢复基线代码（加 --keep 可保留修改后状态）")
    else:
        report("\n[5/5] 保留修改后代码")

    ok = before["exit_code"] != 0 and target["exit_code"] == 0 and regression["exit_code"] == 0
    summary = {
        "ok": ok,
        "before": {key: before[key] for key in ("exit_code", "passed", "failed")},
        "after_target": {key: target[key] for key in ("exit_code", "passed", "failed")},
        "after_regression": {key: regression[key] for key in ("exit_code", "passed", "failed")},
        "generated_at": _now(),
    }
    (RECORDS / "verification.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", "utf-8"
    )
    report("\n结论：" + ("修改前失败 / 修改后通过 / 回归通过 ✔" if ok else "存在不满足的项目 ✘"))
    report.flush()
    return 0 if ok else 1


# --------------------------------------------------------------------------- 其它
async def cmd_reset(_args) -> int:
    if SNAPSHOT_BEFORE.exists():
        apply_mod.save_snapshot(ROOT / IMPL, SNAPSHOT_BEFORE.read_text("utf-8"))
        print(f"已恢复基线实现：{IMPL}")
    shutil.rmtree(DATA_DIR, ignore_errors=True)
    print("已删除 data/（seekdb 与 PowerContext 状态），下次运行会重新初始化。")
    return 0


async def cmd_db(args) -> int:
    store = await open_store().open()
    try:
        if args.sql:
            rows = store.raw_sql(args.sql)
            print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
        else:
            print(json.dumps(store.stats(), ensure_ascii=False, indent=2))
        return 0
    finally:
        store.close()
