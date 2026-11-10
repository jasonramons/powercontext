"""把工程资料切成语料片段：规格、代码、测试。

片段是检索的最小单位，也是上下文里引用的来源：每个片段都带 ``path`` 与
``start_line``/``end_line``，评审可以直接回到原文核对。
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

SPEC_ROOT = Path("materials") / "specs"
UPDATE_ROOT = Path("materials") / "updates"
CODE_ROOT = Path("business") / "app"
TEST_ROOT = Path("business") / "tests"

_FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
_SPEC_ID_IN_HEADING = re.compile(r"(SPEC-[A-Z]+-\d{3})")


@dataclass(slots=True)
class Chunk:
    chunk_id: str
    doc_key: str
    kind: str
    path: str
    symbol: str
    start_line: int
    end_line: int
    text: str
    tags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def source(self) -> str:
        return f"{self.path}:{self.start_line}-{self.end_line}"


def _digest(*parts: object) -> str:
    joined = "\x1f".join(str(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def _spec_meta(text: str) -> dict[str, str]:
    match = _FRONT_MATTER.match(text)
    if not match:
        return {}
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta


def chunk_spec(path: Path, text: str) -> list[Chunk]:
    """按 ``##`` 小节切分规格；同一 ``spec-id`` 的文档互相替换。"""
    meta = _spec_meta(text)
    spec_id = meta.get("spec-id") or path.stem
    version = meta.get("version", "1")
    lines = text.splitlines()

    starts = [index for index, line in enumerate(lines) if line.startswith("## ")]
    chunks: list[Chunk] = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        body = "\n".join(lines[start:end]).strip()
        if not body:
            continue
        heading = lines[start][3:].strip()
        match = _SPEC_ID_IN_HEADING.search(heading)
        symbol = match.group(1) if match else heading
        chunks.append(
            Chunk(
                chunk_id=_digest(spec_id, version, path.as_posix(), start + 1, body),
                doc_key=spec_id,
                kind="spec",
                path=path.as_posix(),
                symbol=symbol,
                start_line=start + 1,
                end_line=end,
                text=body,
                tags=("spec", f"v{version}"),
            )
        )
    if not chunks and text.strip():
        chunks.append(
            Chunk(
                chunk_id=_digest(spec_id, version, path.as_posix(), 1, text),
                doc_key=spec_id,
                kind="spec",
                path=path.as_posix(),
                symbol=spec_id,
                start_line=1,
                end_line=len(lines),
                text=text.strip(),
                tags=("spec", f"v{version}"),
            )
        )
    return chunks


def _symbol_chunks(path: Path, text: str, kind: str, doc_key: str) -> list[Chunk]:
    lines = text.splitlines()
    try:
        tree = ast.parse(text)
    except SyntaxError:
        tree = None

    spans: list[tuple[str, int, int]] = []
    if tree is not None:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = min([node.lineno] + [item.lineno for item in node.decorator_list])
                spans.append((node.name, start, node.end_lineno or node.lineno))
    if not spans:
        spans = [("module", 1, len(lines))]

    chunks: list[Chunk] = []
    for symbol, start, end in spans:
        body = "\n".join(lines[start - 1:end]).strip()
        if not body:
            continue
        chunks.append(
            Chunk(
                chunk_id=_digest(doc_key, path.as_posix(), start, end, body),
                doc_key=doc_key,
                kind=kind,
                path=path.as_posix(),
                symbol=symbol,
                start_line=start,
                end_line=end,
                text=body,
                tags=(kind,),
            )
        )
    return chunks


def collect_chunks(root: Path, *, include_updates: bool = False) -> list[Chunk]:
    """扫描材料目录。``updates/`` 里的规格默认不导入，由 reimport 单独载入。"""
    chunks: list[Chunk] = []
    spec_dirs = [SPEC_ROOT] + ([UPDATE_ROOT] if include_updates else [])
    for directory in spec_dirs:
        for path in sorted((root / directory).glob("*.md")):
            chunks.extend(chunk_spec(path.relative_to(root), path.read_text("utf-8")))

    for directory, kind in ((CODE_ROOT, "code"), (TEST_ROOT, "test")):
        for path in sorted((root / directory).rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            relative = path.relative_to(root)
            chunks.extend(
                _symbol_chunks(relative, path.read_text("utf-8"), kind, relative.as_posix())
            )
    return chunks


def chunks_for_spec_file(root: Path, path: Path) -> list[Chunk]:
    relative = path.relative_to(root) if path.is_absolute() else path
    return chunk_spec(relative, (root / relative).read_text("utf-8"))
