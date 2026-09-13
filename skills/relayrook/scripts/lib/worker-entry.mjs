#!/usr/bin/env node
/**
 * Spawnable entrypoint for the detached session worker.
 *
 * Resolved relative to this module's own URL by `sessions.mjs`, so it works
 * identically from the development checkout and from a copied
 * `skills/relayrook/` directory.
 */
import { parseArgs, requireFlag } from './args.mjs';
import { runWorker } from './worker.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const sessionDir = requireFlag(flags, 'session-dir');

runWorker({ sessionDir }).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
