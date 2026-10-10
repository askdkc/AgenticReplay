#!/usr/bin/env node
/**
 * Isolated acceptance probe for installed Claude Code and OpenCode clients.
 *
 * Each host client is launched through AgenticReplay's record wrapper. The independent local stub
 * proves the outbound request while the run trace proves what the wrapper persisted. Every state
 * directory is temporary, and the stub rejects non-local traffic by construction.
 * Codex is intentionally not included; its endpoint selection is a separate negative case.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const timeoutMs = 25_000;

function run(command, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function startStub() {
  const requests = [];
  const responses = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body });
      const isAnthropic = req.url?.startsWith('/v1/messages');
      const parsedRequest = isAnthropic ? JSON.parse(body) : {};
      const probeTurn = body.includes('Use the probe') || body.includes('acceptance probe');
      const advertisedTool = parsedRequest.tools?.find(
        (tool) => typeof tool.name === 'string' && tool.name.includes('probe'),
      )?.name;
      // Do not fall back to a built-in tool: that would hide missing MCP wiring.
      const toolName = advertisedTool;
      // Only answer a tool call when the client advertised the probe and has not yet returned
      // its result. A synthetic CodeMode/search fallback made missing MCP wiring look healthy.
      const hasProbeResult = (parsedRequest.messages ?? []).some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part) => part.type === 'tool_result' && part.tool_use_id === 'tool_acceptance',
          ),
      );
      const hasWarmupResult = (parsedRequest.messages ?? []).some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part) => part.type === 'tool_result' && part.tool_use_id === 'tool_warmup',
          ),
      );
      // OpenCode can send the first model request before its asynchronous MCP catalog is ready.
      // A harmless local CodeMode turn gives it one continuation; only the real probe result
      // satisfies acceptance below.
      const warmup =
        probeTurn &&
        toolName === undefined &&
        !hasWarmupResult &&
        parsedRequest.tools?.some((tool) => tool.name === 'execute');
      const toolTurn = warmup || (probeTurn && toolName !== undefined && !hasProbeResult);
      const selectedTool = warmup ? 'execute' : toolName;
      const toolInput = warmup ? { code: 'return 1;' } : {};
      const toolUseId = warmup ? 'tool_warmup' : 'tool_acceptance';
      const response =
        isAnthropic && toolTurn
          ? {
              id: 'msg_probe_tool',
              type: 'message',
              role: 'assistant',
              model: 'stub',
              content: [{ type: 'tool_use', id: toolUseId, name: selectedTool, input: toolInput }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : isAnthropic
            ? {
                id: 'msg_probe_done',
                type: 'message',
                role: 'assistant',
                model: 'stub',
                content: [{ type: 'text', text: 'HOST_CLIENT_SENTINEL' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                id: 'resp_probe',
                object: 'response',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'HOST_CLIENT_SENTINEL' }],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              };
      if (isAnthropic && JSON.parse(body).stream === true) {
        const tool = toolTurn;
        const events = tool
          ? [
              {
                type: 'message_start',
                message: {
                  id: 'msg_probe_tool',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: 'stub',
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
              {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: toolUseId,
                  name: selectedTool,
                  input: {},
                },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]
          : [
              {
                type: 'message_start',
                message: {
                  id: 'msg_probe_done',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: 'stub',
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'HOST_CLIENT_SENTINEL' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const wire = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('');
        responses.push(wire);
        res.end(wire);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        const wire = JSON.stringify(response);
        responses.push(wire);
        res.end(wire);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    responses,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function isolatedEnv(root, extra = {}) {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  };
}

async function traceBlobText(runDir) {
  const parts = [await readFile(join(runDir, 'events.jsonl'), 'utf8')];
  const root = join(runDir, 'blobs');
  for (const shard of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, shard)).catch(() => [])) {
      parts.push((await readFile(join(root, shard, name))).toString('utf8'));
    }
  }
  return parts.join('\n');
}

function redactionComparable(text) {
  return text
    .replace(/<secret:[^>]+>/g, '<redacted>')
    .replace(/ses_[A-Za-z0-9]+/g, '<redacted>')
    .replace(/run_[0-9a-f]+/g, '<redacted>')
    .replaceAll('stub-key', '<redacted>');
}

async function installedTransportProof(runDir, expectedRequests, expectedResponses) {
  const readerModule =
    process.env.AGENTICREPLAY_TEST_TRACE_READER ??
    join(process.cwd(), 'packages/core/dist/index.js');
  const { TraceReader } = await import(pathToFileURL(readerModule).href);
  const reader = await TraceReader.open(runDir);
  const events = await reader.events();
  const requestEvents = events.filter(
    (event) => event.type === 'net.request' && event.attrs?.phase === 'body',
  );
  const responseEvents = events.filter((event) => event.type === 'net.response');
  if (
    requestEvents.length !== expectedRequests.length ||
    responseEvents.length !== expectedRequests.length
  )
    throw new Error(
      `installed trace transport count mismatch: requests=${requestEvents.length} responses=${responseEvents.length}`,
    );
  const responseByRequestId = new Map(
    responseEvents.map((event) => [event.attrs?.request_id, event]),
  );
  if (responseByRequestId.size !== expectedRequests.length)
    throw new Error('installed trace responses do not have one unique request_id each');
  const expectedIndexesByBody = new Map();
  expectedRequests.forEach((body, index) => {
    const key = redactionComparable(body);
    const indexes = expectedIndexesByBody.get(key) ?? [];
    indexes.push(index);
    expectedIndexesByBody.set(key, indexes);
  });
  for (const requestEvent of requestEvents) {
    const persisted = await reader.resolvePayload(requestEvent);
    const persistedComparable = typeof persisted === 'string' ? redactionComparable(persisted) : '';
    const expectedIndexes = expectedIndexesByBody.get(persistedComparable) ?? [];
    const index = expectedIndexes.shift();
    const expectedComparable =
      index === undefined ? '' : redactionComparable(expectedRequests[index]);
    if (
      typeof persisted !== 'string' ||
      index === undefined ||
      persistedComparable !== expectedComparable
    ) {
      let offset = 0;
      while (
        offset < persistedComparable.length &&
        offset < expectedComparable.length &&
        persistedComparable[offset] === expectedComparable[offset]
      )
        offset += 1;
      throw new Error(
        `installed trace request ${index} differs at byte ${offset}: persisted=${JSON.stringify(persistedComparable.slice(offset, offset + 120))} expected=${JSON.stringify(expectedComparable.slice(offset, offset + 120))}`,
      );
    }
    const responseEvent = responseByRequestId.get(requestEvent.attrs?.request_id);
    if (!responseEvent)
      throw new Error(`missing response for request_id ${requestEvent.attrs?.request_id}`);
    const response = await reader.resolvePayload(responseEvent);
    if (response !== expectedResponses[index])
      throw new Error(`installed trace response ${index} differs from endpoint bytes`);
  }
  return {
    requests: requestEvents.length,
    responses: responseEvents.length,
    exactAfterExpectedRedaction: true,
    responseExact: true,
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agenticreplay-host-acceptance-'));
  for (const name of ['home', 'config', 'data', 'state', 'cache']) await mkdir(join(root, name));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'agenticreplay-host-kiokuko-fixture', private: true, type: 'module' }),
    'utf8',
  );
  const install = await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', 'kiokuko@1.0.26'],
    {
      ...isolatedEnv(root),
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*',
    },
    root,
  );
  if (install.code !== 0)
    throw new Error(`isolated Kiokuko install failed: ${install.stderr || install.stdout}`);
  const kiokukoBin = join(root, 'node_modules', 'kiokuko', 'dist', 'bin', 'kiokuko.js');
  const mcpServer = join(root, 'mcp-server.mjs');
  const mcpLog = join(root, 'mcp.log');
  const kiokukoHome = join(root, 'kiokuko-home');
  const kiokukoWrapper = join(root, 'kiokuko-wrapper.mjs');
  const kiokukoLog = join(root, 'kiokuko.log');
  await mkdir(kiokukoHome, { recursive: true });
  await writeFile(
    kiokukoWrapper,
    `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.KIOKUKO_LOG, 'WRAPPER_START\\n');
const home = process.env.KIOKUKO_ISOLATED_HOME;
const child = spawn(process.execPath, [process.env.KIOKUKO_BIN, 'mcp'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/config', XDG_DATA_HOME: home + '/data' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdin.on('data', (chunk) => appendFileSync(process.env.KIOKUKO_LOG, 'IN:' + chunk));
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  const methods = [...text.matchAll(/"method":"([^"]+)"/g)].map((match) => match[1]);
  appendFileSync(
    process.env.KIOKUKO_LOG,
    'OUT methods=' + methods.join(',') +
      ' tools=' + text.includes('"tools"') +
      ' task_prepare=' + text.includes('task_prepare') +
      ' memory_recall=' + text.includes('memory_recall') + '\\n',
  );
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => { appendFileSync(process.env.KIOKUKO_LOG, 'ERR:' + chunk); process.stderr.write(chunk); });
process.stdin.pipe(child.stdin);
child.once('exit', (code, signal) => { appendFileSync(process.env.KIOKUKO_LOG, 'EXIT:' + JSON.stringify({ code, signal }) + '\\n'); process.exit(code ?? (signal ? 1 : 0)); });
`,
    'utf8',
  );
  await writeFile(
    mcpServer,
    `
import { appendFileSync } from 'node:fs';
let line = '';
process.stdin.on('data', chunk => {
  line += chunk;
  for (;;) {
    const end = line.indexOf('\\n'); if (end < 0) break;
    const msg = JSON.parse(line.slice(0, end)); line = line.slice(end + 1); appendFileSync(process.env.MCP_LOG, 'MCP_IN:' + msg.method + '\\nMCP_JSON:' + JSON.stringify(msg) + '\\n');
    let result = {};
    if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'acceptance', version: '1' } };
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'probe', description: 'returns the acceptance sentinel', inputSchema: { type: 'object', properties: {} } }] };
    else if (msg.method === 'tools/call') { appendFileSync(process.env.MCP_LOG, 'MCP_RESULT_SENTINEL\\n'); result = { content: [{ type: 'text', text: 'MCP_RESULT_SENTINEL' }], isError: false }; }
    if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`,
    'utf8',
  );
  const mcpConfig = join(root, 'mcp.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        acceptance: { command: process.execPath, args: [mcpServer] },
        kiokuko: {
          command: process.execPath,
          args: [kiokukoWrapper],
          env: {
            KIOKUKO_ISOLATED_HOME: kiokukoHome,
            KIOKUKO_LOG: kiokukoLog,
            KIOKUKO_BIN: kiokukoBin,
          },
        },
      },
    }),
    'utf8',
  );

  const stub = await startStub();
  const result = {};
  try {
    // Warm the disposable npm cache before either host launches its MCP subprocess. Otherwise
    // both clients can issue their first model request while npx is still installing Kiokuko,
    // which tests startup timing instead of the MCP contract.
    // Tarball consumers can point this at the installed CLI entrypoint; the checkout build is
    // the default used during repository verification.
    const cli =
      process.env.AGENTICREPLAY_TEST_CLI ?? join(process.cwd(), 'packages/cli/dist/cli.js');
    const claude = await run(
      process.execPath,
      [
        cli,
        'record',
        'claude-code',
        '--mcp-config',
        mcpConfig,
        '--upstream-anthropic',
        stub.base,
        '--',
        '--bare',
        '--allowedTools',
        'mcp__acceptance__probe',
        '-p',
        'Use the probe tool, then reply with HOST_CLIENT_SENTINEL.',
      ],
      isolatedEnv(root, {
        ANTHROPIC_API_KEY: 'stub-key',
        // Claude Code appends `/v1/messages` itself; a `/v1` base would double the path.
        ANTHROPIC_BASE_URL: stub.base,
        MCP_LOG: mcpLog,
        KIOKUKO_ISOLATED_HOME: kiokukoHome,
        KIOKUKO_LOG: kiokukoLog,
        KIOKUKO_BIN: kiokukoBin,
      }),
      process.cwd(),
    );
    const claudeBodies = stub.requests
      .filter((item) => item.path?.startsWith('/v1/messages'))
      .map((item) => item.body)
      .join('\n');
    const claudeExpectedRequests = stub.requests
      .filter((item) => item.path?.startsWith('/v1/messages'))
      .map((item) => item.body);
    const runId = /run_[0-9a-f]+/.exec(claude.stdout)?.[0];
    const runDir = runId ? join(process.cwd(), '.agenticreplay', 'runs', runId) : undefined;
    const claudeTransport = runId
      ? await installedTransportProof(
          runDir,
          claudeExpectedRequests,
          stub.responses.slice(0, claudeExpectedRequests.length),
        )
      : undefined;
    const capturedText = runDir ? await traceBlobText(runDir).catch(() => '') : '';
    result.claude = {
      version: (await run('claude', ['--version'], isolatedEnv(root), process.cwd())).stdout.trim(),
      code: claude.code,
      sentinel: claude.stdout.includes('HOST_CLIENT_SENTINEL'),
      system: claudeBodies.includes('You are a Claude agent'),
      tools: claudeBodies.includes('probe'),
      mcpResult: claudeBodies.includes('MCP_RESULT_SENTINEL'),
      toolResult: claudeBodies.includes('tool_result'),
      toolResultText: [...claudeBodies.matchAll(/"type":"tool_result"[\s\S]{0,500}/g)].map(
        (match) => match[0],
      ),
      requests: stub.requests.filter((item) => item.path?.startsWith('/v1/messages')).length,
      paths: stub.requests.map((item) => item.path),
      toolNames: stub.requests
        .filter((item) => item.path?.startsWith('/v1/messages'))
        .flatMap((item) => {
          try {
            return (JSON.parse(item.body).tools ?? []).map((tool) => tool.name).filter(Boolean);
          } catch {
            return [];
          }
        }),
      kiokukoTools: stub.requests
        .filter((item) => item.path?.startsWith('/v1/messages'))
        .flatMap((item) => {
          try {
            return (JSON.parse(item.body).tools ?? [])
              .map((tool) => tool.name)
              .filter((name) => name?.includes('task_prepare') || name?.includes('memory_recall'));
          } catch {
            return [];
          }
        }),
      stdout: claude.stdout.trim().slice(-500),
      stderr: claude.stderr.trim().slice(-500),
      capturedRun: runId,
      capturedModelRequests: (capturedText.match(/"type"\s*:\s*"model\.request"/g) ?? []).length,
      capturedSystem: capturedText.includes('You are a Claude agent'),
      capturedTools: capturedText.includes('mcp__acceptance__probe'),
      capturedSentinel: capturedText.includes('HOST_CLIENT_SENTINEL'),
      transport: claudeTransport,
    };
    if (runDir) await rm(runDir, { recursive: true, force: true });

    const mcpLogBeforeOpenCode = await readFile(mcpLog, 'utf8').catch(() => '');
    await mkdir(join(root, 'config', 'opencode'), { recursive: true });
    await writeFile(
      join(root, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
        mcp: {
          servers: {
            acceptance: {
              type: 'local',
              command: [process.execPath, mcpServer],
              disabled: false,
              codemode: false,
            },
            kiokuko: {
              type: 'local',
              command: [process.execPath, kiokukoWrapper],
              disabled: false,
              codemode: false,
              environment: {
                KIOKUKO_ISOLATED_HOME: kiokukoHome,
                KIOKUKO_LOG: kiokukoLog,
                KIOKUKO_BIN: kiokukoBin,
              },
            },
          },
        },
      }),
    );
    const openCodeConfig = JSON.stringify({
      provider: {
        anthropic: {
          // OpenCode expands this template from the adapter's proxy-scoped environment.
          options: { apiKey: 'stub-key', baseURL: '${ANTHROPIC_BASE_URL}' },
          models: { stub: {} },
        },
      },
      model: 'anthropic/stub',
    });
    const before = stub.requests.length;
    const responseBefore = stub.responses.length;
    const opencode = await run(
      process.execPath,
      [
        cli,
        'record',
        'opencode',
        '--upstream-anthropic',
        stub.base,
        '--',
        'run',
        '--auto',
        '--print-logs',
        '--log-level',
        'debug',
        '--model',
        'anthropic/stub',
        'Use the acceptance probe and include HOST_CLIENT_SYSTEM_SENTINEL in your reply, then return HOST_CLIENT_SENTINEL.',
      ],
      isolatedEnv(root, {
        OPENCODE_CONFIG_CONTENT: openCodeConfig,
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        ANTHROPIC_API_KEY: 'stub-key',
        MCP_LOG: mcpLog,
        KIOKUKO_ISOLATED_HOME: kiokukoHome,
        KIOKUKO_LOG: kiokukoLog,
        KIOKUKO_BIN: kiokukoBin,
      }),
      process.cwd(),
    );
    const openBodies = stub.requests
      .slice(before)
      .map((item) => item.body)
      .join('\n');
    const openExpectedRequests = stub.requests.slice(before).map((item) => item.body);
    const openRunId = /run_[0-9a-f]+/.exec(opencode.stdout)?.[0];
    const openRunDir = openRunId
      ? join(process.cwd(), '.agenticreplay', 'runs', openRunId)
      : undefined;
    const openCapturedText = openRunDir ? await traceBlobText(openRunDir).catch(() => '') : '';
    const openTransport = openRunDir
      ? await installedTransportProof(
          openRunDir,
          openExpectedRequests,
          stub.responses.slice(responseBefore, responseBefore + openExpectedRequests.length),
        )
      : undefined;
    result.opencode = {
      version: (
        await run('opencode', ['--version'], isolatedEnv(root), process.cwd())
      ).stdout.trim(),
      code: opencode.code,
      sentinel: opencode.stdout.includes('HOST_CLIENT_SENTINEL'),
      system: openBodies.includes('HOST_CLIENT_SYSTEM_SENTINEL'),
      tools: openBodies.includes('probe'),
      toolResult: openBodies.includes('tool_result'),
      requests: stub.requests.length - before,
      paths: stub.requests.slice(before).map((item) => item.path),
      toolNames: stub.requests.slice(before).flatMap((item) => {
        try {
          return (JSON.parse(item.body).tools ?? []).map((tool) => tool.name).filter(Boolean);
        } catch {
          return [];
        }
      }),
      kiokukoTools: stub.requests.slice(before).flatMap((item) => {
        try {
          return (JSON.parse(item.body).tools ?? [])
            .map((tool) => tool.name)
            .filter((name) => name?.includes('task_prepare') || name?.includes('memory_recall'));
        } catch {
          return [];
        }
      }),
      toolDetails: stub.requests.slice(before).flatMap((item) => {
        try {
          return (JSON.parse(item.body).tools ?? [])
            .filter((tool) => ['execute', 'question'].includes(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema ?? tool.inputSchema,
            }));
        } catch {
          return [];
        }
      }),
      systemTexts: stub.requests.slice(before).flatMap((item) => {
        try {
          const system = JSON.parse(item.body).system;
          return Array.isArray(system) ? system.map((part) => part.text).filter(Boolean) : [];
        } catch {
          return [];
        }
      }),
      executeResults: stub.requests.slice(before).flatMap((item) => {
        try {
          const messages = JSON.parse(item.body).messages ?? [];
          return messages
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .filter((part) => part.type === 'tool_result')
            .map((part) => ({ tool_use_id: part.tool_use_id, content: part.content }));
        } catch {
          return [];
        }
      }),
      requestShapes: stub.requests.slice(before).map((item) => {
        try {
          const request = JSON.parse(item.body);
          return {
            tools: (request.tools ?? []).map((tool) => tool.name),
            messages: (request.messages ?? []).map((message) => ({
              role: message.role,
              content: Array.isArray(message.content)
                ? message.content.map((part) => ({
                    type: part.type,
                    name: part.name,
                    tool_use_id: part.tool_use_id,
                    text: part.text,
                  }))
                : typeof message.content === 'string'
                  ? message.content.slice(0, 120)
                  : typeof message.content,
            })),
          };
        } catch {
          return {};
        }
      }),
      capturedRun: openRunId,
      capturedModelRequests: (openCapturedText.match(/"type"\s*:\s*"model\.request"/g) ?? [])
        .length,
      capturedSystem: openCapturedText.includes('HOST_CLIENT_SYSTEM_SENTINEL'),
      capturedToolSchemas: openBodies.includes('"tools"'),
      capturedTools:
        openCapturedText.includes('mcp__acceptance__probe') ||
        openBodies.includes('acceptance_probe'),
      capturedSentinel: openCapturedText.includes('HOST_CLIENT_SENTINEL'),
      transport: openTransport,
      stdout: opencode.stdout.trim().slice(-500),
      stderr: opencode.stderr.trim().slice(-2000),
    };
    if (openRunDir) await rm(openRunDir, { recursive: true, force: true });
    const mcpLogText = await readFile(mcpLog, 'utf8').catch(() => '');
    const openCodeMcpLog = mcpLogText.slice(mcpLogBeforeOpenCode.length);
    result.opencodeMcpCalled = openCodeMcpLog.includes('MCP_RESULT_SENTINEL');
    result.mcpCalled = mcpLogText.includes('MCP_RESULT_SENTINEL');
    result.mcpLog = mcpLogText.trim().split('\\n').filter(Boolean);
    result.kiokukoLog = (await readFile(kiokukoLog, 'utf8').catch(() => '')).slice(-12000);
    result.kiokukoActive =
      result.kiokukoLog.includes('WRAPPER_START') &&
      result.kiokukoLog.includes('task_prepare') &&
      result.kiokukoLog.includes('memory_recall');
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }

  console.log(JSON.stringify(result, null, 2));
  const claudeOk =
    result.claude?.code === 0 &&
    result.claude.sentinel &&
    result.claude.system &&
    result.claude.tools &&
    result.claude.capturedModelRequests > 0 &&
    result.claude.capturedSystem &&
    result.claude.capturedTools &&
    result.claude.capturedSentinel &&
    result.claude.kiokukoTools.length > 0 &&
    result.kiokukoActive &&
    result.claude.transport?.exactAfterExpectedRedaction &&
    result.claude.transport?.responseExact;
  const openCodeOk =
    result.opencode?.code === 0 &&
    result.opencode.sentinel &&
    result.opencode.capturedModelRequests > 0 &&
    result.opencode.capturedSystem &&
    result.opencode.capturedToolSchemas &&
    result.opencode.capturedSentinel &&
    result.opencode.kiokukoTools.length > 0 &&
    result.kiokukoActive &&
    result.opencode.transport?.exactAfterExpectedRedaction &&
    result.opencode.transport?.responseExact &&
    result.opencodeMcpCalled;
  const mcpRoundTrip = result.mcpCalled === true;
  if (!claudeOk || !openCodeOk || !mcpRoundTrip) process.exitCode = 1;
}

await main();
