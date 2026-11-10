"""嵌入式 seekdb 存储层：工程资料片段与向量索引都落在 seekdb 里。

实现说明
--------
``pylibseekdb`` 在本机启动一个嵌入式实例并给出连接参数，之后用普通的 MySQL
协议（pymysql）访问——SQL、表结构、检索都在 seekdb 里执行，没有第二个存储。

所有 SQL 都会写进 ``records/db-queries.log``，评审可以据此核对「数据库真的参与了
上下文构造」，而不是只装了一个 SDK。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .embed import DIM, cosine, embed, to_sql_literal

TABLE = "mm_material_chunks"

DDL_VECTOR = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    chunk_id     VARCHAR(64)  NOT NULL,
    doc_key      VARCHAR(255) NOT NULL,
    kind         VARCHAR(16)  NOT NULL,
    path         VARCHAR(512) NOT NULL,
    symbol       VARCHAR(191) NOT NULL,
    start_line   INT          NOT NULL,
    end_line     INT          NOT NULL,
    body         MEDIUMTEXT   NOT NULL,
    embedding    VECTOR({DIM}) NOT NULL,
    tags         VARCHAR(255) NOT NULL,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chunk_id),
    KEY idx_kind (kind),
    KEY idx_doc_key (doc_key)
) DEFAULT CHARSET = utf8mb4
"""

DDL_FALLBACK = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    chunk_id     VARCHAR(64)  NOT NULL,
    doc_key      VARCHAR(255) NOT NULL,
    kind         VARCHAR(16)  NOT NULL,
    path         VARCHAR(512) NOT NULL,
    symbol       VARCHAR(191) NOT NULL,
    start_line   INT          NOT NULL,
    end_line     INT          NOT NULL,
    body         MEDIUMTEXT   NOT NULL,
    embedding    MEDIUMTEXT   NOT NULL,
    tags         VARCHAR(255) NOT NULL,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chunk_id),
    KEY idx_kind (kind)
) DEFAULT CHARSET = utf8mb4
"""


def _preview_params(params: tuple) -> str:
    """把 SQL 参数压成一行，向量只保留前 32 个字符，便于核对而不刷屏。"""
    if not params:
        return "-"
    parts = []
    for value in params:
        text = str(value).replace("\n", " ")
        if len(text) > 48:
            text = text[:48] + f"…({len(text)} chars)"
        parts.append(text)
    return " | ".join(parts)


@dataclass(slots=True)
class Hit:
    chunk_id: str
    doc_key: str
    kind: str
    path: str
    symbol: str
    start_line: int
    end_line: int
    text: str
    distance: float
    score: float
    matched: tuple[str, ...] = ()

    @property
    def source(self) -> str:
        return f"{self.path}:{self.start_line}-{self.end_line}"


class SeekDBStore:
    """一个嵌入式 seekdb 实例 + 一张资料表。"""

    def __init__(self, db_path: Path, log_path: Path | None = None) -> None:
        self.db_path = Path(db_path)
        self.log_path = Path(log_path) if log_path else None
        self.vector_mode = "vector"
        self.endpoint: dict[str, object] = {}
        self._instance = None
        self._conn = None

    # ------------------------------------------------------------------ 生命周期
    async def open(self) -> "SeekDBStore":
        import pylibseekdb  # 延迟导入：没有安装时给出明确错误

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._instance = await pylibseekdb.aopen(str(self.db_path))
        options = dict(self._instance.connection_options())
        self.endpoint = {
            key: value
            for key, value in options.items()
            if key in {"host", "port", "user", "transport", "database"}
        }
        if options.get("unix_socket"):
            self.endpoint["unix_socket"] = str(options["unix_socket"])
        self._conn = self._connect(options)
        self._ensure_schema()
        return self

    def _connect(self, options: dict[str, object]):
        import pymysql

        kwargs: dict[str, object] = {
            "user": str(options.get("user", "root")),
            "password": str(options.get("password", "") or ""),
            "database": "test",
            "charset": "utf8mb4",
            "autocommit": True,
            "connect_timeout": 20,
        }
        host = str(options.get("host", "127.0.0.1"))
        socket_path = options.get("unix_socket") or options.get("socket")
        if socket_path:
            kwargs["unix_socket"] = str(socket_path)
        elif host.startswith("/") or options.get("transport") == "unix":
            kwargs["unix_socket"] = host
        else:
            kwargs["host"] = host
            if options.get("port") is not None:
                kwargs["port"] = int(options["port"])
        return pymysql.connect(**kwargs)

    def _ensure_schema(self) -> None:
        try:
            self._execute(DDL_VECTOR, rows_expected=0)
            self.vector_mode = "vector"
        except Exception as error:  # noqa: BLE001 - 退回文本列，检索在 Python 侧重排
            self._log(f"-- VECTOR DDL 不可用（{type(error).__name__}: {error}），退回 embedding TEXT 列")
            self._execute(DDL_FALLBACK, rows_expected=0)
            self.vector_mode = "python"

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass
            self._conn = None
        if self._instance is not None:
            try:
                self._instance.close()
            except Exception:  # noqa: BLE001
                pass
            self._instance = None

    def __enter__(self) -> "SeekDBStore":
        raise TypeError("SeekDBStore 是异步打开的，请使用 await store.open()")

    # ------------------------------------------------------------------ SQL 执行
    def _log(self, line: str) -> None:
        if self.log_path is None:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(line.rstrip() + "\n")

    def _execute(self, sql: str, params: tuple = (), *, rows_expected: int | None = None):
        import pymysql

        started = time.perf_counter()
        cursor = self._conn.cursor(pymysql.cursors.DictCursor)
        try:
            cursor.execute(sql, params)
            rows = cursor.fetchall() if cursor.description else []
            affected = None if cursor.description else cursor.rowcount
        finally:
            cursor.close()
        elapsed_ms = (time.perf_counter() - started) * 1000
        compact = " ".join(sql.split())[:300]
        self._log(
            f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] "
            f"sql={compact} params={_preview_params(params)} "
            f"rows={len(rows)} affected={affected} elapsed_ms={elapsed_ms:.1f}"
        )
        return rows

    # ------------------------------------------------------------------ 写入
    def replace_document(self, doc_key: str, chunks: list) -> int:
        """同一 ``doc_key`` 的旧片段整体替换，保证规格改版后不残留旧版本。"""
        self._execute(f"DELETE FROM {TABLE} WHERE doc_key = %s", (doc_key,), rows_expected=0)
        if not chunks:
            return 0
        if self.vector_mode == "vector":
            sql = (
                f"INSERT INTO {TABLE} "
                "(chunk_id, doc_key, kind, path, symbol, start_line, end_line, body, embedding, tags) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            )
        else:
            sql = (
                f"INSERT INTO {TABLE} "
                "(chunk_id, doc_key, kind, path, symbol, start_line, end_line, body, embedding, tags) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            )
        inserted = 0
        for chunk in chunks:
            vector = embed(chunk.text)
            payload = to_sql_literal(vector) if self.vector_mode == "vector" else json.dumps(vector)
            self._execute(
                sql,
                (
                    chunk.chunk_id,
                    chunk.doc_key,
                    chunk.kind,
                    chunk.path,
                    chunk.symbol,
                    chunk.start_line,
                    chunk.end_line,
                    chunk.text,
                    payload,
                    ",".join(chunk.tags),
                ),
                rows_expected=0,
            )
            inserted += 1
        return inserted

    # ------------------------------------------------------------------ 检索
    def _rows_to_hits(self, rows: list[dict], query: str, query_vector: list[float]) -> list[Hit]:
        lowered = query.lower()
        keywords = [token for token in lowered.replace("，", " ").replace("。", " ").split() if len(token) >= 2]
        hits: list[Hit] = []
        for row in rows:
            if self.vector_mode == "vector":
                distance = float(row.get("distance") or 0.0)
                vector = None
            else:
                vector = json.loads(row["embedding"])
                distance = 1.0 - cosine(query_vector, vector)
            text = str(row["body"])
            lowered_text = text.lower()
            matched = tuple(keyword for keyword in keywords if keyword and keyword in lowered_text)
            symbol_bonus = 1.0 if query.lower() in str(row["symbol"]).lower() else 0.0
            score = (1.0 - distance) + 0.15 * len(matched) + 0.1 * symbol_bonus
            hits.append(
                Hit(
                    chunk_id=row["chunk_id"],
                    doc_key=row["doc_key"],
                    kind=row["kind"],
                    path=row["path"],
                    symbol=row["symbol"],
                    start_line=int(row["start_line"]),
                    end_line=int(row["end_line"]),
                    text=text,
                    distance=distance,
                    score=score,
                    matched=matched,
                )
            )
        return hits

    def search(self, query: str, *, kinds: tuple[str, ...] = ("spec", "code", "test"), limit: int = 24) -> list[Hit]:
        query_vector = embed(query)
        placeholders = ", ".join(["%s"] * len(kinds))
        if self.vector_mode == "vector":
            sql = (
                f"SELECT chunk_id, doc_key, kind, path, symbol, start_line, end_line, body, "
                f"COSINE_DISTANCE(embedding, %s) AS distance "
                f"FROM {TABLE} WHERE kind IN ({placeholders}) ORDER BY distance ASC LIMIT %s"
            )
            params: tuple = (to_sql_literal(query_vector), *kinds, limit)
        else:
            sql = (
                f"SELECT chunk_id, doc_key, kind, path, symbol, start_line, end_line, body, embedding "
                f"FROM {TABLE} WHERE kind IN ({placeholders}) LIMIT 2000"
            )
            params = tuple(kinds)
        rows = self._execute(sql, params)
        hits = self._rows_to_hits(rows, query, query_vector)
        hits.sort(key=lambda hit: hit.score, reverse=True)
        return hits[:limit]

    def find(self, *, kind: str, symbol: str | None = None, path: str | None = None):
        """按符号 / 路径精确回查一条来源，供「必需来源」补位使用。"""
        clauses = ["kind = %s"]
        params: list[object] = [kind]
        if symbol:
            clauses.append("symbol = %s")
            params.append(symbol)
        if path:
            clauses.append("path = %s")
            params.append(path)
        sql = (
            f"SELECT chunk_id, doc_key, kind, path, symbol, start_line, end_line, body, "
            f"0.0 AS distance FROM {TABLE} WHERE " + " AND ".join(clauses) + " LIMIT 1"
        )
        rows = self._execute(sql, tuple(params))
        if not rows:
            return None
        hits = self._rows_to_hits(rows, symbol or path or "", [0.0] * DIM)
        return hits[0] if hits else None

    # ------------------------------------------------------------------ 观测
    def stats(self) -> dict:
        rows = self._execute(f"SELECT kind, COUNT(*) AS total FROM {TABLE} GROUP BY kind", rows_expected=1)
        counts = {row["kind"]: int(row["total"]) for row in rows}
        total_rows = self._execute(f"SELECT COUNT(*) AS total FROM {TABLE}", rows_expected=1)
        return {
            "table": TABLE,
            "vector_mode": self.vector_mode,
            "endpoint": self.endpoint,
            "db_path": str(self.db_path),
            "chunks_by_kind": counts,
            "chunks_total": int(total_rows[0]["total"]) if total_rows else 0,
        }

    def describe(self, doc_key: str) -> list[dict]:
        rows = self._execute(
            f"SELECT symbol, start_line, end_line FROM {TABLE} WHERE doc_key = %s ORDER BY start_line",
            (doc_key,),
            rows_expected=1,
        )
        return [dict(row) for row in rows]

    def raw_sql(self, sql: str) -> list[dict]:
        """给评审用的逃生口：``mmctx db --sql '...'`` 直接查 seekdb。"""
        return [dict(row) for row in self._execute(sql)]
