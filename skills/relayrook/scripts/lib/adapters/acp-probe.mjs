import { AcpConnection } from './acp.mjs';
import { resolveClaudeAdapter } from '../discovery.mjs';
import { backendCommandOverride } from '../sessions.mjs';

/**
 * Initialize-only ACP probe. Proves the executable speaks ACP and reads the
 * advertised agentCapabilities — including `loadSession`, which decides
 * whether restart recovery is possible — without creating a session or
 * spending an inference call.
 *
 * @param {{backend: any, stateDir?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} options
 */
export async function probeAcp(options) {
  const backend = options.backend;
  const env = options.env ?? process.env;
  const override = backendCommandOverride(backend.id, env);
  let command;
  let argsPrefix;
  if (override) {
    command = override.command;
    argsPrefix = override.args;
  } else if (backend.adapter === 'npm-package') {
    const adapter = resolveClaudeAdapter(options.stateDir, env);
    if (!adapter.path) {
      return {
        protocolReady: false,
        error: 'adapter not installed',
        note: 'run relayrook bootstrap --backend claude',
      };
    }
    command = adapter.path;
    argsPrefix = [];
  }
  const conn = new AcpConnection({ backend, cwd: process.cwd(), env: {}, command, argsPrefix });
  try {
    await conn.start();
    const init = await conn.initialize(options.timeoutMs ?? 30000);
    return {
      protocolReady: true,
      agentInfo: init?.agentInfo ?? null,
      agentCapabilities: init?.agentCapabilities ?? null,
      protocolVersion: init?.protocolVersion ?? null,
    };
  } catch (err) {
    return { protocolReady: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn.close().catch(() => {});
  }
}
