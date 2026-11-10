"""命令行入口：``python -m mmctx <子命令>``。"""

from __future__ import annotations

import argparse
import asyncio
import sys

from . import pipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m mmctx",
        description="SDD 工程上下文模块：规格/代码/测试检索 + MiniMax 代码修改 + PowerContext 状态",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="初始化 seekdb 并导入工程资料")
    sub.add_parser("reset", help="恢复基线代码并清空 data/")

    context = sub.add_parser("context", help="为一个开发任务构造上下文")
    context.add_argument("--task", default="")
    context.add_argument("--json", action="store_true")

    reimport = sub.add_parser("reimport", help="重新导入一份规格（同 spec-id 覆盖旧版本）")
    reimport.add_argument("--spec", default="materials/updates/pagination.spec.v2.md")

    generate = sub.add_parser("generate", help="调用/回放 MiniMax 生成代码修改")
    generate.add_argument("--live", action="store_true", help="真实调用 MiniMax（需要 MINIMAX_API_KEY）")
    generate.add_argument("--generation-id", default="gen-001")
    generate.add_argument("--task", default="")

    apply_cmd = sub.add_parser("apply", help="应用一次生成记录里的文件修改")
    apply_cmd.add_argument("--generation", default="records/generations/gen-001.json")

    test = sub.add_parser("test", help="运行目标测试或回归测试")
    test.add_argument("--which", choices=["target", "regression", "all"], default="all")

    state = sub.add_parser("state", help="读取 PowerContext 里保存的任务状态")
    state.add_argument("--json", action="store_true")

    demo = sub.add_parser("demo", help="一次跑完六项必做行为的演示")
    demo.add_argument("--live", action="store_true")
    demo.add_argument("--keep-data", action="store_true")
    demo.add_argument("--generation", default="gen-001")

    verify = sub.add_parser("verify", help="修改前后目标测试与回归测试的证据")
    verify.add_argument("--keep", action="store_true")

    db = sub.add_parser("db", help="查看 seekdb 统计，或直接执行一条 SQL")
    db.add_argument("--sql", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = {
        "init": pipeline.cmd_init,
        "reset": pipeline.cmd_reset,
        "context": pipeline.cmd_context,
        "reimport": pipeline.cmd_reimport,
        "generate": pipeline.cmd_generate,
        "apply": pipeline.cmd_apply,
        "test": pipeline.cmd_test,
        "state": pipeline.cmd_state,
        "demo": pipeline.cmd_demo,
        "verify": pipeline.cmd_verify,
        "db": pipeline.cmd_db,
    }[args.command]
    try:
        return asyncio.run(handler(args))
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001 - CLI 顶层把错误打印清楚
        print(f"[mmctx] {type(error).__name__}: {error}", file=sys.stderr)
        if args.command in {"demo", "verify"}:
            raise
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
