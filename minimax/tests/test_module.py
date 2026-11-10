"""上下文模块自身的单元测试（不依赖 seekdb / PowerContext，可在任何平台运行）。"""

import json
from pathlib import Path

import pytest

from mmctx.embed import DIM, cosine, embed
from mmctx.materials import collect_chunks, chunk_spec
from mmctx.context import build_context
from mmctx.prompting import parse_model_output, render_prompt
from mmctx.seekdb_store import Hit

ROOT = Path(__file__).resolve().parents[1]


def test_embedding_is_deterministic_and_normalised():
    vector = embed("分页 page_size 越界")
    assert len(vector) == DIM
    assert vector == embed("分页 page_size 越界")
    assert abs(sum(value * value for value in vector) - 1.0) < 1e-9
    assert cosine(vector, embed("page_size 越界 分页")) > cosine(vector, embed("天气 音乐 电影"))


def test_collect_chunks_covers_specs_code_and_tests():
    chunks = collect_chunks(ROOT)
    kinds = {chunk.kind for chunk in chunks}
    assert kinds == {"spec", "code", "test"}
    symbols = {chunk.symbol for chunk in chunks}
    assert {"SPEC-PAGE-002", "paginate", "page_count"} <= symbols
    assert any(symbol.startswith("test_") for symbol in symbols)


def test_spec_version_changes_symbol_set():
    v1 = (ROOT / "materials" / "specs" / "pagination.spec.md").read_text("utf-8")
    v2 = (ROOT / "materials" / "updates" / "pagination.spec.v2.md").read_text("utf-8")
    chunks_v1 = chunk_spec(Path("materials/specs/pagination.spec.md"), v1)
    chunks_v2 = chunk_spec(Path("materials/updates/pagination.spec.v2.md"), v2)
    assert chunks_v1[0].doc_key == chunks_v2[0].doc_key == "PAGINATION-SPEC"
    assert chunks_v2[0].tags == ("spec", "v2")
    assert "1..50" in v2.replace("到 50", "..50") or "50" in v2


class _FakeStore:
    """用收集到的片段模拟 seekdb 的检索结果。"""

    vector_mode = "vector"

    def __init__(self) -> None:
        self.chunks = collect_chunks(ROOT)
        self.vectors = {chunk.chunk_id: embed(chunk.text) for chunk in self.chunks}

    def search(self, query, *, kinds=("spec", "code", "test"), limit=24):
        query_vector = embed(query)
        hits = []
        for chunk in self.chunks:
            if chunk.kind not in kinds:
                continue
            distance = 1 - cosine(query_vector, self.vectors[chunk.chunk_id])
            hits.append(
                Hit(
                    chunk.chunk_id, chunk.doc_key, chunk.kind, chunk.path, chunk.symbol,
                    chunk.start_line, chunk.end_line, chunk.text, distance, 1 - distance,
                )
            )
        hits.sort(key=lambda hit: hit.score, reverse=True)
        return hits[:limit]

    def find(self, *, kind, symbol=None, path=None):
        for chunk in self.chunks:
            if chunk.kind != kind:
                continue
            if symbol and chunk.symbol != symbol:
                continue
            if path and chunk.path != path:
                continue
            return Hit(
                chunk.chunk_id, chunk.doc_key, chunk.kind, chunk.path, chunk.symbol,
                chunk.start_line, chunk.end_line, chunk.text, 0.0, 0.0,
            )
        return None


def test_context_contains_every_required_source():
    sample = json.loads((ROOT / "samples" / "task.json").read_text("utf-8"))
    context = build_context(_FakeStore(), sample["task"], required_sources=sample["required_sources"])
    assert all(check["present"] for check in context["required_check"])
    assert {row["symbol"] for row in context["specs"]} >= {"SPEC-PAGE-001", "SPEC-PAGE-002"}
    assert {row["symbol"] for row in context["code"]} >= {"paginate", "page_count"}


def test_context_carries_resume_state_from_powercontext():
    sample = json.loads((ROOT / "samples" / "task.json").read_text("utf-8"))
    resume = {
        "task_id": sample["task_id"],
        "status": "in-progress",
        "completed": ["context", "generation"],
        "todo": ["tests"],
    }
    context = build_context(
        _FakeStore(), sample["task"], required_sources=sample["required_sources"], resume_state=resume
    )
    assert context["resume"]["completed"] == ["context", "generation"]
    prompt = render_prompt(context, {})[1]["content"]
    assert "已有任务进展" in prompt
    assert "generation" in prompt


def test_parse_model_output_accepts_fenced_json():
    payload = parse_model_output(
        '这里是修改：\n```json\n{"summary": "ok", "files": []}\n```\n'
    )
    assert payload["summary"] == "ok"


def test_parse_model_output_rejects_garbage():
    with pytest.raises(ValueError):
        parse_model_output("没有 JSON")
