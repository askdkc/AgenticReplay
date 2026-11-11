import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** Reject install locations that disappear when a package manager replaces a runtime. */
export function isVersionedServicePath(path: string): boolean {
  return /(?:^|[/\\])(?:Cellar|versions|node@\d[^/\\]*|v?\d+\.\d+[^/\\]*)(?:[/\\]|$)/iu.test(path);
}

/** Resolve the launcher's spelling from PATH; never dereference its stable symlink. */
export async function resolveServiceNode(path: string): Promise<string> {
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory) || isVersionedServicePath(directory)) continue;
    const candidate = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // A missing PATH entry is not a runtime candidate.
    }
  }
  throw new Error('A stable node executable must be on PATH (for example /opt/homebrew/bin/node).');
}
