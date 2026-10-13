"""Derived viewing structure over a trace: turns and causal chains."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from collections.abc import Iterable

from .models import TraceEvent

__all__ = ["Turn", "causal_chain", "turns_of"]


@dataclass(frozen=True, slots=True)
class Turn:
    """The events of one model turn, in log order."""

    turn: int
    start_seq: int
    end_seq: int
    events: tuple[TraceEvent, ...] = field(default_factory=tuple)


def _by_seq(events: Iterable[TraceEvent]) -> list[TraceEvent]:
    """A copy in total order. The caller's sequence is never reordered in place."""
    return sorted(events, key=lambda e: e.seq)


def turns_of(events: Iterable[TraceEvent]) -> list[Turn]:
    """The events of a run grouped into model turns, in turn order."""
    buckets: dict[int, list[TraceEvent]] = {}
    for event in _by_seq(events):
        buckets.setdefault(event.turn, []).append(event)
    return [
        Turn(turn=turn, start_seq=group[0].seq, end_seq=group[-1].seq, events=tuple(group))
        for turn, group in sorted(buckets.items())
    ]


def causal_chain(events: Iterable[TraceEvent], seq: int) -> list[TraceEvent]:
    """The event at `seq` and everything transitively named by `causes`, oldest first."""
    index = {e.seq: e for e in events}
    start = index.get(seq)
    if start is None:
        raise ValueError(f"no event with seq {seq} in this trace")

    seen = {seq}
    queue = deque([start])
    chain: list[TraceEvent] = []
    while queue:
        event = queue.popleft()
        chain.append(event)
        for cause in event.causes:
            # A cycle is malformed, and an ancestor may be missing because the reader skipped an
            # unknown event type. Neither may stop the walk.
            if cause in seen:
                continue
            seen.add(cause)
            parent = index.get(cause)
            if parent is not None:
                queue.append(parent)
    return sorted(chain, key=lambda e: e.seq)
