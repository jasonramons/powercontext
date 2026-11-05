# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""PI session history as immutable, per-event Sources.

A PI session archive is a JSONL tree: one ``session`` header followed by
records linked through ``parentId``. One conversation branch is the path from
the selected leaf up to the root; every visible node on that path becomes its
own captured Source so a citation can be traced back to the exact event,
including the control nodes that only exist as parent links.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, JsonValue

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources.connectors import ConnectorRunCompletion, ConnectorRunStatus
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence

PI_EVENT_SOURCE_NAME = "pi-event"
PI_CONNECTOR_NAME = "pi-session-history"
PI_CONNECTOR_VERSION = "1"
SESSION_TYPE = "session"
SUPPORTED_SESSION_VERSION = 3
_SUMMARY_EVENT_TYPES = ("compaction", "branch_summary")
_UTF8_BOM = "\ufeff"


class PiSessionInput(BaseModel):
    """One PI session archive plus the branch leaf to capture."""

    model_config = ConfigDict(frozen=True)

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One visible event on the selected branch, with its complete record."""

    model_config = ConfigDict(frozen=True)

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


class PiEventSource(Source):
    """A captured PI event that can be projected as textual evidence."""

    source_id: str
    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


def pi_event_source_id(session_id: str, event_id: str) -> str:
    """Return the immutable identity of one session event."""

    if not isinstance(session_id, str) or not session_id:
        raise ValueError("session_id must be a non-empty string")
    if not isinstance(event_id, str) or not event_id:
        raise ValueError("event_id must be a non-empty string")
    source_id = (
        f"{PI_EVENT_SOURCE_NAME}:{quote(session_id, safe='')}:{quote(event_id, safe='')}"
    )
    if len(source_id) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(
            f"pi event source id must not exceed {MAX_SOURCE_ID_LENGTH} characters"
        )
    return source_id


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _text_of(parts: Any) -> str | None:
    """Concatenate the visible text of a content payload."""

    if isinstance(parts, str):
        return parts
    if not isinstance(parts, list):
        return None
    rendered: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind == "text" and isinstance(part.get("text"), str):
            rendered.append(part["text"])
        elif kind == "toolCall":
            name = str(part.get("name") or "")
            call_id = str(part.get("id") or "")
            arguments = part.get("arguments")
            rendered.append(f"[tool_call {name} {call_id}] {_compact_json(arguments)}")
        # thinking and images never enter the evidence text.
    if not rendered:
        return None
    return "\n".join(rendered)


def _message_body(role: str, message: dict[str, Any]) -> str | None:
    if role == "toolResult":
        name = str(message.get("toolName") or "")
        call_id = str(message.get("toolCallId") or "")
        text = _text_of(message.get("content"))
        if text is None:
            return None
        return f"[tool_result {name} {call_id}] {text}"
    if role == "bashExecution":
        command = str(message.get("command") or "")
        output = message.get("output")
        output_text = output if isinstance(output, str) else ""
        return f"$ {command}\n{output_text}"
    return _text_of(message.get("content"))


def _render_event(record: dict[str, Any]) -> tuple[str, str] | None:
    """Return ``(role, content)`` for a visible node, or ``None``."""

    event_type = record.get("type")
    if event_type == "message":
        message = record.get("message")
        if not isinstance(message, dict):
            return None
        role = str(message.get("role") or "")
        if not role:
            return None
        body = _message_body(role, message)
        if body is None:
            return None
        return role, f"{role}: {body}"
    if event_type in _SUMMARY_EVENT_TYPES:
        summary = record.get("summary")
        if not isinstance(summary, str) or not summary:
            return None
        return str(event_type), f"{event_type}: {summary}"
    if event_type == "custom_message":
        text = _text_of(record.get("content"))
        if text is None:
            return None
        return "custom", f"custom: {text}"
    return None


def _parse_records(content: bytes) -> tuple[str, list[dict[str, Any]]]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"PI session archive is not UTF-8: {exc}") from exc
    if text.startswith(_UTF8_BOM):
        text = text[len(_UTF8_BOM) :]
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("PI session archive is empty")

    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL record: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ValueError("every JSONL line must be a JSON object")
        records.append(parsed)

    header = records[0]
    if header.get("type") != SESSION_TYPE:
        raise ValueError("first JSONL record must be a session header")
    version = header.get("version")
    if version != SUPPORTED_SESSION_VERSION:
        raise ValueError(f"unsupported PI session version: {version!r}")
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("session header must carry a non-empty id")
    return session_id, records[1:]


def _resolve_path(nodes: list[dict[str, Any]], leaf_id: str | None) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id:
            raise ValueError("every record must carry a non-empty id")
        if node_id in by_id:
            raise ValueError(f"duplicate record id: {node_id}")
        parent = node.get("parentId")
        if parent is not None and (not isinstance(parent, str) or not parent):
            raise ValueError(f"record {node_id} has an invalid parentId")
        by_id[node_id] = node

    for node in nodes:
        parent = node.get("parentId")
        if parent is not None and parent not in by_id:
            raise ValueError(f"record {node['id']} references a missing parent {parent}")

    # Detect cycles by walking every parent chain once.
    for start in by_id:
        seen: set[str] = set()
        cursor: str | None = start
        while cursor is not None:
            if cursor in seen:
                raise ValueError("PI session parent chain contains a cycle")
            seen.add(cursor)
            cursor = by_id[cursor].get("parentId")

    if leaf_id is None:
        children = {node.get("parentId") for node in nodes}
        leaves = [node["id"] for node in nodes if node["id"] not in children]
        if not leaves:
            raise ValueError("PI session branch has no leaf")
        leaf_id = leaves[-1]
    if leaf_id not in by_id:
        raise ValueError(f"leaf {leaf_id!r} is not present in the archive")

    path: list[dict[str, Any]] = []
    cursor: str | None = leaf_id
    while cursor is not None:
        node = by_id[cursor]
        path.append(node)
        cursor = node.get("parentId")
    path.reverse()
    return path


def parse_pi_session(value: PiSessionInput) -> tuple[PiEventInput, ...]:
    """Parse one archive and return the visible events of the selected branch."""

    session_id, nodes = _parse_records(value.content)
    path = _resolve_path(nodes, value.leaf_id)
    events: list[PiEventInput] = []
    for node in path:
        rendered = _render_event(node)
        if rendered is None:
            continue
        role, content = rendered
        event_id = str(node["id"])
        pi_event_source_id(session_id, event_id)
        events.append(
            PiEventInput(
                session_id=session_id,
                event_id=event_id,
                parent_id=node.get("parentId"),
                event_type=str(node.get("type")),
                role=role,
                content=content,
                record=node,
            )
        )
    return tuple(events)


class PiEventSourceAdapter:
    """Resolve and read the per-event PI Source."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        source_id = pi_event_source_id(value.session_id, value.event_id)
        return PiEventSource(
            name=source_id,
            source_id=source_id,
            materialization=SourceMaterialization.CAPTURED,
            session_id=value.session_id,
            event_id=value.event_id,
            parent_id=value.parent_id,
            event_type=value.event_type,
            role=value.role,
            content=value.content,
            record=value.record,
        )

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return PiEventInput(
            session_id=source.session_id,
            event_id=source.event_id,
            parent_id=source.parent_id,
            event_type=source.event_type,
            role=source.role,
            content=source.content,
            record=source.record,
        )


class PiEventTextEvidenceProjection:
    """Render one PI event as the canonical textual evidence object."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        metadata: dict[str, Any] = {
            "session_id": source.session_id,
            "event_id": source.event_id,
            "parent_id": source.parent_id,
            "event_type": source.event_type,
            "role": source.role,
        }
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_NAME,
            source_id=source.source_id,
            content=source.content,
            metadata=metadata,
        )


PI_EVENT_SOURCE_DEFINITION: SourceDefinition[PiEventInput, PiEventSource, PiEventInput] = (
    AdapterSourceDefinition(
        PiEventSourceAdapter(),
        projections=(PiEventTextEvidenceProjection(),),
    )
)


def _record_digest(record: dict[str, JsonValue]) -> str:
    payload = _compact_json(record).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class PiSessionConnector:
    """Capture one PI session branch, importing only events not yet persisted."""

    name = PI_CONNECTOR_NAME
    version = PI_CONNECTOR_VERSION
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self._path = Path(path)
        self._leaf_id = leaf_id

    async def run(self, session) -> ConnectorRunCompletion:
        events = parse_pi_session(
            PiSessionInput(content=self._path.read_bytes(), leaf_id=self._leaf_id)
        )
        checkpoint = session.checkpoint
        imported: dict[str, str] = {}
        if isinstance(checkpoint, dict):
            raw_imported = checkpoint.get("imported")
            if isinstance(raw_imported, dict):
                imported = {str(key): str(value) for key, value in raw_imported.items()}

        changed = False
        for event in events:
            digest = _record_digest(event.record)
            known = imported.get(event.event_id)
            if known is not None:
                if known != digest:
                    raise ValueError(
                        f"event {event.event_id} was already captured with different content"
                    )
                continue
            await session.submit(event.event_id, PI_EVENT_SOURCE_NAME, event)
            imported[event.event_id] = digest
            changed = True

        next_checkpoint: JsonValue | None = {"imported": imported} if changed or checkpoint is None else checkpoint
        return ConnectorRunCompletion(
            status=ConnectorRunStatus.COMPLETE,
            checkpoint=next_checkpoint,
        )


__all__ = [
    "PI_CONNECTOR_NAME",
    "PI_CONNECTOR_VERSION",
    "PI_EVENT_SOURCE_DEFINITION",
    "PI_EVENT_SOURCE_NAME",
    "PiEventInput",
    "PiEventSource",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
    "pi_event_source_id",
]
