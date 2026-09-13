#!/usr/bin/env node
/**
 * Deterministic Codex app-server stub for the end-to-end session tests.
 *
 * Speaks the real `codex app-server --stdio` protocol: newline JSON-RPC without
 * the `jsonrpc` envelope field, threads and turns, server->client approval
 * requests, and per-turn effort parameters.
 *
 * Behaviour is driven by the prompt text:
 *
 *   NEED_APPROVAL    send item/commandExecution/requestApproval, wait, continue
 *   NEED_INPUT       send item/tool/requestUserInput, wait for the response
 *   SLOW             stay in flight until turn/interrupt arrives
 *   SLOW_START       hold the turn/start reply ~400ms, then stay in flight
 *   STEER_ME         hold until turn/steer arrives, then echo its text
 *   FAIL_TURN        complete with status "failed"
 *   BIG              emit a text delta larger than the per-event cap
 *
 * Env:
 *   FAKE_CODEX_MODEL=<id>       model read back from thread/start (default fake-codex-1)
 *   FAKE_CODEX_EFFORT=<effort>  default effort (default high)
 *   FAKE_CODEX_ACCOUNT=0        account/read reports no account
 *   FAKE_CODEX_LEGACY=1         turn/steer/review/interrupt answer -32601 (version drift)
 *   FAKE_CODEX_REJECT_MODEL=1   thread/start reports a different model than requested
 *   FAKE_CODEX_STORE=<file>     persist threads across restarts, like real codex session files
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const MODEL = process.env.FAKE_CODEX_MODEL ?? 'fake-codex-1';
const EFFORT = process.env.FAKE_CODEX_EFFORT ?? 'high';
const HAS_ACCOUNT = process.env.FAKE_CODEX_ACCOUNT !== '0';
const LEGACY = process.env.FAKE_CODEX_LEGACY === '1';
const REJECT_MODEL = process.env.FAKE_CODEX_REJECT_MODEL === '1';
const STORE_FILE = process.env.FAKE_CODEX_STORE ?? null;

const rl = readline.createInterface({ input: process.stdin });

// Real Codex persists threads under $CODEX_HOME; the stub mirrors that with a
// JSON file so thread/resume survives an app-server restart.
function loadThreads() {
  if (!STORE_FILE || !existsSync(STORE_FILE)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(STORE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}
function saveThreads() {
  if (!STORE_FILE) return;
  writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(threads)));
}

/** @type {Map<string, {id: string, model: string, effort: string, cwd: string|null}>} */
const threads = loadThreads();
/** @type {Map<string, {threadId: string, status: string, steer: string[]}>} */
const turns = new Map();
const pending = new Map();
let nextId = 1;
let nextServerId = 9000;
let turnSeq = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ method, params });
}

function threadPayload(thread) {
  return {
    thread: { id: thread.id, cwd: thread.cwd, model: thread.model, reasoningEffort: thread.effort },
    model: thread.model,
    reasoningEffort: thread.effort,
    approvalPolicy: 'on-request',
    sandboxPolicy: 'workspace-write',
  };
}

function serverRequest(method, params) {
  const id = nextServerId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

async function runTurn(turnId, params) {
  const turn = turns.get(turnId);
  const thread = threads.get(turn.threadId);
  const text = (params?.input ?? []).map((i) => i.text ?? '').join('');
  const delta = (d) => notify('item/agentMessage/delta', { threadId: turn.threadId, turnId, delta: d });
  const complete = (status, extra = {}) => {
    turn.status = status;
    notify('turn/completed', { threadId: turn.threadId, turn: { id: turnId, status, ...extra } });
  };

  if (text.includes('NEED_APPROVAL')) {
    const decision = await serverRequest('item/commandExecution/requestApproval', {
      threadId: turn.threadId,
      turnId,
      itemId: 'item-1',
      command: ['echo', 'approved'],
      reason: 'stub wants to run echo',
    });
    delta(`APPROVAL:${decision?.decision ?? 'none'}`);
    if (decision?.decision === 'cancel') return complete('interrupted');
    return complete('completed');
  }

  if (text.includes('NEED_INPUT')) {
    const answers = await serverRequest('item/tool/requestUserInput', {
      threadId: turn.threadId,
      turnId,
      itemId: 'item-2',
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'a' }] }],
    });
    delta(`INPUT:${JSON.stringify(answers ?? null)}`);
    return complete('completed');
  }

  if (text.includes('SLOW')) {
    delta('working');
    return; // resolves only on turn/interrupt
  }

  if (text.includes('STEER_ME')) {
    delta('awaiting-steer');
    // The steer handler appends to turn.steer; poll until it arrives.
    await new Promise((resolve) => {
      const check = () => (turn.steer.length > 0 || turn.status !== 'inProgress' ? resolve() : setTimeout(check, 25));
      check();
    });
    if (turn.status !== 'inProgress') return;
    for (const steered of turn.steer) delta(`STEERED:${steered}`);
    return complete('completed');
  }

  if (text.includes('FAIL_TURN')) {
    return complete('failed', { error: { message: 'turn failed by fixture', codexErrorInfo: 'turn_failed' } });
  }

  if (text.includes('BIG')) {
    delta('X'.repeat(200000));
    return complete('completed');
  }

  delta('ROUTER_READY');
  notify('thread/tokenUsage/updated', {
    threadId: turn.threadId,
    turnId,
    tokenUsage: { total: { totalTokens: 10, inputTokens: 8, outputTokens: 2 } },
  });
  if (params?.effort && thread) {
    thread.effort = params.effort;
    saveThreads();
    notify('thread/settings/updated', { threadId: thread.id, model: thread.model, reasoningEffort: thread.effort });
  }
  complete('completed');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result ?? {});
    }
    return;
  }

  const fail = (code, message) => {
    if (msg.id !== undefined) send({ id: msg.id, error: { code, message } });
  };

  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { userAgent: 'fake-codex/0.0.1' } });
      break;
    case 'initialized':
      break;
    case 'model/list':
      send({
        id: msg.id,
        result: {
          data: [
            {
              id: MODEL,
              model: MODEL,
              displayName: 'Fake Codex 1',
              description: 'fixture model',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
              defaultReasoningEffort: EFFORT,
            },
            {
              id: 'fake-codex-2',
              model: 'fake-codex-2',
              displayName: 'Fake Codex 2',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              defaultReasoningEffort: 'low',
            },
          ],
        },
      });
      break;
    case 'account/read':
      send({
        id: msg.id,
        result: HAS_ACCOUNT
          ? { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }
          : { account: null, requiresOpenaiAuth: true },
      });
      break;
    case 'thread/start': {
      const requested = msg.params?.model ?? null;
      const model = REJECT_MODEL && requested ? `${requested}-substituted` : (requested ?? MODEL);
      const thread = {
        id: `thr-${nextId++}`,
        model,
        effort: msg.params?.effort ?? EFFORT,
        cwd: msg.params?.cwd ?? null,
      };
      threads.set(thread.id, thread);
      saveThreads();
      send({ id: msg.id, result: threadPayload(thread) });
      break;
    }
    case 'thread/resume': {
      const thread = threads.get(msg.params?.threadId);
      if (!thread) return fail(-32602, `unknown thread ${msg.params?.threadId}`);
      send({ id: msg.id, result: { ...threadPayload(thread), cwd: thread.cwd } });
      break;
    }
    case 'thread/read': {
      const thread = threads.get(msg.params?.threadId);
      if (!thread) return fail(-32602, `unknown thread ${msg.params?.threadId}`);
      send({ id: msg.id, result: threadPayload(thread) });
      break;
    }
    case 'turn/start': {
      if (LEGACY) return fail(-32601, 'method not found');
      const thread = threads.get(msg.params?.threadId);
      if (!thread) return fail(-32602, 'unknown thread');
      const turnId = `turn-${++turnSeq}`;
      turns.set(turnId, { threadId: thread.id, status: 'inProgress', steer: [] });
      // SLOW_START holds the reply open the way a loaded app-server can, so a
      // cancel arriving mid-flight exercises the pending-cancel path.
      const text = (msg.params?.input ?? []).map((i) => i.text ?? '').join('');
      const delay = text.includes('SLOW_START') || text.includes('LATE_START') ? 400 : 0;
      setTimeout(() => {
        if (text.includes('NO_TURN_ID')) {
          send({ id: msg.id, result: {} });
          return;
        }
        send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        void runTurn(turnId, msg.params);
      }, delay);
      break;
    }
    case 'turn/steer': {
      if (LEGACY) return fail(-32601, 'method not found');
      const turn = turns.get(msg.params?.expectedTurnId);
      if (!turn || turn.status !== 'inProgress') return fail(-32602, 'no such active turn');
      turn.steer.push((msg.params?.input ?? []).map((i) => i.text ?? '').join(''));
      send({ id: msg.id, result: { turnId: msg.params.expectedTurnId } });
      break;
    }
    case 'turn/interrupt': {
      if (LEGACY) return fail(-32601, 'method not found');
      const turn = turns.get(msg.params?.turnId);
      if (!turn) return fail(-32602, 'no such turn');
      turn.status = 'interrupted';
      send({ id: msg.id, result: { turn: { id: msg.params.turnId, status: 'interrupted' } } });
      notify('turn/completed', { threadId: turn.threadId, turn: { id: msg.params.turnId, status: 'interrupted' } });
      break;
    }
    case 'review/start': {
      if (LEGACY) return fail(-32601, 'method not found');
      const thread = threads.get(msg.params?.threadId);
      if (!thread) return fail(-32602, 'unknown thread');
      const turnId = `turn-${++turnSeq}`;
      turns.set(turnId, { threadId: thread.id, status: 'inProgress', steer: [] });
      send({
        id: msg.id,
        result: { reviewThreadId: `review-${thread.id}`, turn: { id: turnId, status: 'inProgress' } },
      });
      setTimeout(() => {
        notify('item/agentMessage/delta', {
          threadId: thread.id,
          turnId,
          delta: `REVIEW_OK:${msg.params?.target?.type ?? 'unknown'}`,
        });
        notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } });
      }, 10);
      break;
    }
    default:
      fail(-32601, `unsupported ${msg.method}`);
  }
});

rl.on('close', () => process.exit(0));
