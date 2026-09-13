#!/usr/bin/env node
/**
 * Development-checkout entrypoint. The distributed skill uses
 * `skills/relayrook/scripts/relayrook.mjs`, which is the same CLI over a copy
 * of `src/` and needs no repository checkout.
 */
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'internal_error', message: String(err) } })}\n`);
    process.exitCode = 1;
  },
);
