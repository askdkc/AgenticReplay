// Substitute the macOS discovery call and the GUI executable only. The CLI still owns the
// actual subprocess, its environment, the proxy and the socket.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const executable = '/fixture/Codex.app/Contents/MacOS/Codex';
const { execFileSync, spawn } = childProcess;
Object.defineProperty(process, 'platform', { value: 'darwin' });
childProcess.execFileSync = (file, args, options) => {
  if (file !== '/usr/bin/osascript') return execFileSync(file, args, options);
  return JSON.stringify({ executable, running: process.env.AR_DESKTOP_FIXTURE_RUNNING === '1' });
};
childProcess.spawn = (file, args, options) => {
  if (file !== executable) return spawn(file, args, options);
  return spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGUSR2', () => process.exit(0));
    setInterval(() => {}, 1000);
    const env = Object.fromEntries([
      'HTTPS_PROXY', 'https_proxy', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS', 'AGENTICREPLAY_CODEX_REVIEW_SOCKET', 'CODEX_HOME'
    ].map(key => [key, process.env[key]]));
    require('node:fs').writeFileSync(process.env.AR_DESKTOP_FIXTURE_READY,
      JSON.stringify({ pid: process.pid, cwd: process.cwd(), env }));
  `,
    ],
    options,
  );
};
syncBuiltinESMExports();
