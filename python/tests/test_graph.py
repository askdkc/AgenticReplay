"""Turn grouping and causal chains agree with the TypeScript viewing contract."""

from __future__ import annotations

from typing import Any

import pytest

from agenticreplay_trace import TraceEvent, causal_chain, turns_of


def ev(seq: int, type_: str, **over: Any) -> TraceEvent:
    raw: dict[str, Any] = {
        "seq": seq,
        "ts": "2026-08-29T10:00:00.000Z",
        "mono_us": seq * 1000,
        "turn": 0,
        "type": type_,
        "actor": "agenticreplay",
    }
    raw.update(over)
    return TraceEvent.from_json(raw)


class TestTurnsOf:
    def test_groups_events_into_turns_with_their_span(self) -> None:
        events = [ev(0, "run.start"), ev(1, "note"), ev(2, "note", turn=1), ev(3, "run.end", turn=1)]
        turns = turns_of(events)
        assert [(t.turn, t.start_seq, t.end_seq) for t in turns] == [(0, 0, 1), (1, 2, 3)]
        assert [e.seq for e in turns[1].events] == [2, 3]

    def test_orders_turns_numerically_even_when_the_log_interleaves_them(self) -> None:
        events = [ev(0, "note", turn=2), ev(1, "note", turn=1), ev(2, "note", turn=2)]
        assert [t.turn for t in turns_of(events)] == [1, 2]
        assert len(turns_of(events)[1].events) == 2

    def test_handles_an_empty_trace(self) -> None:
        assert turns_of([]) == []


class TestCausalChain:
    EVENTS = [
        ev(0, "run.start"),
        ev(1, "model.request", causes=[0]),
        ev(2, "model.response", causes=[1]),
        ev(3, "tool.call", causes=[2]),
        ev(4, "note"),
    ]

    def test_walks_causes_transitively_oldest_first(self) -> None:
        assert [e.seq for e in causal_chain(self.EVENTS, 3)] == [0, 1, 2, 3]

    def test_returns_just_the_event_when_nothing_caused_it(self) -> None:
        assert [e.seq for e in causal_chain(self.EVENTS, 4)] == [4]

    def test_visits_a_shared_ancestor_once(self) -> None:
        diamond = [
            ev(0, "run.start"),
            ev(1, "tool.call", causes=[0]),
            ev(2, "tool.call", causes=[0]),
            ev(3, "note", causes=[1, 2]),
        ]
        assert [e.seq for e in causal_chain(diamond, 3)] == [0, 1, 2, 3]

    def test_terminates_on_a_malformed_cycle_instead_of_hanging(self) -> None:
        cyclic = [ev(0, "note", causes=[1]), ev(1, "note", causes=[0])]
        assert [e.seq for e in causal_chain(cyclic, 1)] == [0, 1]

    def test_skips_a_cause_that_is_not_in_the_trace(self) -> None:
        """Readers drop unknown event types, so an ancestor may legitimately be missing."""
        gapped = [ev(0, "run.start"), ev(2, "note", causes=[1, 0])]
        assert [e.seq for e in causal_chain(gapped, 2)] == [0, 2]

    def test_reports_a_seq_that_is_not_in_the_trace(self) -> None:
        with pytest.raises(ValueError, match="42"):
            causal_chain(self.EVENTS, 42)
