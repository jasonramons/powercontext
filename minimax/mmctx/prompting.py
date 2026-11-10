"""把上下文渲染成给 MiniMax 的开发提示词。"""

from __future__ import annotations

import json
from pathlib import Path

SYSTEM_PROMPT = """你是订单平台仓库里的代码修改助手。你会收到一项开发任务，以及从工程资料库
（seekdb）检索出来的规格、相关代码和测试。请严格遵守：

1. 只修改任务指向的实现文件，不要改动测试、规格或其它文件；
2. 保持公开函数名、参数顺序和返回类型不变；
3. 规格里每一条 SPEC 编号都必须被实现覆盖；
4. 只输出一个 JSON 对象，不要输出解释、Markdown 代码围栏之外的文字：
   {"summary": "...", "files": [{"path": "business/app/orderkit/pagination.py",
    "content": "<修改后的完整文件内容>"}]}
"""


def _section(title: str, rows: list[dict]) -> str:
    if not rows:
        return f"## {title}\n（本次检索没有命中）\n"
    blocks = []
    for row in rows:
        flag = " [必需]" if row.get("required") else ""
        blocks.append(
            f"--- {row['source']} · {row['symbol']}{flag} ---\n{row['text']}"
        )
    return f"## {title}\n" + "\n\n".join(blocks) + "\n"


def render_prompt(context: dict, current_files: dict[str, str]) -> list[dict]:
    parts = [f"## 任务\n{context['task']}\n"]
    parts.append(_section("本次任务适用的规格", context.get("specs", [])))
    parts.append(_section("需要修改的代码", context.get("code", [])))
    parts.append(_section("用于验证的测试", context.get("tests", [])))

    resume = context.get("resume") or {}
    if resume:
        parts.append(
            "## 已有任务进展（来自 PowerContext）\n"
            f"- 状态：{resume.get('status')}\n"
            f"- 已完成：{'；'.join(resume.get('completed') or []) or '无'}\n"
            f"- 待办：{'；'.join(resume.get('todo') or []) or '无'}\n"
        )

    for path, content in current_files.items():
        parts.append(f"## 当前文件内容：{path}\n```python\n{content}\n```\n")

    parts.append(
        "## 输出要求\n"
        "只返回 JSON：{\"summary\": \"...\", \"files\": [{\"path\": \"...\", \"content\": \"...\"}]}。"
        "content 必须是修改后的完整文件。\n"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(parts)},
    ]


def render_repair_prompt(context: dict, current_files: dict[str, str], failure_log: str) -> list[dict]:
    """第二轮：把测试失败输出回灌给模型。"""
    messages = render_prompt(context, current_files)
    messages.append(
        {
            "role": "user",
            "content": (
                "下面是你上一轮修改后运行目标测试的结果，请据此修正实现，仍然只输出 JSON。\n\n"
                f"```text\n{failure_log[-4000:]}\n```"
            ),
        }
    )
    return messages


def parse_model_output(text: str) -> dict:
    """从模型输出里取出 JSON（容忍 ```json 围栏与前后说明文字）。"""
    fenced = None
    if "```" in text:
        chunks = text.split("```")
        for chunk in chunks:
            candidate = chunk.strip()
            if candidate.startswith("json"):
                candidate = candidate[4:].strip()
            if candidate.startswith("{"):
                fenced = candidate
                break
    candidate = fenced or text
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型输出里没有 JSON 对象")
    return json.loads(candidate[start:end + 1])


def write_prompt_record(path: Path, messages: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = []
    for message in messages:
        body.append(f"### {message['role']}\n{message['content']}\n")
    path.write_text("\n".join(body), "utf-8")
