import { createHash } from 'node:crypto';
import type {
  CanonicalContent,
  CanonicalRequest,
  CanonicalResponse,
} from '@agenticreplay/plugin-api';
import type { RecordedExchange } from '@agenticreplay/proxy';
import type { TraceWriter } from '@agenticreplay/core';
import type { TraceEvent } from '@agenticreplay/schema';

/**
 * Turning intercepted model exchanges into trace events.
 *
 * This is where the project's central observation is cashed in. A tool result never appears in the
 * response that requested it — the harness runs the tool and hands the result back on the *next*
 * request. So we hold each `tool_use` open and close it when a later request carries the matching
 * `tool_result`, which is how a proxy that only sees model traffic still reconstructs the whole
 * tool loop without touching the agent.
 *
 * The consequence to keep in mind: a tool call whose result never comes back (the run ended, the
 * agent crashed) stays unresolved, and `unresolved()` reports it rather than silently dropping it.
 */

export interface PendingToolCall {
  id: string;
  name: string;
  /** seq of the tool.call event, so the tool.result can point back at it. */
  seq: number;
  turn: number;
}

export interface DerivedEvent {
  type:
    | 'model.request'
    | 'model.response'
    | 'model.thinking'
    | 'tool.call'
    | 'tool.result'
    | 'retrieval.context';
  actor: 'agent' | 'model' | 'harness';
  attrs: Record<string, unknown>;
  payload?: unknown;
  /** Persisted call this observed result answers. */
  callSeq?: number;
  /** Private deduplication key for unlinked observations. Never written as event content. */
  unmatchedKey?: string;
  contextFingerprint?: string;
  /**
   * Positions of earlier events *in this same batch* that caused this one.
   *
   * Seqs do not exist until the writer has appended, so the deriver cannot name them. It names
   * positions in the array it is about to return instead, and the recorder swaps each one for the
   * seq it wrote. Both edges this carries are observed rather than inferred: a `tool_use` block is
   * inside the response that emitted it, and a `tool_result` block is inside the request that
   * carried it back.
   */
  causesIndex?: number[];
}

// Chat Completions has no tool-error flag. MoDKH puts the execution status in
// a JSON envelope around stdout; leave arbitrary tool output uninterpreted.
function hasErrorReceipt(content: string): boolean {
  if (!content.startsWith('{') || !content.includes('"error"')) return false;
  try {
    const receipt = JSON.parse(content);
    return (
      receipt.status === 'error' &&
      typeof receipt.output === 'string' &&
      Object.keys(receipt).length === 2
    );
  } catch {
    return false;
  }
}

interface SavedCall extends PendingToolCall {
  signature?: string;
  closed: boolean;
}

function matchCall(calls: SavedCall[], echo: string | undefined): SavedCall | undefined {
  if (calls.length <= 1) return calls[0];
  // An omitted or redacted input could match any echo. Closing either attempt would be a guess.
  if (!echo || calls.some((call) => call.signature === undefined)) return;
  const matching = calls.filter((call) => call.signature === echo);
  if (matching.length === 1) return matching[0];
}

export class ExchangeEventDeriver {
  // Keep each persisted call occurrence, including closed ones: a resent result for an
  // earlier attempt must not answer a newer call that happens to reuse its provider ID.
  readonly #calls = new Map<string, SavedCall[]>();
  readonly #unmatched = new Set<string>();
  /**
   * Retrieval contexts already emitted, by fingerprint.
   *
   * A conversation is resent in full every turn, so without this a multi-turn RAG session would
   * re-emit the first turn's passages on every request after it.
   */
  readonly #seenContext = new Set<string>();

  /** Saved call occurrences for which no matching result was persisted. */
  unresolved(): PendingToolCall[] {
    return Array.from(this.#calls.values()).flatMap((calls) =>
      calls.filter((call) => !call.closed),
    );
  }

  /**
   * Derive the events for one exchange. Returns them in the order they should be appended;
   * `tool.result` events come first because they describe work that happened *before* this
   * request was made.
   */
  derive(exchange: RecordedExchange, turn: number): DerivedEvent[] {
    const events: DerivedEvent[] = [];
    /** Where the results this batch produced ended up, so the request can name them. */
    const resultsAt: number[] = [];

    // What the retriever found, before the request that carried it — same order and the same
    // reason as a tool result: it describes work that happened before this call was made, and the
    // request names it as a cause. Derived rather than captured, because it is already on the
    // wire: the passages are in the prompt. See `retrievalContext`.
    const retrieved = retrievalContext(exchange.canonicalRequest);
    if (retrieved && !this.#seenContext.has(retrieved.fingerprint)) {
      events.push({
        contextFingerprint: retrieved.fingerprint,
        type: 'retrieval.context',
        // The harness retrieved these; agenticreplay only read them out of what it sent.
        actor: 'harness',
        attrs: {
          query: retrieved.query,
          passages: retrieved.passages.length,
          chars: retrieved.passages.reduce((n, p) => n + p.length, 0),
          // Named so a reader knows the boundaries are the prompt's, not the retriever's: this
          // is what was *used*, which `--context-docs` truncates out of what was *retrieved*.
          derived_from: 'prompt',
        },
        payload: { query: retrieved.query, passages: retrieved.passages },
      });
      resultsAt.push(events.length - 1);
    }

    const toolResults = this.deriveToolResults(
      exchange.canonicalRequest,
      exchange.dialect === 'codex' || exchange.dialect === 'openai-responses'
        ? 'known-or-trailing'
        : exchange.dialect === 'openai'
          ? 'trailing-users'
          : 'trailing',
    );
    for (const result of toolResults) {
      resultsAt.push(events.length);
      events.push(result);
    }

    events.push({
      type: 'model.request',
      actor: 'agent',
      attrs: {
        ...(exchange.requestId ? { request_id: exchange.requestId } : {}),
        model: exchange.canonicalRequest.model,
        dialect: exchange.dialect,
        path: exchange.path,
        messages: exchange.canonicalRequest.messages.length,
        tools: exchange.canonicalRequest.tools?.length ?? 0,
        // Only where agenticreplay established the connection and therefore knows. Absent reads as "not
        // recorded" rather than as HTTP/1.1, which is why it is left off instead of defaulted.
        ...(exchange.alpn === undefined ? {} : { alpn: exchange.alpn }),
      },
      payload: exchange.rawRequest,
      // Absent rather than empty when nothing came back: an edge list naming nothing is noise a
      // reader has to interpret, and `causes` is optional precisely so it can be left off.
      ...(resultsAt.length > 0 ? { causesIndex: resultsAt } : {}),
    });
    const requestAt = events.length - 1;

    const response = exchange.canonicalResponse;
    events.push({
      // The edge every other request/response pair already had. Without it `agenticreplay graph --to` on a
      // model.response walks backwards, finds no incoming edge, and reports that the run has no
      // causal edges at all -- on a run whose graph is otherwise full of them. `net.response`,
      // `tool.result` and `shell.result` all name what they answered; this is the same fact about
      // the pair the recorder watched most directly.
      causesIndex: [requestAt],
      type: 'model.response',
      actor: 'model',
      attrs: {
        ...(exchange.requestId ? { request_id: exchange.requestId } : {}),
        model: response?.model ?? exchange.canonicalRequest.model,
        stop_reason: response?.stop_reason ?? 'unknown',
        input_tokens: response?.usage.input_tokens ?? 0,
        output_tokens: response?.usage.output_tokens ?? 0,
        status: exchange.status,
        duration_ms: exchange.durationMs ?? 0,
        streamed: exchange.streamed,
        // The payload below is the decoded body, so the encoding it arrived in is recorded here or
        // nowhere: a promoted exchange keeps no response headers.
        ...(exchange.responseDecodedFrom === undefined
          ? {}
          : { decoded_from: exchange.responseDecodedFrom }),
        // Who answered. The trace said what was sent and what came back and never this, which is
        // the first question asked of a recording that looks wrong — a gateway left behind in
        // `~/.agenticreplay/config.json` redirects every run on the machine, and nothing in the run said so.
        // On the response because it is a fact about the answer, and per exchange rather than in
        // the manifest because the origin is chosen per request: a fork that changes provider
        // changes it again mid-run. Absent means an older agenticreplay did not record it, never "the
        // vendor's own API".
        ...(exchange.upstream === undefined ? {} : { upstream: exchange.upstream }),
      },
      payload: exchange.rawResponse,
    });
    const responseAt = events.length - 1;

    // The reasoning a reply carries — Anthropic `thinking` blocks, OpenAI `reasoning_content` and
    // Responses reasoning summaries all arrive here as canonical `thinking` blocks — is inside the
    // raw payload but buried in the wire shape. Log it decoded, one event per reasoned turn,
    // pointing at the response it came from; a turn without reasoning logs nothing.
    const thinking = collectThinking(response);
    if (thinking !== '') {
      events.push({
        type: 'model.thinking',
        actor: 'model',
        attrs: { chars: thinking.length },
        payload: thinking,
        causesIndex: [responseAt],
      });
    }

    for (const use of collectToolUses(response)) {
      events.push({
        type: 'tool.call',
        actor: 'model',
        attrs: { tool_use_id: use.id, name: use.name, input: use.input },
        causesIndex: [responseAt],
      });
    }

    return events;
  }

  deriveToolResults(
    request: CanonicalRequest,
    scope: 'known' | 'known-or-trailing' | 'trailing' | 'trailing-users',
  ): DerivedEvent[] {
    const trailing = request.messages.at(-1);
    let start = scope === 'trailing' ? Math.max(0, request.messages.length - 1) : 0;
    if (scope === 'trailing-users') {
      // Chat Completions can follow tool receipts with a separate user image observation.
      start = request.messages.length;
      while (start > 0 && request.messages[start - 1]?.role === 'user') start--;
    }
    const events: DerivedEvent[] = [];
    // Responses sends each result as a separate input item, sometimes followed by
    // compaction or reasoning. Scan earlier items only for calls this run observed.
    const emitted = new Set<number | string>();
    const echoed = new Map<string, string | undefined>();
    for (let index = 0; index < request.messages.length; index++) {
      const message = request.messages[index]!;
      if (message.role === 'assistant') {
        if (request.messages[index - 1]?.role !== 'assistant') echoed.clear();
        for (const block of message.content) {
          if (block.type === 'tool_use' && (this.#calls.get(block.id)?.length ?? 0) > 1) {
            echoed.set(
              block.id,
              echoed.has(block.id) ? undefined : callSignature(block.name, block.input),
            );
          }
        }
        continue;
      }
      if (index < start) continue;
      for (const result of message.content) {
        if (result.type !== 'tool_result' || !result.tool_use_id) continue;
        const id = result.tool_use_id;
        const calls = this.#calls.get(id) ?? [];
        if (!calls.length && (scope === 'known' || message !== trailing)) continue;
        const call = matchCall(calls, echoed.get(id));
        if (call?.closed) continue;
        const ambiguous = calls.length > 1 && !call;
        const key = call?.seq ?? unmatchedKey(id, calls.at(-1)?.seq, result.content);
        if (emitted.has(key) || (typeof key === 'string' && this.#unmatched.has(key))) continue;
        emitted.add(key);
        events.push({
          type: 'tool.result',
          actor: 'harness',
          attrs: {
            tool_use_id: result.tool_use_id,
            name: call?.name ?? 'unknown',
            ...(ambiguous ? { correlation: 'ambiguous' } : {}),
            is_error: result.is_error ?? hasErrorReceipt(result.content),
            bytes: result.content.length,
          },
          payload: result.content,
          callSeq: call?.seq,
          ...(typeof key === 'string' ? { unmatchedKey: key } : {}),
        });
      }
    }
    return events;
  }

  /** Apply the writer receipt (or the same JSONL event during recovery). */
  restore(
    event: {
      type: string;
      seq: number;
      turn?: number;
      attrs?: Record<string, unknown>;
      causes?: number[];
      payload?: unknown;
      redacted?: string[];
    },
    candidate?: DerivedEvent,
  ): void {
    if (event.type === 'retrieval.context' && candidate?.contextFingerprint) {
      this.#seenContext.add(candidate.contextFingerprint);
    }
    const id = event.attrs?.tool_use_id;
    if (typeof id !== 'string' || !id) return;
    const calls = this.#calls.get(id) ?? [];
    if (event.type === 'tool.call') {
      const name = String(event.attrs?.name ?? 'unknown');
      calls.push({
        id,
        name,
        seq: event.seq,
        turn: event.turn ?? 0,
        closed: false,
        signature:
          event.attrs?.input === undefined || event.redacted?.length
            ? undefined
            : callSignature(name, event.attrs.input),
      });
      this.#calls.set(id, calls);
    } else if (event.type === 'tool.result') {
      // Older records can have an ID but no causal edge. Only a single saved occurrence is
      // identifiable in that format. An explicit ambiguous observation never closes a call.
      const call = event.causes?.length
        ? calls.find((candidate) => event.causes!.includes(candidate.seq))
        : calls.length === 1 && event.attrs?.correlation !== 'ambiguous'
          ? calls[0]
          : undefined;
      if (call) call.closed = true;
      else if (candidate?.unmatchedKey) this.#unmatched.add(candidate.unmatchedKey);
      else if (typeof event.payload === 'string') {
        this.#unmatched.add(unmatchedKey(id, calls.at(-1)?.seq, event.payload));
      }
    }
  }

  seqOf(toolUseId: string): number | undefined {
    const calls = this.#calls.get(toolUseId);
    return calls?.length === 1 && !calls[0]!.closed ? calls[0]!.seq : undefined;
  }
}

function callSignature(name: string, input: unknown): string {
  // Object key order has no meaning in JSON tool arguments.
  const json = JSON.stringify([name, input], (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
  return createHash('sha256').update(json).digest('hex');
}

function unmatchedKey(id: string, lastSeq: number | undefined, content: string): string {
  return createHash('sha256')
    .update(JSON.stringify([id, lastSeq, content]))
    .digest('hex');
}

/**
 * The question a retriever was asked and the passages it came back with, read out of the prompt.
 *
 * The whole point is that this needs no new capture mechanism. A RAG system's retrieval runs
 * in-process — FAISS is a library call, not an HTTP request — so a proxy cannot see it happen.
 * What a proxy *can* see is the prompt the retrieval produced, and the passages are in it
 * verbatim, because putting them there is what retrieval is for. Same standing as `tool.call`,
 * which is likewise reconstructed from traffic rather than captured at the source.
 *
 * Two things are deliberately not here, and their absence is not an oversight. **Scores** and
 * **top-k** never reach the wire: a prompt carries the passages that survived truncation, in the
 * order they were pasted, with no numbers attached. Reporting a count as though it were `top-k`
 * would be a fabricated measurement — `--context-docs` cuts the list before it is joined, so even
 * "how many were retrieved" cannot be recovered. Getting those needs an instrument inside the
 * Python process, which is a separate piece of work and honestly out of reach from here.
 *
 * Recognition is deliberately narrow. It fires on an explicit `Context:` … `Question:` structure,
 * which is what a RAG template writes and what an ordinary chat turn does not. A looser rule —
 * "the message is long and has paragraphs" — would file half the coding-agent traffic in the
 * world as retrieval evidence, and a timeline that cries retrieval on every long prompt is worth
 * less than no timeline at all.
 */
const CONTEXT_LABEL =
  /^[ \t]*(?:context|retrieved context|relevant context|retrieved documents|documents|passages|sources)[ \t]*:[ \t]*/im;
const QUESTION_LABEL = /^[ \t]*(?:question|query|user question)[ \t]*:[ \t]*/im;
/** How a template separates one passage from the next, most explicit first. */
const PASSAGE_SEPARATORS = [/\n[ \t]*-{3,}[ \t]*\n/, /\n[ \t]*={3,}[ \t]*\n/, /\n\s*\n/];

export interface RetrievalContext {
  query: string;
  passages: string[];
  /** Identity for de-duplication across resent conversations. */
  fingerprint: string;
}

export function retrievalContext(req: CanonicalRequest): RetrievalContext | undefined {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user') return undefined;
  const text = last.content
    .filter((b): b is Extract<CanonicalContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (text === '') return undefined;

  const context = CONTEXT_LABEL.exec(text);
  if (context === null) return undefined;
  const afterContext = context.index + context[0].length;
  const question = QUESTION_LABEL.exec(text.slice(afterContext));
  if (question === null) return undefined;

  const body = text.slice(afterContext, afterContext + question.index).trim();
  if (body === '') return undefined;

  // What follows the question label, up to a blank line — a template's closing instruction
  // ("Answer concisely:") sits after one, and folding it into the query would make two runs that
  // asked the same thing look like they asked different things.
  const rest = text.slice(afterContext + question.index + question[0].length);
  const query = (rest.split(/\n\s*\n/)[0] ?? '').trim();
  if (query === '') return undefined;

  const separator = PASSAGE_SEPARATORS.find((re) => re.test(body));
  // `String.split` with a non-global pattern still splits on every occurrence, so the separator
  // is used as found rather than recompiled.
  const passages = (separator === undefined ? [body] : body.split(separator))
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (passages.length === 0) return undefined;

  return {
    query,
    passages,
    fingerprint: createHash('sha256')
      .update(`${query} ${passages.join(' ')}`)
      .digest('hex'),
  };
}

function collectToolUses(
  res: CanonicalResponse | undefined,
): Array<Extract<CanonicalContent, { type: 'tool_use' }>> {
  if (!res) return [];
  return res.content.filter(
    (b): b is Extract<CanonicalContent, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

/** The decoded reasoning a reply carried, thinking blocks joined in stream order. */
export function collectThinking(res: CanonicalResponse | undefined): string {
  if (!res) return '';
  return res.content
    .filter((b): b is Extract<CanonicalContent, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.text)
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Derive one exchange's events, resolve their causal references, and write them.
 *
 * Shared because it has two callers — `agenticreplay record` and the live half of a fork — and they drifted:
 * the fork wrote every model exchange with no `causes` at all, so a forked run could be replayed
 * and forked again but not explained. The seq resolution is the part that is easy to leave out,
 * since it cannot happen until the writer has appended, so it lives here rather than in either
 * caller.
 */
export async function appendDerivedEvents(
  writer: TraceWriter,
  deriver: ExchangeEventDeriver,
  exchange: RecordedExchange,
  turn: number,
  /** The event actually stored, including any redaction or size-limit omissions. */
  onWritten?: (event: TraceEvent) => void,
): Promise<void> {
  await appendDerivedBatch(writer, deriver, deriver.derive(exchange, turn), turn, onWritten);
}

/** Persist results carried by a request without projecting an incomplete exchange as a model call. */
export async function appendObservedToolResults(
  writer: TraceWriter,
  deriver: ExchangeEventDeriver,
  request: CanonicalRequest,
  turn: number,
): Promise<void> {
  await appendDerivedBatch(writer, deriver, deriver.deriveToolResults(request, 'known'), turn);
}

async function appendDerivedBatch(
  writer: TraceWriter,
  deriver: ExchangeEventDeriver,
  events: DerivedEvent[],
  turn: number,
  onWritten?: (event: TraceEvent) => void,
): Promise<void> {
  /** `written[i]` is the seq of the i-th derived event, which is what `causesIndex` refers to. */
  const written: number[] = [];
  for (const derived of events) {
    const causes: number[] = derived.callSeq === undefined ? [] : [derived.callSeq];
    for (const index of derived.causesIndex ?? []) {
      const seq = written[index];
      if (seq !== undefined) causes.push(seq);
    }
    const event = await writer.append({
      type: derived.type,
      actor: derived.actor,
      turn,
      attrs: derived.attrs,
      payload: derived.payload as never,
      ...(causes.length > 0 ? { causes } : {}),
    });
    written.push(event.seq);
    deriver.restore(event, derived);
    onWritten?.(event);
  }
}
