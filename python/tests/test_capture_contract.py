import pytest

from agenticreplay_trace.models import Manifest, TraceEvent, TraceFormatError


def test_reader_keeps_capture_status_and_transformations():
    manifest = Manifest.from_json({
        "schema_version": "0.4.0", "run_id": "run_123abc",
        "created_at": "2026-10-10T00:00:00Z", "agenticreplay_version": "0.5.0",
        "adapter": {"id": "test"}, "argv": [], "cwd": "/tmp/example",
        "capture": {"status": "incomplete", "issues": ["storage_failure"]},
    })
    assert manifest.capture["status"] == "incomplete"
    audit = {"kind": "redaction", "location": "payload", "rule": "sk_api_key", "count": 1, "reason": "secret policy"}
    event = TraceEvent.from_json({
        "seq": 0, "ts": "2026-10-10T00:00:00Z", "mono_us": 0, "turn": 1,
        "type": "net.request", "actor": "agent", "transformations": [audit],
    })
    assert event.transformations == (audit,)


def test_legacy_manifest_is_rejected_explicitly():
    with pytest.raises(TraceFormatError, match="unsupported legacy format"):
        Manifest.from_json({"schema_version": "0.3.0"})
