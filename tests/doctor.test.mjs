import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { IS_WINDOWS } from '../src/platform.mjs';
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
  // A shebang script is not executable on Windows, and PATH lookup there is
  // driven by PATHEXT — the fake CLI has to be shaped like the platform's.
  const devin = path.join(bin, IS_WINDOWS ? 'devin.cmd' : 'devin');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
    writeFileSync(devin, IS_WINDOWS ? '@echo off\r\necho devin 1.2.3\r\n' : '#!/bin/sh\necho "devin 1.2.3"\n');
    chmodSync(devin, 0o755);
    const env = IS_WINDOWS ? { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : { PATH: bin };

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
    // A backend RelayRook cannot launch reports no version of its own: the
    // base CLI's version belongs under `hostVersion`, or `installed: false`
    // sits next to a version number and reads as a contradiction.
    for (const backend of doctor.backends) {
      if (!backend.installed) assert.equal(backend.version, null, `${backend.id} claims no launchable version`);
      else assert.equal(backend.hostVersion, null, `${backend.id} reports one version, not two`);
    }

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

test('a command payload cannot turn a success envelope into a failure', async () => {
  const out = capture();
  const err = capture();
  const code = await main(['parse-result', '--text', 'a reply with no result block'], {
    stdout: out.stream,
    stderr: err.stream,
    env: {},
  });
  const response = out.json();
  assert.equal(code, 0);
  assert.equal(response.ok, true, 'the command succeeded');
  assert.equal(response.found, false, 'and reports that the reply carried no block');
  assert.equal(response.status, 'incomplete');
});

test('a workspace that does not exist is a usage error, not a backend spawn failure', async () => {
  const out = capture();
  const err = capture();
  const code = await main(
    ['start', '--backend', 'devin', '--workspace', path.join(os.tmpdir(), 'relayrook-no-such-workspace'), '--caller', 'codex'],
    { stdout: out.stream, stderr: err.stream, env: {} },
  );
  assert.equal(code, 1);
  const envelope = err.json();
  assert.equal(envelope.error.code, 'usage');
  assert.match(envelope.error.message, /Workspace does not exist/);
});
