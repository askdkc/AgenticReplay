"""Read-only Python SDK for the AgenticReplay trace format v0.

Read-only is a boundary, not a missing feature: the TypeScript writer is the one implementation
of the write path, and a second writer would mean a second redaction implementation — which is
how a secret leaks. Everything here reads a trace someone else recorded.

    from agenticreplay_trace import TraceReader, turns_of

    reader = TraceReader.open(".agenticreplay/runs/run_9f2c14a03b71")
    events = reader.events()
    turns = turns_of(events)
"""

from __future__ import annotations

from .graph import Turn, causal_chain, turns_of
from .models import (
    ACTORS,
    BLOB_REF_PATTERN,
    EVENT_TYPES,
    INLINE_PAYLOAD_LIMIT,
    RUN_ID_PATTERN,
    SCHEMA_VERSION,
    BlobRef,
    Manifest,
    AgenticReplayTraceError,
    TraceEvent,
    TraceFormatError,
)
from .reader import BlobIntegrityError, BlobNotFoundError, NotATraceError, TraceReader

__version__ = "0.1.0"

__all__ = [
    "ACTORS",
    "BlobIntegrityError",
    "BlobNotFoundError",
    "BLOB_REF_PATTERN",
    "EVENT_TYPES",
    "INLINE_PAYLOAD_LIMIT",
    "RUN_ID_PATTERN",
    "SCHEMA_VERSION",
    "BlobRef",
    "Manifest",
    "NotATraceError",
    "AgenticReplayTraceError",
    "TraceEvent",
    "TraceReader",
    "TraceFormatError",
    "Turn",
    "__version__",
    "causal_chain",
    "turns_of",
]
