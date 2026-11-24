"""Shared fixtures: the repo's checked-in example trace, and builders for synthetic ones."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

EXAMPLE_RUN_ID = "run_9f2c14a03b71"


def repo_root() -> Path | None:
    """The AgenticReplay checkout containing this package, when it is present.

    The SDK is publishable on its own, so tests that read repo fixtures must be able to tell
    that they are running outside the repo rather than fail confusingly.
    """
    for parent in Path(__file__).resolve().parents:
        if (parent / "spec" / "agenticreplay-trace-v0.md").is_file():
            return parent
    return None


@pytest.fixture
def example_run() -> Path:
    root = repo_root()
    if root is None:
        pytest.skip("not running inside an AgenticReplay checkout")
    run = root / "examples" / "traces" / EXAMPLE_RUN_ID
    if not run.is_dir():
        pytest.skip(f"missing example trace {run}")
    return run


def write_trace(
    directory: Path,
    events: list[dict[str, Any]],
    *,
    manifest: dict[str, Any] | None = None,
    trailing: str = "",
    seal: bool = True,
    blobs: dict[str, bytes] | None = None,
    segments: int = 1,
) -> Path:
    """Write a minimal but schema-valid run directory, plus whatever damage a test asks for.

    `trailing` is appended verbatim after the last newline, which is how a crashed writer's
    half-line is reproduced (spec §2). `segments` above 1 splits the events across
    `events.jsonl` and `events.NNNNNN.jsonl` and records them in `integrity.segments`, which is
    what a rotated run looks like — the root still covers the concatenation.
    """
    directory.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(e, separators=(",", ":")) + "\n" for e in events]
    files: list[tuple[str, str]] = []
    if segments <= 1:
        files.append(("events.jsonl", "".join(lines) + trailing))
    else:
        size = max(1, -(-len(lines) // segments)) if lines else 1
        chunks = [lines[i : i + size] for i in range(0, len(lines), size)] or [[]]
        for position, chunk in enumerate(chunks, start=1):
            name = "events.jsonl" if position == 1 else f"events.{position:06d}.jsonl"
            text = "".join(chunk)
            if position == len(chunks):
                text += trailing
            files.append((name, text))
    for name, text in files:
        # newline="" or Windows rewrites every LF as CRLF on the way out, while the digest below is
        # taken over the LF form. The file then fails its own integrity check for a reason that has
        # nothing to do with the reader, which hashes bytes.
        (directory / name).write_text(text, encoding="utf-8", newline="")

    for digest, payload in (blobs or {}).items():
        shard = directory / "blobs" / digest[:2]
        shard.mkdir(parents=True, exist_ok=True)
        (shard / digest).write_bytes(payload)

    body = "".join(text for _name, text in files)
    doc: dict[str, Any] = {
        "schema_version": "0.4.0",
        "run_id": "run_abc123",
        "created_at": "2026-08-29T10:00:00.000Z",
        "agenticreplay_version": "0.1.0",
        "adapter": {"id": "test-adapter"},
        "argv": ["agent"],
        "cwd": "/work",
    }
    if seal:
        doc["integrity"] = {
            "events_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "blob_count": len(blobs or {}),
        }
        if len(files) > 1:
            recorded: list[dict[str, Any]] = []
            offset = 0
            for name, text in files:
                count = sum(1 for line in text.split("\n") if line.strip())
                recorded.append(
                    {
                        "name": name,
                        "first_seq": events[offset]["seq"] if count else 0,
                        "last_seq": events[offset + count - 1]["seq"] if count else 0,
                        "bytes": len(text.encode("utf-8")),
                        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    }
                )
                offset += count
            doc["integrity"]["segments"] = recorded
    if manifest is not None:
        doc.update(manifest)
    (directory / "manifest.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return directory


def event(seq: int, type_: str = "note", **over: Any) -> dict[str, Any]:
    """One schema-valid envelope. Mirrors the `ev()` helper in packages/core/test."""
    base: dict[str, Any] = {
        "seq": seq,
        "ts": "2026-08-29T10:00:00.000Z",
        "mono_us": seq * 1000,
        "turn": 0,
        "type": type_,
        "actor": "agenticreplay",
    }
    base.update(over)
    return base


def blob_of(data: bytes) -> tuple[str, str]:
    """(bare hex digest, `sha256:` ref) for content a test wants in the blob store."""
    hexdigest = hashlib.sha256(data).hexdigest()
    return hexdigest, f"sha256:{hexdigest}"
