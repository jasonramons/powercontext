"""PowerContext bridge for 记忆旅馆 (port 8767).

Dify owns the narration; this sidecar owns the one thing an LLM cannot keep:
the player's durable history. Every action becomes a memory entry, and every
new scene asks the memory back for what this player already did.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from powercontext.builtin.artifacts.memory import MemoryEntryInput
from powercontext.builtin.persistence.sqlite import SQLiteConfig
from powercontext.builtin.runtime import (
    BuiltinConfig,
    RememberMemoryRequest,
    SearchMemoryRequest,
    open_builtin_runtime,
)
from powercontext.builtin.scope import ScopeDraft

HOST = os.environ.get("PC_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PC_BRIDGE_PORT", "8767"))
DB_PATH = os.environ.get("PC_DB", os.path.join(os.path.dirname(__file__), "..", "data", "powercontext.db"))
SCOPE_KEY = "memory-inn"

_loop = asyncio.new_event_loop()
_state: dict[str, object] = {}


def _run(coro):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout=30)


async def _boot() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{DB_PATH}"))
    runtime_cm = open_builtin_runtime(config)
    runtime = await runtime_cm.__aenter__()
    _state["runtime_cm"] = runtime_cm  # keeps the runtime alive across requests
    scope = await runtime.scopes.create(
        ScopeDraft(title="记忆旅馆", summary="玩家的冒险记忆", idempotency_key=SCOPE_KEY)
    )
    _state["memory"] = runtime.memory.for_scope(scope.scope_id)
    _state["scope_id"] = scope.scope_id
    print(f"[bridge] ready scope={scope.scope_id}", flush=True)


async def _remember(kind: str, text: str) -> dict:
    await _state["memory"].remember(RememberMemoryRequest(entries=(MemoryEntryInput(kind=kind, text=text),)))
    return {"ok": True, "stored": 1}


async def _search(query: str, limit: int) -> dict:
    page = await _state["memory"].search(SearchMemoryRequest(query=query, mode="fts", limit=limit))
    return {
        "ok": True,
        "hits": [{"text": getattr(h, "text", ""), "score": float(getattr(h, "score", 0.0) or 0.0)} for h in page.hits],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _reply(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._reply({"ok": "memory" in _state, "scope_id": _state.get("scope_id")})
        else:
            self._reply({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/memory/remember":
                result = _run(_remember(str(payload.get("kind", "note")), str(payload.get("text", ""))))
            elif self.path == "/memory/search":
                result = _run(_search(str(payload.get("query", "")), int(payload.get("limit", 5))))
            else:
                return self._reply({"ok": False, "error": "not found"}, 404)
            self._reply(result)
        except Exception as error:  # noqa: BLE001
            self._reply({"ok": False, "error": f"{type(error).__name__}: {error}"}, 500)


def main() -> None:
    threading.Thread(target=_loop.run_forever, daemon=True).start()
    _run(_boot())
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[bridge] http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
