import { join } from 'node:path';

/** Keep a capability check independent of the user's configuration and environment. */
export function openCodeProbeEnvironment(probe: string, searchPath: string | undefined) {
  const temporary = join(probe, 'tmp');
  return {
    PATH: searchPath,
    HOME: probe,
    USERPROFILE: probe,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(probe, 'config'),
    XDG_DATA_HOME: join(probe, 'data'),
    XDG_CACHE_HOME: join(probe, 'cache'),
    XDG_STATE_HOME: join(probe, 'state'),
  };
}
