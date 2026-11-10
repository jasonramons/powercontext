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

"""Page-level Sources for complete PDF documents.

Every physical page of the original PDF becomes one captured Source.  The
Source identity binds the caller's document id, the complete file digest and
the physical page number, so a revised PDF yields new page identities while
old citations keep pointing at the revision they were captured from.  The
``powercontext.text-evidence`` projection stores ``DOCUMENT_ID`` followed by
the page text, which is what the fixed Memory pipeline indexes for retrieval.
"""

from __future__ import annotations

import hashlib
import io
import math
import re
import weakref
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pypdf import PdfReader

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence

if TYPE_CHECKING:
    from powercontext.builtin.artifacts.memory.models import MemoryCitation
    from powercontext.builtin.runtime.application import ScopedMemoryApplication

PDF_PAGE_SOURCE_NAME = "pdf-page"
PDF_PAGE_SOURCE_VERSION = "1"

_SOURCE_ID_PREFIX = "pdf"
_TOKEN = re.compile(r"[a-z]+|\d+")
_FY_TERM = re.compile(r"fy(\d{2,4})")
_QUERY_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "above",
        "after",
        "again",
        "against",
        "all",
        "also",
        "am",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "because",
        "been",
        "before",
        "being",
        "below",
        "between",
        "both",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "down",
        "during",
        "each",
        "few",
        "for",
        "from",
        "further",
        "had",
        "has",
        "have",
        "having",
        "he",
        "her",
        "here",
        "hers",
        "herself",
        "him",
        "himself",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "itself",
        "just",
        "me",
        "more",
        "most",
        "my",
        "myself",
        "no",
        "nor",
        "not",
        "now",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "our",
        "ours",
        "ourselves",
        "out",
        "over",
        "own",
        "please",
        "same",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "theirs",
        "them",
        "themselves",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "to",
        "too",
        "under",
        "until",
        "up",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "yours",
        "yourself",
        "yourselves",
    }
)
# Generic financial-report vocabulary.  These only bridge naming differences
# between a natural-language question and the document's own wording; they do
# not encode any document, question or answer.
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "acquisition": ("acquisitions", "divestiture", "m&a"),
    "acquisitions": ("acquisition", "divestitures"),
    "amortization": ("depreciation",),
    "battles": ("litigation", "proceedings", "claims"),
    "capex": ("capital", "expenditures", "purchases", "property", "plant", "equipment"),
    "concentration": ("customer", "customers"),
    "costs": ("cost", "charges", "expenses"),
    "customer": ("customers", "card members"),
    "customers": ("customer", "card members"),
    "cyclicality": ("cyclical", "economic conditions"),
    "depreciation": ("amortization",),
    "ebitda": ("operating", "income", "profit", "depreciation", "amortization"),
    "geographies": ("geographic", "geographic operations", "regions", "countries", "markets"),
    "geography": ("geographic", "geographic operations", "regions", "countries", "markets"),
    "legal": ("litigation", "proceedings", "claims", "regulatory", "lawsuits"),
    "litigation": ("legal", "proceedings", "claims"),
    "margin": ("percentage", "percent", "revenue", "sales"),
    "operate": ("operates", "operations", "businesses"),
    "operates": ("operate", "operations", "businesses"),
    "production": ("produce", "production rate", "deliveries"),
    "quantity": ("amount", "total"),
    "restructuring": ("severance", "productivity", "impairment", "charges"),
    "retain": ("retention", "retained", "customers"),
    "retained": ("retain", "retention"),
    "revenue": ("sales",),
    "sales": ("revenue",),
    "segment": ("segments", "business segment"),
    "segments": ("segment", "business segment"),
    "unadjusted": ("reported", "gaap"),
}
_STATEMENT_HINTS = (
    (
        (
            "consolidated statement of income",
            "consolidated statements of income",
            "consolidated statement of operations",
            "consolidated statements of operations",
            "statement of earnings",
        ),
        "income_statement",
    ),
    (("consolidated balance sheet", "consolidated balance sheets", "balance sheet"), "balance_sheet"),
    (
        ("consolidated statement of cash flows", "consolidated statements of cash flows", "statement of cash flows"),
        "cash_flow",
    ),
    (("summary of business segment data", "business segment data"), "segment"),
    (("statement of stockholders", "statement of equity"), "equity"),
)
# Question phrases that identify the section of a 10-K most likely to contain
# the evidence.  Each tuple is (question hints, section -> score multiplier).
_QUESTION_INTENTS: tuple[tuple[tuple[str, ...], dict[str, float]], ...] = (
    (
        (
            "quick ratio",
            "current ratio",
            "liquidity",
            "balance sheet",
            "day payable",
            "days payable",
            "dpo",
            "working capital",
        ),
        {"balance_sheet": 3.0},
    ),
    (
        (
            "gross margin",
            "operating margin",
            "margin",
            "revenue",
            "sales",
            "net income",
            "operating income",
            "effective tax rate",
            "tax rate",
            "p&l",
            "income statement",
            "ebitda",
        ),
        {"income_statement": 2.6},
    ),
    (
        (
            "cash flow",
            "operating activities",
            "investing activities",
            "financing activities",
            "capex",
            "capital expenditure",
        ),
        {"cash_flow": 2.6},
    ),
    (
        ("capital-intensive", "capital intensive"),
        {"balance_sheet": 2.0, "income_statement": 1.0, "cash_flow": 1.0},
    ),
    (("segment", "product categories", "service categories"), {"segment": 2.6}),
    (("product", "products", "service", "services", "industry", "business"), {"business": 1.2}),
    (("customer", "customers", "concentration", "card members"), {"business": 1.0, "risk": 0.5}),
    (("acquisition", "acquisitions", "m&a", "divestiture", "divestitures"), {"acquisitions": 2.6}),
    (("legal", "litigation", "battles"), {"legal": 2.6}),
)

_SEARCH_VARIANT_WEIGHTS = (3.0, 2.0)
_MAX_SEARCH_TERMS = 14
_RRF_CONSTANT = 60.0
_MIN_PAGE_TEXT_LENGTH = 24
_PAGE_INDEX_CACHE: weakref.WeakKeyDictionary[object, tuple[tuple[MemoryCitation, str, int], ...]] = (
    weakref.WeakKeyDictionary()
)


class PDFDocumentInput(BaseModel):
    """One complete PDF file supplied as raw bytes."""

    model_config = ConfigDict(frozen=True)

    document_id: str
    content: bytes


class PDFPageInput(BaseModel):
    """One physical page of a parsed PDF, addressed by document digest and page number."""

    model_config = ConfigDict(frozen=True)

    document_id: str
    document_sha256: str
    page_number: int = Field(ge=1)
    text: str

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str) -> str:
        _require_document_id(value)
        return value

    @field_validator("document_sha256")
    @classmethod
    def validate_document_sha256(cls, value: str) -> str:
        if len(value) != 64 or value.lower() != value:
            raise ValueError("document_sha256 must be a lowercase SHA-256 hex digest")  # noqa: TRY003
        try:
            int(value, 16)
        except ValueError as error:
            raise ValueError("document_sha256 must be a lowercase SHA-256 hex digest") from error  # noqa: TRY003
        return value


class PDFPageSource(Source):
    """A captured PDF page that can be projected as textual evidence."""

    source_id: str
    document_id: str
    document_sha256: str
    page_number: int
    text: str


def _require_document_id(document_id: object) -> str:
    if not isinstance(document_id, str) or not document_id.strip():
        raise ValueError("document_id must be a non-empty string")  # noqa: TRY003
    return document_id


def pdf_page_source_id(document_id: str, document_sha256: str, page_number: int) -> str:
    """Return the immutable identity of one physical PDF page.

    The identity is a digest of the complete triple.  A fixed-length digest
    keeps the Source id well below the catalog's 256-character bound even for
    very long caller document ids, while remaining deterministic and stable
    across processes and revisions.
    """

    _require_document_id(document_id)
    if not isinstance(document_sha256, str) or not document_sha256:
        raise ValueError("document_sha256 must be a non-empty string")  # noqa: TRY003
    if not isinstance(page_number, int) or isinstance(page_number, bool) or page_number < 1:
        raise ValueError("page_number must be a positive integer")  # noqa: TRY003
    identity = f"{document_id}\x00{document_sha256}\x00{page_number}".encode("utf-8")
    source_id = f"{_SOURCE_ID_PREFIX}-page:{hashlib.sha256(identity).hexdigest()}"
    if len(source_id) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(f"pdf page source id must not exceed {MAX_SOURCE_ID_LENGTH} characters")  # noqa: TRY003
    return source_id


def _read_pages(content: bytes) -> list[str]:
    """Extract every physical page, failing atomically on any read error."""

    if not isinstance(content, (bytes, bytearray)) or not content:
        raise ValueError("PDF document is empty")  # noqa: TRY003
    raw = bytes(content)
    if not raw.lstrip().startswith(b"%PDF-"):
        raise ValueError("document is not a PDF file")  # noqa: TRY003

    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            # A PDF without a user password is legitimate input; an actual
            # password-protected file must not be silently accepted.
            if reader.decrypt("") == 0:
                raise ValueError("PDF document requires a password")  # noqa: TRY003
        pages = reader.pages
        page_count = len(pages)
        if page_count < 1:
            raise ValueError("PDF document contains no pages")  # noqa: TRY003
        texts = []
        for index in range(page_count):
            text = pages[index].extract_text()
            texts.append("" if text is None else text.strip())
    except ValueError:
        raise
    except Exception as error:  # pypdf raises a variety of parser-specific errors.
        raise ValueError(f"invalid or corrupt PDF document: {error}") from error
    return texts


def parse_pdf_document(value: PDFDocumentInput) -> tuple[PDFPageInput, ...]:
    """Parse one complete PDF into one entry per physical page, in order.

    Blank pages are retained with empty text.  Any unreadable, encrypted or
    malformed document fails with :class:`ValueError` before any page is
    returned, so callers never persist a partial document.
    """

    document_id = _require_document_id(value.document_id)
    digest = hashlib.sha256(value.content).hexdigest()
    texts = _read_pages(value.content)
    if not texts:
        raise ValueError("PDF document contains no pages")  # noqa: TRY003
    return tuple(
        PDFPageInput(
            document_id=document_id,
            document_sha256=digest,
            page_number=page_number,
            text=text,
        )
        for page_number, text in enumerate(texts, start=1)
    )


class PDFPageSourceAdapter:
    """Resolve and read the captured page Source."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        source_id = pdf_page_source_id(value.document_id, value.document_sha256, value.page_number)
        return PDFPageSource(
            name=source_id,
            source_id=source_id,
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Render one PDF page as the canonical textual evidence object."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_NAME,
            source_id=source.source_id,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION: SourceDefinition[PDFPageInput, PDFPageSource, PDFPageInput] = AdapterSourceDefinition(
    PDFPageSourceAdapter(),
    version=PDF_PAGE_SOURCE_VERSION,
    projections=(PDFPageTextEvidenceProjection(),),
)


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.casefold())


def _normalize_term(term: str) -> str:
    match = _FY_TERM.fullmatch(term)
    if match is None:
        return term
    digits = match.group(1)
    if len(digits) == 2:
        value = int(digits)
        return f"20{digits}" if value < 70 else f"19{digits}"
    return digits


def _content_terms(question: str) -> list[str]:
    """Return distinct, order-preserving content terms from one question."""

    terms: list[str] = []
    seen: set[str] = set()
    for raw in _TOKEN.findall(question.casefold()):
        term = _normalize_term(raw)
        if term in seen or term in _QUERY_STOPWORDS or (len(term) == 1 and not term.isdigit()):
            continue
        seen.add(term)
        terms.append(term)
    return terms


def _question_bigrams(question: str) -> tuple[tuple[str, str], ...]:
    """Build contiguous content-word bigrams used as phrase evidence."""

    words = [
        _normalize_term(term)
        for term in _TOKEN.findall(question.casefold())
        if term not in _QUERY_STOPWORDS
    ]
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for left, right in zip(words, words[1:]):
        pair = (left, right)
        if pair not in seen:
            seen.add(pair)
            pairs.append(pair)
    return tuple(pairs)


def _page_body(text: str) -> str:
    """Drop the leading document-id line from one indexed entry body."""

    _, separator, body = text.partition("\n")
    return body if separator else ""


def _page_sections(page: str) -> set[str]:
    head = " ".join(page[:900].casefold().split())
    sections = {name for hints, name in _STATEMENT_HINTS if any(hint in head for hint in hints)}
    if "business segment" in head or "segment data" in head:
        sections.add("segment")
    if "management" in head and "discussion" in head:
        sections.add("md&a")
    if "results of operations" in head:
        sections.add("md&a")
    if "legal proceedings" in head:
        sections.add("legal")
    if "risk factors" in head:
        sections.add("risk")
    if "item 1" in head and "business" in head:
        sections.add("business")
    if "acquisition" in head:
        sections.add("acquisitions")
    return sections


def _question_intents(question: str) -> dict[str, float]:
    text = " ".join(question.casefold().split())
    boosts: dict[str, float] = {}
    for hints, weights in _QUESTION_INTENTS:
        if any(hint in text for hint in hints):
            for section, weight in weights.items():
                boosts[section] = max(boosts.get(section, 0.0), weight)
    return boosts


@dataclass(frozen=True, slots=True)
class _Page:
    citation: MemoryCitation
    body: str
    tokens: tuple[str, ...]
    counts: Counter[str]
    length: int
    sections: frozenset[str]


def _build_pages(entries: Iterable[Any]) -> tuple[_Page, ...]:
    pages: list[_Page] = []
    for entry in entries:
        sources = getattr(entry.entry, "sources", ())
        if sources and not all(getattr(source, "source_type", "") == PDF_PAGE_SOURCE_NAME for source in sources):
            continue
        body = _page_body(entry.entry.text)
        if len(body.strip()) < _MIN_PAGE_TEXT_LENGTH:
            continue
        tokens = _tokens(body)
        pages.append(
            _Page(
                citation=entry.citation,
                body=body,
                tokens=tuple(tokens),
                counts=Counter(tokens),
                length=len(tokens),
                sections=frozenset(_page_sections(body)),
            )
        )
    return tuple(pages)


def _score_pages(pages: Sequence[_Page], question: str) -> list[float]:
    terms = _content_terms(question)
    expanded: dict[str, float] = {term: 1.0 for term in terms}
    for term in terms:
        for synonym in _SYNONYMS.get(term, ()):
            for token in _tokens(synonym):
                expanded[token] = max(expanded.get(token, 0.0), 0.5)
    total = len(pages)
    average = sum(page.length for page in pages) / total or 1.0
    document_frequency: Counter[str] = Counter()
    for page in pages:
        for term in page.counts:
            document_frequency[term] += 1
    inverse_frequency = {
        term: math.log(1.0 + (total - document_frequency[term] + 0.5) / (document_frequency[term] + 0.5))
        for term in expanded
    }
    pairs = _question_bigrams(question)
    numeric = any(
        word in question.casefold()
        for word in (
            "ebitda",
            "margin",
            "capex",
            "capital",
            "amount",
            "quantity",
            "how much",
            "calculate",
            " usd",
            "million",
            "percent",
            "%",
            "ratio",
        )
    )
    wanted = _question_intents(question)
    scores: list[float] = []
    for page in pages:
        score = 0.0
        for term, weight in expanded.items():
            frequency = page.counts.get(term, 0)
            if frequency:
                denominator = frequency + 1.2 * (1.0 - 0.75 + 0.75 * page.length / average)
                score += weight * inverse_frequency[term] * frequency * 2.2 / denominator
        compact = " ".join(page.body.casefold().split())
        score += 0.8 * sum(1 for left, right in pairs if f"{left} {right}" in compact)
        score += 0.5 * sum(1 for term in terms if term in page.tokens[:60])
        if numeric and page.length > 10:
            digits = sum(1 for token in page.tokens if token.isdigit())
            score += 0.8 * min(1.0, (digits / page.length) / 0.3)
        for section, weight in wanted.items():
            if section in page.sections:
                score += 3.0 * weight
        scores.append(score)
    return scores


def _rank_pages(pages: Sequence[_Page], question: str, limit: int) -> tuple[MemoryCitation, ...]:
    scores = _score_pages(pages, question)
    ordered = sorted(zip(scores, pages), key=lambda item: (-item[0], item[1].citation.entry_id))
    return tuple(page.citation for _score, page in ordered[:limit])


async def _page_index(memory: object) -> tuple[_Page, ...] | None:
    """Read the scoped page set once and cache the derived lexical index."""

    try:
        cached = _PAGE_INDEX_CACHE.get(memory)
    except TypeError:
        cached = None
    if cached is not None:
        return cached
    lister = getattr(memory, "list", None)
    if lister is None:
        return None
    try:
        page = await lister()
    except Exception:
        return None
    entries = getattr(page, "entries", ())
    if not entries:
        return None
    try:
        pages = _build_pages(entries)
    except Exception:
        return None
    if not pages:
        return None
    try:
        _PAGE_INDEX_CACHE[memory] = pages
    except TypeError:
        pass
    return pages


async def _search_candidates(
    memory: ScopedMemoryApplication,
    question: str,
    terms: Sequence[str],
    limit: int,
) -> tuple[MemoryCitation, ...]:
    """Fallback retrieval through the public Memory search API."""

    from powercontext.builtin.runtime import SearchMemoryRequest

    variants: list[str] = []
    normalized = " ".join(question.split())
    if normalized:
        variants.append(normalized)
    keyword_query = " ".join(terms[:_MAX_SEARCH_TERMS])
    if keyword_query and keyword_query not in variants:
        variants.append(keyword_query)
    candidate_limit = max(64, min(240, limit * 10))
    candidates: dict[str, tuple[MemoryCitation, float]] = {}
    for variant_index, query in enumerate(variants + list(terms[:_MAX_SEARCH_TERMS])):
        weight = _SEARCH_VARIANT_WEIGHTS[0] if variant_index == 0 else (
            _SEARCH_VARIANT_WEIGHTS[1] if variant_index == 1 else 1.0
        )
        page = await memory.search(SearchMemoryRequest(query=query, mode="fts", limit=candidate_limit))
        for rank, hit in enumerate(page.hits, start=1):
            body = _page_body(hit.text)
            if len(body.strip()) < _MIN_PAGE_TEXT_LENGTH:
                continue
            key = f"{hit.memory_ref.artifact_id}\x00{hit.entry_id}"
            current = candidates.get(key)
            addition = weight / (_RRF_CONSTANT + rank)
            if current is None:
                from powercontext.builtin.artifacts.memory.models import MemoryCitation

                candidates[key] = (
                    MemoryCitation(
                        memory_ref=hit.memory_ref,
                        entry_id=hit.entry_id,
                        entry_version_id=hit.entry_version_id,
                    ),
                    addition,
                )
            else:
                candidates[key] = (current[0], current[1] + addition)
    ordered = sorted(candidates.values(), key=lambda item: (-item[1], item[0].entry_id))
    return tuple(citation for citation, _score in ordered[:limit])


async def search_pdf_pages(
    memory: ScopedMemoryApplication,
    question: str,
    limit: int = 10,
) -> tuple[MemoryCitation, ...]:
    """Search one scoped Memory and return exact, distinct PDF-page citations.

    The scoped Memory is read through its public API to build a page-level
    lexical index once per scope; each question is then ranked locally by
    term evidence, query coverage, phrase matches and the section a financial
    report question asks about.  Only citations backed by real Memory entries
    are returned, and a Memory implementation without the listing capability
    falls back to its public search API.
    """

    if limit < 1 or not isinstance(question, str) or not question.strip():
        return ()
    terms = _content_terms(question)
    if not terms:
        return ()
    pages = await _page_index(memory)
    if pages:
        return _rank_pages(pages, question, limit)
    return await _search_candidates(memory, question, terms, limit)


__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDF_PAGE_SOURCE_NAME",
    "PDF_PAGE_SOURCE_VERSION",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "parse_pdf_document",
    "pdf_page_source_id",
    "search_pdf_pages",
]
