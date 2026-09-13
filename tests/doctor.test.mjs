import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.mjs';

function capture() {
  let text = '';
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
    json() { return JSON.parse(text); },
  };
}

test('an agent host can discover compactly and select with route without parsing doctor', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'relayrook-doctor-'));
  const bin = path.join(tmp, 'bin');
  const stateDir = path.join(tmp, 'state');
  const devin = path.join(bin, 'devin');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
    writeFileSync(devin, '#!/bin/sh\necho "devin 1.2.3"\n');
    chmodSync(devin, 0o755);
    const env = { PATH: bin };

    const doctorOut = capture();
    const doctorErr = capture();
    assert.equal(await main(
      ['doctor', '--compact', '--caller', 'claude-code', '--state-dir', stateDir],
      { stdout: doctorOut.stream, stderr: doctorErr.stream, env },
    ), 0);
    const doctor = doctorOut.json();
    assert.equal(doctor.schema, 'relayrook.doctor.compact.v1');
    assert.ok(Array.isArray(doctor.backends));
    assert.ok(Array.isArray(doctor.routes));
    assert.equal(doctor.backends.find((backend) => backend.id === 'devin').installed, true);
    assert.equal(Object.hasOwn(doctor.backends[0], 'evidence'), false);

    const routeOut = capture();
    const routeErr = capture();
    assert.equal(await main(
      ['route', '--role', 'implementation', '--caller', 'claude-code', '--state-dir', stateDir],
      { stdout: routeOut.stream, stderr: routeErr.stream, env },
    ), 0);
    assert.equal(routeOut.json().selected.backend, 'devin');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
