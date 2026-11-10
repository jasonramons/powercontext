"""离线确定性文本向量。

评审环境不联网、也没有 embedding 模型，所以这里用特征哈希把文本映射到固定
维度的向量：拉丁词、中文二元组、单字分别加权后 L2 归一化。它不追求语义理解，
只保证「任务里的领域词」能在向量空间里靠近包含同一批词的规格/代码/测试片段，
并且在任何机器上得到同一个向量（同一份输入 → 同一个结果，可复现）。
"""

from __future__ import annotations

import math
import re

DIM = 256

_WORD = re.compile(r"[a-z0-9_]{2,}")
_CJK = re.compile(r"[\u4e00-\u9fa5]")


def _fnv1a(text: str) -> int:
    digest = 0x811C9DC5
    for char in text:
        digest ^= ord(char)
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return digest


def _add(vector: list[float], token: str, weight: float) -> None:
    hashed = _fnv1a(token)
    index = hashed % DIM
    vector[index] += weight if (hashed >> 8) & 1 else -weight


def embed(text: str) -> list[float]:
    """把任意文本映射成 ``DIM`` 维单位向量。"""
    vector = [0.0] * DIM
    lowered = str(text or "").lower()

    for word in _WORD.findall(lowered):
        _add(vector, "w:" + word, 1.0)

    cjk = "".join(_CJK.findall(lowered))
    for index in range(len(cjk) - 1):
        _add(vector, "b:" + cjk[index:index + 2], 1.2)
    for char in cjk:
        _add(vector, "c:" + char, 0.25)

    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def to_sql_literal(vector: list[float]) -> str:
    """seekdb 的 VECTOR 列接受 ``[0.1,0.2,...]`` 字符串字面量。"""
    return "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))
