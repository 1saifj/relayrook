import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AcpConnection } from '../src/adapters/acp.mjs';
import { CodexAppServerConnection } from '../src/adapters/codex.mjs';
import {
  IS_WINDOWS, pidAlive, processIdentity, quoteForCmd, spawnCommand, terminateWindowsProcessTree,
} from '../src/platform.mjs';
import { cleanupSessions } from '../src/sessions.mjs';
import { SessionStore } from '../src/state.mjs';

const windowsOnly = { skip: !IS_WINDOWS, timeout: 30000 };

test('cmd quoting rejects expansion and command boundary characters', () => {
  for (const arg of ['a"b', '%PATH%', 'a\nb', 'a\rb', 'a\0b']) {
    assert.throws(() => quoteForCmd(arg), /Cannot quote argument/);
  }
  assert.equal(quoteForCmd('space & (parens) ! literal'), '"space & (parens) ! literal"');
});

async function waitGone(pid) {
  for (let i = 0; i < 100 && pidAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(pidAlive(pid), false, `process ${pid} survived termination`);
}

async function spawnShimTree(directory) {
  const runner = path.join(directory, 'runner.cjs');
  const shim = path.join(directory, 'agent shim.cmd');
  writeFileSync(runner, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
child.once('spawn', () => console.log(JSON.stringify({ pid: process.pid, descendant: child.pid, args: process.argv.slice(2) })));
setInterval(()=>{},1000);
`);
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0runner.cjs" %*\r\n`);
  const args = ['a b', 'ampersand & literal', '(parentheses)', '!literal!', '', 'trailing\\'];
  const child = spawnCommand(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const info = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`shim timed out: ${stderr}`)), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`shim exited ${code}: ${stderr}`)); });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!stdout.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    assert.deepEqual(info.args, args);
    return { child, info };
  } catch (error) {
    await terminateWindowsProcessTree(child.pid);
    throw error;
  }
}

const connectionTypes = [
  { label: 'ACP', Connection: AcpConnection },
  { label: 'Codex', Connection: CodexAppServerConnection },
];
for (const { label, Connection } of connectionTypes) {
  test(`Windows ${label} closes a shim path with spaces and all descendants`, windowsOnly, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'relayrook platform '));
    let child;
    try {
      const tree = await spawnShimTree(directory);
      child = tree.child;
      const connection = new Connection({ backend: {}, cwd: directory });
      connection.child = child;
      await connection.close();
      await Promise.all([waitGone(child.pid), waitGone(tree.info.pid), waitGone(tree.info.descendant)]);
    } finally {
      if (child?.pid && pidAlive(child.pid)) await terminateWindowsProcessTree(child.pid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`Windows ${label} reports a failed tree termination`, windowsOnly, async () => {
    const connection = new Connection({ backend: {}, cwd: process.cwd() });
    // taskkill cannot succeed for a process that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '0']);
    connection.child = /** @type {any} */ ({ pid: dead.pid, exitCode: null });
    await assert.rejects(connection.close(), /Failed to terminate backend process tree/);
    assert.equal(connection.closed, false);
  });
}

test('Windows orphan cleanup terminates a verified shim and its descendants', windowsOnly, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relayrook orphan '));
  let child;
  try {
    const tree = await spawnShimTree(directory);
    child = tree.child;
    const identity = await processIdentity(child.pid);
    assert.ok(identity, 'Windows process identity must be available');
    const stateDir = path.join(directory, 'state');
    const store = new SessionStore(stateDir, 'verified-tree').ensure();
    store.writeMeta({ schemaVersion: 2, key: 'verified-tree', status: 'ready', pid: spawnSync(process.execPath, ['-e', '0']).pid,
      backendPid: child.pid, backendCommand: identity.command, backendProcessStartedAt: identity.startedAt });
    const result = await cleanupSessions({ stateDir });
    assert.equal(result.reaped.find((entry) => entry.key === 'verified-tree').orphanBackendKilled, true);
    await Promise.all([waitGone(child.pid), waitGone(tree.info.pid), waitGone(tree.info.descendant)]);
  } finally {
    if (child?.pid && pidAlive(child.pid)) await terminateWindowsProcessTree(child.pid);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('process identity keeps the whole command path', { skip: IS_WINDOWS }, async () => {
  // BSD ps pads every column but the last, so asking for `comm` before
  // `lstart` cut the path to 16 characters: two binaries in the same local
  // bin directory became one "identity", and orphan cleanup could SIGKILL
  // whichever of them had inherited the recorded pid.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relayrook-identity-long-path-'));
  const link = path.join(directory, 'a-deliberately-long-executable-name');
  let child;
  try {
    symlinkSync(process.execPath, link);
    child = spawn(link, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('spawn', resolve));
    const identity = await processIdentity(child.pid);
    assert.ok(identity, 'identity is available');
    assert.ok(identity.command.length > 16, `command must not be truncated, got ${identity.command}`);
    if (process.platform === 'darwin') assert.equal(identity.command, link);
    else assert.ok(path.isAbsolute(identity.command), 'command is an absolute path');
  } finally {
    if (child?.pid) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('orphan cleanup rejects a command prefix even with the same start marker', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relayrook identity-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const identity = await processIdentity(child.pid);
    assert.ok(identity);
    const store = new SessionStore(directory, 'prefix-identity').ensure();
    store.writeMeta({ schemaVersion: 2, key: 'prefix-identity', status: 'ready',
      pid: spawnSync(process.execPath, ['-e', '0']).pid,
      backendPid: child.pid, backendCommand: `${identity.command}-other`, backendProcessStartedAt: identity.startedAt });
    const result = await cleanupSessions({ stateDir: directory });
    const entry = result.reaped.find((item) => item.key === 'prefix-identity');
    assert.equal(entry.orphanBackendKilled, false);
    assert.equal(entry.orphanBackendUnverified, true);
    assert.equal(pidAlive(child.pid), true);
  } finally {
    child.kill('SIGKILL');
    await waitGone(child.pid);
    rmSync(directory, { recursive: true, force: true });
  }
});
