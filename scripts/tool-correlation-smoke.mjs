import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const missing = 'call_a7XTbE9pwLm2FvHs6jrQD';
const answered = 'call_ready';

function acceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Run against the installed tarball. A helper holds the final request open while record shuts down. */
export async function verifyToolCorrelation(bin, consumer, env) {
  const cwd = join(consumer, 'tool-correlation');
  await mkdir(cwd);
  const accepted = join(cwd, 'accepted');
  const tools = [answered, missing].map((id) => ({
    id,
    type: 'function',
    function: {
      name: 'lookup',
      arguments: JSON.stringify({
        input: 'private tool input',
        credential: 'sk-' + 's'.repeat(24),
      }),
    },
  }));
  let requests = 0;
  let repliedDuringClose = false;
  const endpoint = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    let message = { role: 'assistant', content: null, tool_calls: tools };
    if (requests === 2) {
      const port = Number(await readFile(join(cwd, 'proxy-port'), 'utf8'));
      await writeFile(accepted, '');
      // close() stops listening before it drains this active HTTP response.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (await acceptsConnections(port))) await delay(15);
      repliedDuringClose = !(await acceptsConnections(port));
      message = { role: 'assistant', content: 'done' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'smoke',
        model: 'fixture',
        choices: [{ message, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise((resolve, reject) => {
    endpoint.once('error', reject);
    endpoint.listen(0, '127.0.0.1', resolve);
  });
  try {
    const client = join(cwd, 'client.mjs');
    await writeFile(
      client,
      `
      import { spawn } from 'node:child_process';
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const base = process.env.OPENAI_BASE_URL;
      const late = process.argv[2] === 'result';
      const messages = late ? Array(2).fill({role:'tool', tool_call_id:'call_ready',content:'private result text'}) :
        [{role:'user',content:'begin'}];
      await (await fetch(base + '/chat/completions',{method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({model:'fixture',messages})})).text();
      if (!late) {
        await writeFile('proxy-port',new URL(base).port);
        spawn(process.execPath,[process.argv[1],'result'],{stdio:'ignore',detached:true}).unref();
        while (!await access('accepted').then(()=>true,()=>false)) await delay(10);
      }
    `,
    );
    await promisify(execFile)(
      bin,
      [
        'record',
        'generic-openai',
        '--no-fs',
        '--no-shell',
        '--json',
        '--',
        process.execPath,
        client,
      ],
      {
        cwd,
        env: {
          ...process.env,
          ...env,
          AGENTICREPLAY_EVENT_FILE_BYTES: '1500',
          AGENTICREPLAY_UPSTREAM_OPENAI: 'http://127.0.0.1:' + endpoint.address().port + '/v1',
        },
        timeout: 20000,
      },
    );
    assert.equal(requests, 2);
    assert.equal(repliedDuringClose, true);
    const runs = join(cwd, '.agenticreplay', 'runs');
    const dirs = await readdir(runs);
    assert.equal(dirs.length, 1);
    const run = join(runs, dirs[0]);
    const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
    assert.equal(manifest.capture.status, 'complete');
    assert.ok(manifest.integrity.segments.length > 1);
    const log = [];
    const digest = createHash('sha256');
    for (const segment of manifest.integrity.segments) {
      const bytes = await readFile(join(run, segment.name));
      digest.update(bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), segment.sha256);
      log.push(
        ...bytes
          .toString()
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
    }
    assert.equal(digest.digest('hex'), manifest.integrity.events_sha256);
    assert.equal(log.length, manifest.counts.events);
    assert.equal(log.at(-1).type, 'run.end');
    const calls = log.filter((e) => e.type === 'tool.call');
    const results = log.filter((e) => e.type === 'tool.result');
    assert.deepEqual(
      calls.map((e) => e.attrs.tool_use_id),
      [answered, missing],
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].attrs.tool_use_id, answered);
    assert.deepEqual(results[0].causes, [calls[0].seq]);
    const pending = calls.filter(
      (c) =>
        !results.some(
          (r) => r.causes?.includes(c.seq) && r.attrs.tool_use_id === c.attrs.tool_use_id,
        ),
    );
    const notes = log.filter((e) => e.attrs?.rule === 'unresolved_tool_calls');
    assert.equal(notes.length, 1);
    assert.deepEqual(
      notes[0].attrs.ids,
      pending.map((c) => c.attrs.tool_use_id),
    );
    assert.deepEqual(
      notes[0].attrs.call_seqs,
      pending.map((c) => c.seq),
    );
    assert.equal(notes[0].attrs.observation, 'result_not_observed');
    assert.ok(notes[0].seq > results[0].seq);
    assert.doesNotMatch(JSON.stringify(notes), /private tool input|private result text|sk-s{24}/);
  } finally {
    endpoint.closeAllConnections();
    await new Promise((resolve) => endpoint.close(resolve));
  }
}
