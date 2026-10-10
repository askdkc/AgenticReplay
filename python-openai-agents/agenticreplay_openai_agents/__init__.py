"""Record the OpenAI Agents SDK's own run structure into an AgenticReplay trace.

Inert unless agenticreplay is recording: everything here keys off the `AGENTICREPLAY_AGENT_SPANS` environment
variable, which only `agenticreplay record` sets. See `processor` for what it captures and why it leaves the
model exchanges to the proxy.
"""

from .processor import KEEP_ENV, SPANS_ENV, AgenticReplayTracingProcessor, install

__all__ = ["AgenticReplayTracingProcessor", "install", "SPANS_ENV", "KEEP_ENV"]
__version__ = "0.1.0"
