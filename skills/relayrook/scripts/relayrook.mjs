#!/usr/bin/env node
/**
 * Self-contained distribution entrypoint.
 *
 * `lib/` is a copy of the project's `src/`, so this file works from an
 * installed `skills/relayrook/` directory with no repository checkout and no
 * runtime dependencies beyond Node itself.
 */
import { main } from './lib/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'internal_error', message: String(err) } })}\n`);
    process.exitCode = 1;
  },
);
