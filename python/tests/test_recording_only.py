"""The installed reader exposes viewing APIs and retains legacy log fields only for reading."""

import agenticreplay_trace as sdk


def test_public_surface_contains_no_reexecution_helpers():
    assert {"Checkpoint", "derive_checkpoints", "snap_to_checkpoint"}.isdisjoint(sdk.__all__)
    for name in ("Checkpoint", "derive_checkpoints", "snap_to_checkpoint"):
        assert not hasattr(sdk, name)
    assert {"TraceReader", "turns_of", "causal_chain"}.issubset(sdk.__all__)


def test_legacy_fork_fields_and_events_remain_readable():
    raw = {
        "schema_version": "0.4.0", "run_id": "run_123abc",
        "created_at": "2026-10-10T00:00:00Z", "agenticreplay_version": "0.1.4",
        "adapter": {"id": "test"}, "argv": [], "cwd": "/tmp/example",
        "parent_run": "run_456def", "fork_point": 3, "fork_model": "old-model",
    }
    manifest = sdk.Manifest.from_json(raw)
    assert (manifest.parent_run, manifest.fork_point, manifest.fork_model) == (
        "run_456def", 3, "old-model",
    )
    for kind in ("checkpoint", "fork", "fs.snapshot", "divergence"):
        event = sdk.TraceEvent.from_json({
            "seq": 0, "ts": "2026-10-10T00:00:00Z", "mono_us": 0,
            "turn": 0, "type": kind, "actor": "agenticreplay",
        })
        assert event.type == kind
