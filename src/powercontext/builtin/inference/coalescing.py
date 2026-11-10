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

"""Coalesce concurrent embedding requests and cache their vectors.

One wrapper instance owns a short coalescing window: every caller that arrives
inside the window contributes its unique texts, the union is sent to the
underlying model in ``max_batch_size`` batches, and each caller gets its own
vectors back in request order (duplicates preserved). Successful vectors are
kept in an LRU cache, so a repeated text never costs another provider call.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Iterable, Sequence

from powercontext.builtin.inference.models import (
    EmbeddingResult,
    EmbeddingVector,
    InferenceUsage,
)
from powercontext.builtin.inference.protocols import EmbeddingModel

DEFAULT_MAX_BATCH_SIZE = 64
DEFAULT_COALESCE_MS = 5.0
DEFAULT_CACHE_SIZE = 1024


def _chunks(items: Sequence[str], size: int) -> Iterable[tuple[str, ...]]:
    for start in range(0, len(items), size):
        yield tuple(items[start : start + size])


class CoalescingEmbeddingModel:
    """Wrap one embedding model with request coalescing and an LRU cache."""

    def __init__(
        self,
        model: EmbeddingModel,
        *,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        coalesce_ms: float = DEFAULT_COALESCE_MS,
        cache_size: int = DEFAULT_CACHE_SIZE,
    ) -> None:
        if isinstance(max_batch_size, bool) or not isinstance(max_batch_size, int) or max_batch_size < 1:
            raise ValueError("max_batch_size must be a positive integer")
        if isinstance(cache_size, bool) or not isinstance(cache_size, int) or cache_size < 0:
            raise ValueError("cache_size must be a non-negative integer")
        if isinstance(coalesce_ms, bool) or not isinstance(coalesce_ms, (int, float)) or coalesce_ms < 0:
            raise ValueError("coalesce_ms must be a non-negative number")
        self._model = model
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = float(coalesce_ms) / 1000.0
        self._cache_size = cache_size
        self._cache: OrderedDict[str, EmbeddingVector] = OrderedDict()
        self._pending: dict[str, asyncio.Future[EmbeddingVector]] = {}
        self._call_usage: dict[int, InferenceUsage] = {}
        self._calls_by_text: dict[str, set[int]] = {}
        self._next_call_id = 0
        self._flush_handle: asyncio.TimerHandle | None = None

    @property
    def profile(self):
        return self._model.profile

    async def embed(self, texts: Sequence[str], /) -> EmbeddingResult:
        requested = tuple(texts)
        if not requested:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))

        unique = tuple(dict.fromkeys(requested))
        vectors: dict[str, EmbeddingVector] = {}
        futures: dict[str, asyncio.Future[EmbeddingVector]] = {}
        joined: list[str] = []

        for text in unique:
            cached = self._cache.get(text)
            if cached is not None:
                self._cache.move_to_end(text)
                vectors[text] = cached
                continue
            future = self._pending.get(text)
            if future is None:
                future = asyncio.get_running_loop().create_future()
                self._pending[text] = future
                joined.append(text)
            futures[text] = future

        if joined:
            self._schedule_flush()

        if futures:
            # shield keeps the shared provider call alive when this waiter is cancelled
            await asyncio.gather(*(asyncio.shield(future) for future in futures.values()))
            for text, future in futures.items():
                vectors[text] = future.result()

        # Only the texts that actually consulted the provider are charged; a
        # cache hit reuses a vector that was already paid for.
        call_ids: set[int] = set()
        for text in futures:
            call_ids.update(self._calls_by_text.get(text, ()))
        return EmbeddingResult(
            vectors=tuple(vectors[text] for text in requested),
            usage=self._usage_for(call_ids),
        )

    def _usage_for(self, call_ids: set[int]) -> InferenceUsage:
        if not call_ids:
            return InferenceUsage(requests=0)
        requests = 0
        input_tokens = 0
        output_tokens = 0
        seen_tokens = False
        for call_id in sorted(call_ids):
            call_usage = self._call_usage.get(call_id)
            if call_usage is None:
                requests += 1
                continue
            requests += max(call_usage.requests, 1)
            if call_usage.input_tokens is not None:
                input_tokens += call_usage.input_tokens
                seen_tokens = True
            if call_usage.output_tokens is not None:
                output_tokens += call_usage.output_tokens
                seen_tokens = True
        return InferenceUsage(
            requests=requests,
            input_tokens=input_tokens if seen_tokens else None,
            output_tokens=output_tokens if seen_tokens else None,
        )

    def _schedule_flush(self) -> None:
        if self._flush_handle is not None:
            return
        loop = asyncio.get_running_loop()
        if self._coalesce_seconds <= 0:
            self._flush_handle = loop.call_soon(self._flush)
        else:
            self._flush_handle = loop.call_later(self._coalesce_seconds, self._flush)

    def _flush(self) -> None:
        self._flush_handle = None
        pending = self._pending
        self._pending = {}
        if pending:
            asyncio.ensure_future(self._run_batches(pending))

    async def _run_batches(self, pending: dict[str, asyncio.Future[EmbeddingVector]]) -> None:
        for chunk in _chunks(list(pending), self._max_batch_size):
            call_id = self._next_call_id
            self._next_call_id += 1
            for text in chunk:
                self._calls_by_text.setdefault(text, set()).add(call_id)
            try:
                result = await self._model.embed(tuple(chunk))
                if len(result.vectors) != len(chunk):
                    raise ValueError(
                        "embedding model returned a different number of vectors than texts"
                    )
                if result.usage is not None:
                    self._call_usage[call_id] = result.usage
                for text, vector in zip(chunk, result.vectors, strict=True):
                    vector = tuple(vector)
                    self._remember(text, vector)
                    future = pending.get(text)
                    if future is not None and not future.done():
                        future.set_result(vector)
            except BaseException as error:  # noqa: BLE001 - every waiter sees the failure
                for text in chunk:
                    future = pending.get(text)
                    if future is not None and not future.done():
                        future.set_exception(error)
                if isinstance(error, asyncio.CancelledError):
                    raise

    def _remember(self, text: str, vector: EmbeddingVector) -> None:
        if self._cache_size <= 0:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


__all__ = [
    "DEFAULT_CACHE_SIZE",
    "DEFAULT_COALESCE_MS",
    "DEFAULT_MAX_BATCH_SIZE",
    "CoalescingEmbeddingModel",
]
