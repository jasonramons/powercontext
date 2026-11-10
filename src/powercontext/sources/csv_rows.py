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

"""Row-level CSV Sources: one captured Source per primary-key row.

Each row becomes its own captured Source whose identity is derived from the
document id and the row's primary-key value, so a later edit elsewhere in the
file (or a reordering of records) does not change that row's identity. The
``powercontext.text-evidence`` projection renders the row as the canonical
JSON object used for retrieval and citation.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any
from urllib.parse import quote, unquote

from pydantic import BaseModel, ConfigDict

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence

CSV_ROW_SOURCE_NAME = "csv-row"

_SOURCE_ID_PREFIX = "csv"
_UTF8_BOM = "\ufeff"


class CSVDocumentInput(BaseModel):
    """One CSV document supplied as raw bytes plus the row key to capture."""

    model_config = ConfigDict(frozen=True)

    document_id: str
    primary_key: str
    content: bytes


class CSVRowInput(BaseModel):
    """One captured CSV row, addressed by its document id and primary key."""

    model_config = ConfigDict(frozen=True)

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


class CSVRowSource(Source):
    """A captured CSV row that can be projected as textual evidence."""

    source_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


def _require_document_id(document_id: object) -> str:
    if not isinstance(document_id, str) or not document_id:
        raise ValueError("document_id must be a non-empty string")
    if document_id != document_id.strip():
        raise ValueError("document_id must not contain leading or trailing whitespace")
    return document_id


def _require_primary_key(primary_key: object) -> str:
    # The primary key names a header column verbatim; surrounding spaces are
    # meaningful there (a header may legitimately be spelled " id ").
    if not isinstance(primary_key, str) or not primary_key:
        raise ValueError("primary_key must be a non-empty string")
    return primary_key


def csv_row_source_id(document_id: str, primary_key_value: str) -> str:
    """Return the stable identity of one CSV row.

    Both components are percent-encoded with an empty ``safe`` set, so the
    delimiter can never be produced by a component itself and the identity is
    injective for the pair.
    """

    document_id = _require_document_id(document_id)
    if not isinstance(primary_key_value, str) or primary_key_value == "":
        raise ValueError("primary_key_value must be a non-empty string")
    source_id = (
        f"{_SOURCE_ID_PREFIX}:{quote(document_id, safe='')}:"
        f"{quote(primary_key_value, safe='')}"
    )
    if len(source_id) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(
            f"csv row source id must not exceed {MAX_SOURCE_ID_LENGTH} characters"
        )
    return source_id


def _split_source_id(source_id: str) -> tuple[str, str]:
    parts = source_id.split(":")
    if len(parts) != 3 or parts[0] != _SOURCE_ID_PREFIX:
        raise ValueError(f"not a csv row source id: {source_id!r}")
    return unquote(parts[1]), unquote(parts[2])


def _iter_csv_records(text: str) -> list[list[str]]:
    stream = io.StringIO(text, newline="")
    try:
        return list(csv.reader(stream, strict=True))
    except csv.Error as exc:
        raise ValueError(f"malformed CSV document: {exc}") from exc


def parse_csv_document(value: CSVDocumentInput) -> tuple[CSVRowInput, ...]:
    """Parse one CSV document into one entry per primary-key row.

    The document must be strict UTF-8 (an optional BOM is stripped), the header
    must be non-empty, unique and free of blank names, and every record must
    match the header width. Any failure raises ``ValueError`` without returning
    partial rows.
    """

    document_id = _require_document_id(value.document_id)
    primary_key = _require_primary_key(value.primary_key)

    text = value.content.decode("utf-8")
    if text.startswith(_UTF8_BOM):
        text = text[len(_UTF8_BOM) :]
    if not text.strip():
        raise ValueError("CSV document is empty")

    records = _iter_csv_records(text)
    header = records[0] if records else []
    if not header:
        raise ValueError("CSV document must start with a header record")
    for name in header:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("CSV header names must be non-blank")
    if len(set(header)) != len(header):
        raise ValueError("CSV header names must be unique")
    if primary_key not in header:
        raise ValueError(f"primary key {primary_key!r} is not a CSV header column")
    key_index = header.index(primary_key)

    columns = tuple(header)
    rows: list[CSVRowInput] = []
    seen: set[str] = set()
    for record in records[1:]:
        if not record:
            continue
        if len(record) != len(columns):
            raise ValueError("CSV record width does not match the header")
        primary_key_value = record[key_index]
        if primary_key_value == "":
            raise ValueError("CSV primary key value must not be empty")
        if primary_key_value in seen:
            raise ValueError("CSV primary key values must be unique")
        seen.add(primary_key_value)
        csv_row_source_id(document_id, primary_key_value)
        rows.append(
            CSVRowInput(
                document_id=document_id,
                primary_key=primary_key,
                primary_key_value=primary_key_value,
                columns=columns,
                values=tuple(record),
            )
        )
    return tuple(rows)


def _row_mapping(source: CSVRowSource) -> dict[str, str]:
    return dict(zip(source.columns, source.values, strict=True))


class CSVRowSourceAdapter:
    """Resolve and read the row-level CSV Source."""

    input_class = CSVRowInput
    name = CSV_ROW_SOURCE_NAME
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        source_id = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(
            name=source_id,
            source_id=source_id,
            materialization=SourceMaterialization.CAPTURED,
            primary_key=value.primary_key,
            primary_key_value=value.primary_key_value,
            columns=value.columns,
            values=value.values,
        )

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        document_id, primary_key_value = _split_source_id(source.source_id)
        return CSVRowInput(
            document_id=document_id,
            primary_key=source.primary_key,
            primary_key_value=primary_key_value,
            columns=source.columns,
            values=source.values,
        )


class CSVRowTextEvidenceProjection:
    """Render one CSV row as the canonical textual evidence object."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = CSVRowSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = _row_mapping(source)
        document_id, _ = _split_source_id(source.source_id)
        metadata: dict[str, Any] = {
            "document_id": document_id,
            "primary_key": source.primary_key,
            "primary_key_value": source.primary_key_value,
            "columns": list(source.columns),
            "row": row,
        }
        return TextEvidence(
            source_type=CSV_ROW_SOURCE_NAME,
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata=metadata,
        )


CSV_ROW_SOURCE_DEFINITION: SourceDefinition[CSVRowInput, CSVRowSource, CSVRowInput] = (
    AdapterSourceDefinition(
        CSVRowSourceAdapter(),
        projections=(CSVRowTextEvidenceProjection(),),
    )
)


__all__ = [
    "CSV_ROW_SOURCE_DEFINITION",
    "CSV_ROW_SOURCE_NAME",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "csv_row_source_id",
    "parse_csv_document",
]
