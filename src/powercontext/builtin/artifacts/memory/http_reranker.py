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

"""Rerank Memory candidates with an external HTTP scoring service.

The service receives one batch of candidates per request and returns a score
per candidate rank. Batching is only a transport concern: the merged decision
orders the whole candidate pool, so a high-scoring candidate from a later batch
still wins.
"""

from __future__ import annotations

import math
from typing import Any

import httpx

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.artifacts.memory.reranking import (
    MemoryRerankDecision,
    MemoryReranker,
    _validate_bounds,
)
from powercontext.builtin.inference import InferenceUsage

DEFAULT_BATCH_SIZE = 32
DEFAULT_POLICY_ID = "cross-encoder-v1"

_SCORE_KEYS = frozenset({"rank", "score"})
_TopLevel_KEYS = frozenset({"scores"})


class HTTPMemoryReranker:
    """Score coarse Memory candidates through one HTTP reranking endpoint."""

    policy_id: str

    def __init__(
        self,
        endpoint: str,
        *,
        client: httpx.AsyncClient,
        batch_size: int = DEFAULT_BATCH_SIZE,
        policy_id: str = DEFAULT_POLICY_ID,
    ) -> None:
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("reranker endpoint must be a non-empty string")
        if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
            raise ValueError("reranker batch_size must be a positive integer")
        if not isinstance(policy_id, str) or not policy_id:
            raise ValueError("reranker policy_id must be a non-empty string")
        self._endpoint = endpoint
        self._client = client
        self._batch_size = batch_size
        self.policy_id = policy_id

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Return the globally best original ranks for one candidate pool."""

        _validate_bounds(len(candidates), limit)

        scores: dict[int, float] = {}
        requests = 0
        for start in range(0, len(candidates), self._batch_size):
            batch = candidates[start : start + self._batch_size]
            ranks = list(range(start + 1, start + 1 + len(batch)))
            payload = {
                "query": query,
                "candidates": [
                    {"rank": rank, "text": candidate.text}
                    for rank, candidate in zip(ranks, batch, strict=True)
                ],
            }
            response = await self._client.post(self._endpoint, json=payload)
            requests += 1
            scores.update(self._validate_response(response, ranks))

        ordered = sorted(scores, key=lambda rank: (-scores[rank], rank))[:limit]
        return MemoryRerankDecision(
            selected_ranks=tuple(ordered),
            usage=InferenceUsage(requests=requests),
        )

    def _validate_response(self, response: httpx.Response, ranks: list[int]) -> dict[int, float]:
        if response.status_code < 200 or response.status_code >= 300:
            raise ValueError(
                f"reranker returned HTTP {response.status_code} for candidates {ranks[0]}-{ranks[-1]}"
            )
        try:
            payload: Any = response.json()
        except ValueError as exc:
            raise ValueError(f"reranker response is not JSON: {exc}") from exc

        if not isinstance(payload, dict) or set(payload) != _TopLevel_KEYS:
            raise ValueError("reranker response must contain exactly the 'scores' field")
        entries = payload["scores"]
        if not isinstance(entries, list):
            raise ValueError("reranker 'scores' must be a list")

        expected = set(ranks)
        scores: dict[int, float] = {}
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != _SCORE_KEYS:
                raise ValueError("reranker score entries must contain exactly 'rank' and 'score'")
            rank = entry["rank"]
            score = entry["score"]
            if isinstance(rank, bool) or not isinstance(rank, int):
                raise ValueError("reranker rank must be an integer")
            if rank not in expected:
                raise ValueError(f"reranker returned an unexpected rank {rank}")
            if rank in scores:
                raise ValueError(f"reranker returned rank {rank} more than once")
            if isinstance(score, bool) or not isinstance(score, (int, float)):
                raise ValueError(f"reranker score for rank {rank} must be a number")
            value = float(score)
            if not math.isfinite(value):
                raise ValueError(f"reranker score for rank {rank} must be finite")
            scores[rank] = value

        if set(scores) != expected:
            missing = sorted(expected - set(scores))
            raise ValueError(f"reranker response is missing ranks {missing}")
        return scores


__all__ = [
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_POLICY_ID",
    "HTTPMemoryReranker",
]
