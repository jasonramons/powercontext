"""PowerContext bridge for the study assistant.

The Node app owns seekdb (item storage + hybrid retrieval). PowerContext owns
the *learner memory*: which knowledge points this person keeps getting wrong.
Keeping it in this tiny sidecar means the Node side never has to embed a Python
runtime, and PowerContext stays a real, durable service rather than a library
that is imported and thrown away.

Run:  python bridge/app.py            (defaults to 127.0.0.1:8766)
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
PORT = int(os.environ.get("PC_BRIDGE_PORT", "8766"))
DB_PATH = os.environ.get("PC_DB", os.path.join(os.path.dirname(__file__), "..", "data", "powercontext.db"))
SCOPE_KEY = "study-buddy-learner"

_loop = asyncio.new_event_loop()
_state: dict[str, object] = {}


def _run(coro):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout=30)


async def _boot() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{DB_PATH}"))
    # Keep the async context manager alive: dropping it closes the runtime as
    # soon as the garbage collector runs, and every later call fails with
    # "Built-in Runtime is closed".
    runtime_cm = open_builtin_runtime(config)
    runtime = await runtime_cm.__aenter__()
    _state["runtime_cm"] = runtime_cm
    scope = await runtime.scopes.create(
        ScopeDraft(title="学习助手", summary="薄弱知识点与复习记录", idempotency_key=SCOPE_KEY)
    )
    _state["runtime"] = runtime
    _state["memory"] = runtime.memory.for_scope(scope.scope_id)
    _state["scope_id"] = scope.scope_id
    print(f"[bridge] ready scope={scope.scope_id} db={DB_PATH}", flush=True)


async def _remember(kind: str, text: str) -> dict:
    memory = _state["memory"]
    await memory.remember(RememberMemoryRequest(entries=(MemoryEntryInput(kind=kind, text=text),)))
    return {"ok": True, "stored": 1}


async def _search(query: str, limit: int) -> dict:
    memory = _state["memory"]
    page = await memory.search(SearchMemoryRequest(query=query, mode="fts", limit=limit))
    hits = []
    for hit in page.hits:
        hits.append({"text": getattr(hit, "text", ""), "score": float(getattr(hit, "score", 0.0) or 0.0)})
    return {"ok": True, "hits": hits}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the demo console quiet
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
        except Exception as error:  # noqa: BLE001 - report failures to the caller
            self._reply({"ok": False, "error": f"{type(error).__name__}: {error}"}, 500)


def main() -> None:
    threading.Thread(target=_loop.run_forever, daemon=True).start()
    _run(_boot())
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[bridge] http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
