import { readFile, stat } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const expand = promisify(gunzip);
const MAX_BYTES = 256 * 1024 * 1024;

/** Independent format reader: legacy bytes or a gzip sibling, with an expanded-byte cap. */
export async function readViewerBlob(path: string, budget = MAX_BYTES): Promise<Buffer> {
  const limit = Math.min(budget, MAX_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid blob budget');
  let compressed = false;
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    path += '.gz';
    compressed = true;
    info = await stat(path);
  }
  if (info.size > (compressed ? MAX_BYTES : limit)) throw new Error('blob exceeds budget');
  const stored = await readFile(path);
  const bytes = compressed ? await expand(stored, { maxOutputLength: Math.max(1, limit) }) : stored;
  if (bytes.length > limit) throw new Error('blob exceeds budget');
  return bytes;
}
