import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeAdapter } from '../src/opencode.js';
import { openCodeProbeEnvironment } from '../src/opencode-probe.js';

describe('OpenCode help probe environment', () => {
  for (const probe of ['/owned/probe', '/owned/probe with spaces']) {
    for (const searchPath of [undefined, '', '/fixture/bin']) {
      it(`keeps roots private for ${probe} with PATH=${String(searchPath)}`, () => {
        const environment = openCodeProbeEnvironment(probe, searchPath);
        expect(environment.PATH).toBe(searchPath);
        for (const key of [
          'TMPDIR',
          'TMP',
          'TEMP',
          'HOME',
          'USERPROFILE',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_CACHE_HOME',
          'XDG_STATE_HOME',
        ]) {
          const value = (environment as Record<string, string | undefined>)[key];
          expect(value, key).toBeTypeOf('string');
          const within = relative(probe, value!);
          expect(isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`), key).toBe(
            false,
          );
        }
      });
    }
  }
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode help probe child and cleanup', () => {
  for (const helpExit of [0, 17]) {
    it.skipIf(process.platform === 'win32')(
      `owns parent/child temporary files and retains a sibling sentinel after help exit ${helpExit}`,
      async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'opencode probe with spaces ')));
        roots.push(root);
        const bin = join(root, 'bin');
        const home = join(root, 'home');
        const unrelated = join(root, 'unrelated temporary files');
        const runDir = join(root, 'run');
        for (const dir of [bin, home, unrelated, runDir]) mkdirSync(dir);
        const sentinel = join(unrelated, 'sentinel.txt');
        writeFileSync(sentinel, 'unrelated temporary data');
        const observed = join(root, 'observed.json');
        const grandchild = `
        const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
        const temporary=os.tmpdir();
        const file=path.join(fs.mkdtempSync(path.join(temporary,'grandchild-')),'owned.txt');
        fs.writeFileSync(file,'owned grandchild temporary data');
        process.stdout.write(JSON.stringify({pid:process.pid,ppid:process.ppid,temporary,file}));
      `;
        const program = `#!${process.execPath}
        const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
        const cwd=process.cwd(),temporary=os.tmpdir(),within=path.relative(cwd,temporary);
        const contained=!path.isAbsolute(within)&&within!=='..'&&!within.startsWith('..'+path.sep);
        const result={pid:process.pid,ppid:process.ppid,cwd,temporary,contained,
          temporaryExists:contained&&fs.existsSync(temporary),
          tmp:process.env.TMP,temp:process.env.TEMP,unknown:process.env.UNRECOGNIZED_ENV};
        // The pre-fix probe resolves to the machine's tmpdir. Observe that value,
        // then fail without reading or writing anything in that directory.
        if(contained&&result.temporaryExists){
          const own=fs.mkdtempSync(path.join(temporary,'child-'));
          fs.writeFileSync(path.join(own,'owned.txt'),'owned child temporary data');
          const child=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(grandchild)}],{env:process.env,encoding:'utf8'});
          result.grandchild=JSON.parse(child.stdout);result.grandchildExit=child.status;result.grandchildSignal=child.signal;
        }
        fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(result));
        if(!contained||!result.temporaryExists)process.exit(23);
        process.stdout.write('FLAGS --standalone private server\\n');
        process.exitCode=${helpExit};
      `;
        writeFileSync(join(bin, 'opencode'), program, { mode: 0o700 });
        const launch = await openCodeAdapter.prepare({
          runId: 'run_probe_owned',
          cwd: root,
          runDir,
          proxyUrl: 'http://127.0.0.1:51733',
          userArgs: ['run', 'fixture'],
          env: {
            PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
            HOME: home,
            USERPROFILE: home,
            TMPDIR: unrelated,
            TMP: unrelated,
            TEMP: unrelated,
            UNRECOGNIZED_ENV: 'must not be inherited',
          },
        });
        const result = JSON.parse(readFileSync(observed, 'utf8'));
        expect(result.contained).toBe(true);
        expect(result.temporaryExists).toBe(true);
        expect(result.temporary).toBe(join(result.cwd, 'tmp'));
        expect(result.tmp).toBe(result.temporary);
        expect(result.temp).toBe(result.temporary);
        expect(result.unknown).toBeUndefined();
        expect(result.ppid).toBe(process.pid);
        expect(result.grandchild.ppid).toBe(result.pid);
        expect(result.grandchild.temporary).toBe(result.temporary);
        expect(result.grandchildExit).toBe(0);
        expect(result.grandchildSignal).toBeNull();
        expect(launch.args.includes('--standalone')).toBe(helpExit === 0);
        expect(existsSync(result.cwd)).toBe(false);
        expect(
          readdirSync(runDir).filter((name) => name.startsWith('.opencode-capabilities-')),
        ).toEqual([]);
        expect(readFileSync(sentinel, 'utf8')).toBe('unrelated temporary data');
      },
    );
  }
});
