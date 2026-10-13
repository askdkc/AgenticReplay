import type { Readable, Writable } from 'node:stream';
import { JsonRpcFramer } from '@agenticreplay/mcp-shim';
import { AgenticReplay } from './api.js';
import { AGENTICREPLAY_VERSION } from './version.js';

/**
 * AgenticReplay as tools an agent can call.
 *
 * `@agenticreplay/mcp-shim` records an agent's *own* MCP traffic — it is a tee, so nothing has ever
 * let an agent ask agenticreplay a question. That is backwards for this product in particular: "replay my
 * last run and tell me what diverged" is the most useful thing an agent could ask a replay
 * debugger, and it is a question no observability tool can answer, because a trace is a file.
 *
 * Written against the framer the shim already has rather than an SDK. The stdio transport is
 * newline-delimited JSON-RPC and the surface is four method names, so a runtime dependency here
 * would cost more than it carries — and this package has none.
 *
 * The tool set is deliberately narrow and read-mostly. `agenticreplay_replay` costs nothing and touches no
 * network; `agenticreplay_compare` spends real tokens, and says so in its own description, because an
 * agent choosing a tool reads that string and nothing else.
 */

/** The version of the MCP spec these messages are shaped for. */
const PROTOCOL_VERSION = '2025-06-18';

const METHOD_NOT_FOUND = -32601;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Every tool takes `run`, because "which run" is the only question all of them share. */
const RUN_ARG = {
  run: {
    type: 'string',
    description:
      'Run id, or "last" for the newest recording. Defaults to "last".',
  },
} as const;

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'agenticreplay_list_runs',
    description:
      'List every agent run recorded in this project, newest first. Start here when you do not ' +
      'already know which run to inspect.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agenticreplay_show_run',
    description:
      'The full timeline of one run: every model turn with its token counts and stop reason, ' +
      'every tool call with its arguments and result, every shell command with its exit code, ' +
      'and every file the run changed. This is what tells you why an agent did something, ' +
      'rather than what it cost.',
    inputSchema: { type: 'object', properties: { ...RUN_ARG } },
  },
  {
    name: 'agenticreplay_graph',
    description:
      'What caused what in a run, as a list of edges. Each edge says which event produced which, ' +
      'and whether it is `recorded` — the recorder watched it happen and wrote it into the trace ' +
      '— or `inferred`, meaning this derived it just now from the rule it names and the trace ' +
      'does not vouch for it. Pass `to` to get only the chain that produced one event, which is ' +
      'the shape of an answer to "why did this fail" rather than "what happened".',
    inputSchema: {
      type: 'object',
      properties: {
        ...RUN_ARG,
        to: {
          type: 'number',
          description: 'Narrow to the chain that produced this event seq. Omit for the whole run.',
        },
      },
    },
  },
];

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A tool result in MCP's shape: text content, plus the flag that says it failed. */
function content(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function ok(json: unknown): Record<string, unknown> {
  return content(JSON.stringify(json, null, 2));
}

/**
 * Handle one message.
 *
 * Returns `undefined` for a notification, which by definition has no id to answer — replying to
 * one is a protocol error that some clients treat as fatal.
 */
export async function handleMcpMessage(
  agenticreplay: AgenticReplay,
  message: unknown,
): Promise<JsonRpcResponse | undefined> {
  const req = asRecord(message) as JsonRpcRequest;
  const { id, method } = req;
  if (id === undefined) return undefined;

  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agenticreplay', version: AGENTICREPLAY_VERSION },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call':
      return reply(await callTool(agenticreplay, asRecord(req.params)));
    default:
      return fail(
        METHOD_NOT_FOUND,
        `agenticreplay's MCP server does not implement '${method ?? '(none)'}'`,
      );
  }
}

/**
 * Run one tool.
 *
 * Every failure comes back as `isError` content rather than a JSON-RPC error: the spec draws that
 * line so a model can read what went wrong and try something else, where a transport error ends
 * the session. A bad run id is an ordinary answer here, not a crash.
 */
async function callTool(
  agenticreplay: AgenticReplay,
  params: Record<string, unknown>,
): Promise<unknown> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = asRecord(params['arguments']);
  const run = typeof args['run'] === 'string' && args['run'] !== '' ? args['run'] : 'last';

  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return content(
      `no such tool '${name}'. agenticreplay serves: ${MCP_TOOLS.map((t) => t.name).join(', ')}`,
      true,
    );
  }

  try {
    switch (name) {
      case 'agenticreplay_list_runs':
        return ok(await agenticreplay.list());
      case 'agenticreplay_show_run':
        return ok(await agenticreplay.show(run));
      case 'agenticreplay_graph': {
        const to = args['to'];
        if (to !== undefined && typeof to !== 'number') {
          return content('to must be a number', true);
        }
        return ok(await agenticreplay.graph(run, to === undefined ? {} : { to }));
      }
      default:
        return content(`no such tool '${name}'`, true);
    }
  } catch (err) {
    return content(err instanceof Error ? err.message : String(err), true);
  }
}

export interface ServeMcpOptions {
  agenticreplay: AgenticReplay;
  input: Readable;
  output: Writable;
}

/**
 * Serve MCP over a stream pair until the input ends.
 *
 * Messages are handled one at a time. Concurrency would buy nothing — every tool here is either a
 * file read or a subprocess that owns the working tree — and it would let two replays fight over
 * the same checkout.
 */
export async function serveMcp({ agenticreplay, input, output }: ServeMcpOptions): Promise<void> {
  const framer = new JsonRpcFramer();
  for await (const chunk of input) {
    for (const frame of framer.push(chunk as Uint8Array)) {
      // A line that is not JSON is a stray log from something upstream, not a message. Dropping it
      // is the only safe answer: there is no id to report an error against.
      if (frame.message === undefined) continue;
      const response = await handleMcpMessage(agenticreplay, frame.message);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
