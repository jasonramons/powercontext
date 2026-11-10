"""MiniMax 接入层：真实调用 + 可回放记录。

评审环境没有 API Key，所以模块把「开发时真实发生的模型调用」完整记录下来，
``demo`` 默认回放这份记录；设置 ``MINIMAX_API_KEY`` 时走真实调用。
两条路径写进同一份 ``records/minimax-session.jsonl``，字段一致。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "MiniMax-M3.1-Flash"
DEFAULT_BASE_URL = "https://api.minimaxi.com/v1"
_KEY_FILE = Path("minimax-key.txt")


def _strip_thinking(text: str) -> str:
    return re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", text, flags=re.S | re.I).strip()


@dataclass(slots=True)
class Generation:
    generation_id: str
    created_at: str
    model: str
    mode: str
    messages: list[dict]
    response: str
    usage: dict = field(default_factory=dict)
    latency_ms: int = 0
    round: int = 1

    @property
    def prompt_sha256(self) -> str:
        joined = "\n\n".join(message.get("content", "") for message in self.messages)
        return hashlib.sha256(joined.encode("utf-8")).hexdigest()

    def to_dict(self) -> dict:
        return {
            "generation_id": self.generation_id,
            "created_at": self.created_at,
            "model": self.model,
            "mode": self.mode,
            "round": self.round,
            "prompt_sha256": self.prompt_sha256,
            "messages": self.messages,
            "response": self.response,
            "usage": self.usage,
            "latency_ms": self.latency_ms,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Generation":
        return cls(
            generation_id=data["generation_id"],
            created_at=data["created_at"],
            model=data["model"],
            mode=data.get("mode", "replay"),
            messages=data["messages"],
            response=data["response"],
            usage=data.get("usage", {}),
            latency_ms=int(data.get("latency_ms", 0)),
            round=int(data.get("round", 1)),
        )


class MiniMaxClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: int = 180,
    ) -> None:
        self.api_key = api_key or os.environ.get("MINIMAX_API_KEY", "").strip() or self._key_from_file()
        self.base_url = (base_url or os.environ.get("MINIMAX_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.model = model or os.environ.get("MINIMAX_MODEL") or DEFAULT_MODEL
        self.timeout = timeout

    @staticmethod
    def _key_from_file() -> str:
        # 仅用于本地开发；仓库不提交任何密钥。
        if _KEY_FILE.exists():
            return _KEY_FILE.read_text("utf-8").strip()
        return ""

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def chat(self, messages: list[dict], *, temperature: float = 0.2, max_tokens: int = 16000) -> dict:
        if not self.api_key:
            raise RuntimeError(
                "没有配置 MiniMax API Key。设置 MINIMAX_API_KEY 后重试，"
                "或使用 --replay 回放 records/generations 里的真实调用记录。"
            )
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:  # pragma: no cover - 网络错误路径
            detail = error.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"MiniMax HTTP {error.code}: {detail}") from error
        latency_ms = int((time.perf_counter() - started) * 1000)
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        text = _strip_thinking(message.get("content") or "")
        if not text:
            text = _strip_thinking(message.get("reasoning_content") or "")
        return {
            "text": text,
            "model": payload.get("model", self.model),
            "usage": payload.get("usage", {}),
            "latency_ms": latency_ms,
            "request_id": payload.get("id", ""),
        }


def append_session_record(path: Path, generation: Generation, extra: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = generation.to_dict()
    if extra:
        entry.update(extra)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def save_generation(path: Path, generation: Generation) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(generation.to_dict(), ensure_ascii=False, indent=2) + "\n", "utf-8")


def load_generation(path: Path) -> Generation:
    return Generation.from_dict(json.loads(Path(path).read_text("utf-8")))
