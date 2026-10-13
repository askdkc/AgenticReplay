/** Everything an adapter needs to know about the run it is preparing. */
export interface RecordContext {
  runId: string;
  cwd: string;
  /** Base URL of the local recording proxy, e.g. http://127.0.0.1:51733 */
  proxyUrl: string;
  /** Directory the adapter may write temporary capture configuration into. */
  runDir: string;
  /** Argv the user passed after the agent name. */
  userArgs: string[];
  env: Record<string, string | undefined>;
}

/** How to launch the instrumented agent. */
export interface Launch {
  command: string;
  args: string[];
  /** Environment overlay merged onto the parent environment. */
  env: Record<string, string>;
  cwd?: string;
  /** Files the adapter wrote for cleanup and capture provenance. */
  tempFiles?: string[];
}

/** How to launch and instrument one agent harness. */
export interface Adapter {
  id: string;
  /** Other names this adapter answers to on the command line. */
  aliases?: readonly string[];
  /** Semver range of harness versions this adapter is tested against. */
  harnessVersions?: string;
  /** How this adapter gets the agent's traffic to AgenticReplay. */
  capture?: 'env' | 'transport' | 'config';
  detect(cwd: string): Promise<boolean>;
  prepare(ctx: RecordContext): Promise<Launch>;
  /** The harness transcript reader used to record prompts that do not appear on the wire. */
  session?: SessionSupport;
  /** Arguments that load an MCP config from a path, for a harness that takes one. */
  mcpConfigArgs?(path: string): string[] | undefined;
  /** Additional ignored paths that are meaningful agent outputs and should be recorded. */
  artifacts?: HarnessArtifacts;
}

/** Additional output paths a harness writes that ordinary ignore rules would omit. */
export interface HarnessArtifacts {
  capture?: readonly string[];
}

/** How to find and read a harness's own session transcript for action logging. */
export interface SessionSupport {
  /** Directory the harness writes session transcripts into, or undefined if it keeps none. */
  dir(cwd: string, env: Record<string, string | undefined>): string | undefined;
  /** Pull the session id and the user's turns out of one transcript. */
  parse(bytes: Uint8Array): { id?: string; title?: string; prompts: string[] };
}
