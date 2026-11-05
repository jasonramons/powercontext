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

"""Wire format for prepared context: a signed pack plus a prefix-delta.

A pack is the canonical JSON of its base64 items plus a digest over that
unsigned body and its own serialized size. A delta names the base and target
digests, the reusable item prefix, and the items appended after it, so a
receiver that already holds the base can rebuild the target exactly.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Iterable, Sequence
from typing import Any

CONTEXT_PACK_SCHEMA = "powercontext.context-pack.v1"
CONTEXT_PACK_DELTA_SCHEMA = "powercontext.context-pack-delta.v1"

_PACK_FIELDS = frozenset({"schema", "items", "digest", "byte_count"})
_DELTA_FIELDS = frozenset({"schema", "base_digest", "target_digest", "prefix_items", "appended"})
_DIGEST_PREFIX = "sha256:"


class ContextPackError(ValueError):
    """A pack or delta payload is missing, malformed, or tampered with."""


def _canonical(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest_of(unsigned: dict[str, Any]) -> str:
    return _DIGEST_PREFIX + hashlib.sha256(_canonical(unsigned)).hexdigest()


def _require_digest(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.startswith(_DIGEST_PREFIX):
        raise ContextPackError(f"{field} must be a sha256 digest")
    body = value[len(_DIGEST_PREFIX) :]
    if len(body) != 64 or any(ch not in "0123456789abcdef" for ch in body):
        raise ContextPackError(f"{field} must be a sha256 digest")
    return value


def _encode_items(items: Iterable[bytes]) -> list[str]:
    encoded: list[str] = []
    for item in items:
        if not isinstance(item, (bytes, bytearray)):
            raise ContextPackError("context pack items must be bytes")
        encoded.append(base64.b64encode(bytes(item)).decode("ascii"))
    return encoded


def _decode_items(values: Any) -> tuple[bytes, ...]:
    if not isinstance(values, list):
        raise ContextPackError("items must be a list of base64 strings")
    decoded: list[bytes] = []
    for value in values:
        if not isinstance(value, str):
            raise ContextPackError("items must be a list of base64 strings")
        try:
            decoded.append(base64.b64decode(value.encode("ascii"), validate=True))
        except (binascii.Error, UnicodeEncodeError) as exc:
            raise ContextPackError(f"item is not valid base64: {exc}") from exc
    return tuple(decoded)


class ContextPack:
    """An immutable, digest-signed list of prepared context items."""

    __slots__ = ("_appended", "_byte_count", "_digest", "_items", "_payload")

    def __init__(self, items: Sequence[bytes], *, _payload: bytes | None = None) -> None:
        self._items = tuple(bytes(item) for item in items)
        unsigned = {"schema": CONTEXT_PACK_SCHEMA, "items": _encode_items(self._items)}
        self._digest = _digest_of(unsigned)
        if _payload is not None:
            self._payload = _payload
            self._byte_count = len(_payload)
        else:
            self._payload, self._byte_count = _sign(unsigned, self._digest)

    @classmethod
    def build(cls, items: Iterable[bytes], /) -> ContextPack:
        return cls(tuple(items))

    @classmethod
    def from_bytes(cls, data: bytes, /) -> ContextPack:
        payload = _parse_object(data, _PACK_FIELDS, "context pack")
        if payload["schema"] != CONTEXT_PACK_SCHEMA:
            raise ContextPackError("unsupported context pack schema")
        items = _decode_items(payload["items"])
        unsigned = {"schema": CONTEXT_PACK_SCHEMA, "items": payload["items"]}
        expected = _digest_of(unsigned)
        digest = _require_digest(payload["digest"], "digest")
        if digest != expected:
            raise ContextPackError("context pack digest does not match its items")
        byte_count = payload["byte_count"]
        if isinstance(byte_count, bool) or not isinstance(byte_count, int):
            raise ContextPackError("byte_count must be an integer")
        if byte_count != len(data):
            raise ContextPackError("byte_count does not match the payload size")
        return cls(items, _payload=bytes(data))

    @classmethod
    def from_content(cls, content: str, /, *, chunk_bytes: int = 512) -> ContextPack:
        if not isinstance(content, str):
            raise ContextPackError("content must be text")
        if isinstance(chunk_bytes, bool) or not isinstance(chunk_bytes, int) or chunk_bytes < 1:
            raise ContextPackError("chunk_bytes must be a positive integer")
        return cls.build(_chunk_text(content, chunk_bytes))

    @property
    def items(self) -> tuple[bytes, ...]:
        return self._items

    @property
    def digest(self) -> str:
        return self._digest

    @property
    def byte_count(self) -> int:
        return self._byte_count

    def to_bytes(self) -> bytes:
        return self._payload

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ContextPack) and other.to_bytes() == self.to_bytes()

    def __hash__(self) -> int:
        return hash(self._payload)

    def __repr__(self) -> str:
        return f"ContextPack(items={len(self._items)}, digest={self._digest!r})"


def _sign(unsigned: dict[str, Any], digest: str) -> tuple[bytes, int]:
    """Serialize with a byte_count that equals the final payload length."""

    byte_count = 0
    for _ in range(8):
        payload = _canonical({**unsigned, "digest": digest, "byte_count": byte_count})
        if len(payload) == byte_count:
            return payload, byte_count
        byte_count = len(payload)
    raise ContextPackError("could not settle context pack byte_count")


def _parse_object(data: bytes, fields: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(data, (bytes, bytearray)):
        raise ContextPackError(f"{label} payload must be bytes")
    try:
        payload = json.loads(bytes(data))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ContextPackError(f"{label} payload is not JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ContextPackError(f"{label} payload must be a JSON object")
    if set(payload) != fields:
        raise ContextPackError(f"{label} payload must contain exactly {sorted(fields)}")
    return payload


def _chunk_text(content: str, chunk_bytes: int) -> tuple[bytes, ...]:
    chunks: list[bytes] = []
    buffer = bytearray()
    for char in content:
        encoded = char.encode("utf-8")
        if len(encoded) > chunk_bytes:
            raise ContextPackError("a character does not fit into one chunk")
        if len(buffer) + len(encoded) > chunk_bytes:
            chunks.append(bytes(buffer))
            buffer = bytearray()
        buffer.extend(encoded)
    if buffer:
        chunks.append(bytes(buffer))
    return tuple(chunks)


class ContextPackDelta:
    """The reusable item prefix of a base pack plus the target's tail."""

    __slots__ = ("_appended", "_base_digest", "_byte_count", "_prefix_items", "_target_digest")

    def __init__(
        self,
        base_digest: str,
        target_digest: str,
        prefix_items: int,
        appended: Sequence[bytes],
        /,
    ) -> None:
        self._base_digest = _require_digest(base_digest, "base_digest")
        self._target_digest = _require_digest(target_digest, "target_digest")
        if isinstance(prefix_items, bool) or not isinstance(prefix_items, int) or prefix_items < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        self._prefix_items = prefix_items
        self._appended = tuple(bytes(item) for item in appended)
        self._byte_count = len(self.to_bytes())

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack, /) -> ContextPackDelta:
        base_items = base.items
        target_items = target.items
        prefix = 0
        limit = min(len(base_items), len(target_items))
        while prefix < limit and base_items[prefix] == target_items[prefix]:
            prefix += 1
        return cls(base.digest, target.digest, prefix, target_items[prefix:])

    @classmethod
    def from_bytes(cls, data: bytes, /) -> ContextPackDelta:
        payload = _parse_object(data, _DELTA_FIELDS, "context pack delta")
        if payload["schema"] != CONTEXT_PACK_DELTA_SCHEMA:
            raise ContextPackError("unsupported context pack delta schema")
        prefix_items = payload["prefix_items"]
        if isinstance(prefix_items, bool) or not isinstance(prefix_items, int) or prefix_items < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        appended = _decode_items(payload["appended"])
        return cls(
            payload["base_digest"],
            payload["target_digest"],
            prefix_items,
            appended,
        )

    @property
    def base_digest(self) -> str:
        return self._base_digest

    @property
    def target_digest(self) -> str:
        return self._target_digest

    @property
    def prefix_items(self) -> int:
        return self._prefix_items

    @property
    def appended(self) -> tuple[bytes, ...]:
        return self._appended

    @property
    def byte_count(self) -> int:
        return self._byte_count

    def to_bytes(self) -> bytes:
        return _canonical(
            {
                "schema": CONTEXT_PACK_DELTA_SCHEMA,
                "base_digest": self._base_digest,
                "target_digest": self._target_digest,
                "prefix_items": self._prefix_items,
                "appended": _encode_items(self._appended),
            }
        )

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ContextPackDelta) and other.to_bytes() == self.to_bytes()

    def __repr__(self) -> str:
        return (
            f"ContextPackDelta(prefix_items={self._prefix_items}, "
            f"appended={len(self._appended)})"
        )


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Rebuild the target pack from a base pack and its delta."""

    if base.digest != delta.base_digest:
        raise ContextPackError("delta base digest does not match the provided pack")
    if delta.prefix_items > len(base.items):
        raise ContextPackError("delta prefix exceeds the base pack item count")
    rebuilt = ContextPack.build(base.items[: delta.prefix_items] + delta.appended)
    if rebuilt.digest != delta.target_digest:
        raise ContextPackError("delta does not reconstruct the target digest")
    return rebuilt


__all__ = [
    "CONTEXT_PACK_DELTA_SCHEMA",
    "CONTEXT_PACK_SCHEMA",
    "ContextPack",
    "ContextPackDelta",
    "ContextPackError",
    "apply_context_pack_delta",
]
