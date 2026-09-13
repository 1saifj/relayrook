#!/usr/bin/env node
/**
 * Deterministic ACP agent stub for the end-to-end session tests.
 *
 * Behaviour is driven by the prompt text so a test can exercise permissions,
 * cancellation, large payloads and slow turns without a paid model call:
 *
 *   NEED_PERMISSION  request a tool permission, then continue when answered
 *   BIG              emit a text chunk larger than the per-event cap
 *   SLOW             stay running until cancelled or the turn times out
 *   HEARTBEAT        stream a thought chunk every FAKE_ACP_HEARTBEAT_MS forever
 *   REFUSE           finish with stopReason "refusal"
 *   NO_STOP_REASON   return a result with no stopReason at all
 *
 * Env:
 *   FAKE_ACP_METADATA=models|configOptions   (default configOptions)
 *   FAKE_ACP_MODEL=<id>                      advertised current model
 *   FAKE_ACP_REJECT_MODEL=1                  set_config_option keeps the old value
 */
import readline from 'node:readline';

const METADATA = process.env.FAKE_ACP_METADATA ?? 'configOptions';
const CURRENT_MODEL = process.env.FAKE_ACP_MODEL ?? 'stub-model-1';
const REJECT_MODEL = process.env.FAKE_ACP_REJECT_MODEL === '1';

let sessionId = null;
let currentModel = CURRENT_MODEL;
let currentEffort = 'medium';
let activePrompt = null;
let nextRequestId = 1;
const pending = new Map();

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(sessionUpdate) {
  send({ method: 'session/update', params: { sessionId, update: sessionUpdate } });
}

function modelConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'stub-model-1', name: 'Stub 1' },
        { value: 'stub-model-2', name: 'Stub 2' },
        { value: CURRENT_MODEL, name: 'Configured' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: currentEffort,
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }],
    },
  ];
}

function legacyModels() {
  return {
    currentModelId: currentModel,
    availableModels: [
      { modelId: 'stub-model-1', name: 'stub-model-1', description: 'Stub 1' },
      { modelId: CURRENT_MODEL, name: CURRENT_MODEL, description: 'Configured' },
    ],
  };
}

async function runPrompt(id, params) {
  const text = (params.prompt ?? []).map((p) => p.text ?? '').join('');
  activePrompt = { id, cancelled: false, text };

  if (process.env.FAKE_KIRO_NOTIFY_EFFORT) {
    send({
      method: '_kiro.dev/metadata',
      params: { sessionId, effort: process.env.FAKE_KIRO_NOTIFY_EFFORT, contextUsagePercentage: 1 },
    });
  }

  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });

  if (text.includes('DOUBLE_PERMISSION')) {
    const ask = (suffix) => new Promise((resolve) => {
      const rpcId = 9100 + nextRequestId++;
      pending.set(rpcId, resolve);
      send({ id: rpcId, method: 'session/request_permission', params: {
        sessionId, requestId: `perm-${suffix}`,
        toolCall: { toolCallId: `exec_${suffix}`, title: `Run ${suffix}`, kind: 'execute' },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      } });
    });
    await Promise.all([ask('a'), ask('b')]);
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DOUBLE_PERMISSION_DONE' } });
    send({ id, result: { stopReason: activePrompt?.cancelled ? 'cancelled' : 'end_turn' } });
    activePrompt = null;
    return;
  }

  if (text.includes('NEED_PERMISSION') || text.includes('PERMISSION_WAIT_FOR_RESPONSE')) {
    const requestId = `perm-${nextRequestId}`;
    nextRequestId += 1;
    const rpcId = 9000 + nextRequestId;
    const decision = await new Promise((resolve) => {
      pending.set(rpcId, resolve);
      send({
        id: rpcId,
        method: 'session/request_permission',
        params: {
          sessionId,
          requestId,
          toolCall: { toolCallId: 'exec_1', title: 'Run printf', kind: 'execute' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
    });
    const outcome = decision?.outcome?.outcome ?? 'cancelled';
    const chosen = decision?.outcome?.optionId ?? null;
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PERMISSION:${outcome}:${chosen}` } });
    if (activePrompt?.cancelled) {
      send({ id, result: { stopReason: 'cancelled' } });
      activePrompt = null;
      return;
    }
    send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    activePrompt = null;
    return;
  }

  if (text.includes('BIG')) {
    const size = text.includes('BIG_2MB') ? 2 * 1024 * 1024 : 200000;
    const suffix = text.includes('BIG_2MB') ? '\n```relayrook-result\n{"status":"complete-no-findings"}\n```\n' : '';
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'X'.repeat(size) + suffix } });
    send({ id, result: { stopReason: 'end_turn' } });
    activePrompt = null;
    return;
  }

  if (text.includes('REFUSE')) {
    send({ id, result: { stopReason: 'refusal' } });
    activePrompt = null;
    return;
  }

  if (text.includes('NO_STOP_REASON')) {
    send({ id, result: { usage: { totalTokens: 1 } } });
    activePrompt = null;
    return;
  }

  if (text.includes('HEARTBEAT')) {
    // Busy but long: keeps streaming until cancelled, so an inactivity watchdog
    // must never fire while a wall-clock one eventually will.
    const everyMs = Number(process.env.FAKE_ACP_HEARTBEAT_MS ?? 100);
    const mine = activePrompt;
    const beat = setInterval(() => {
      // Identity-checked: a beat from a finished turn must never be mistaken
      // for progress on the turn that replaced it.
      if (activePrompt !== mine || mine.cancelled) {
        clearInterval(beat);
        return;
      }
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'still working' } });
    }, everyMs);
    beat.unref?.();
    return; // resolves only on cancel or timeout
  }

  if (text.includes('SLOW')) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    return; // resolves only on cancel or timeout
  }

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ROUTER_READY' } });
  update({ sessionUpdate: 'usage_update', used: 12, size: 1000 });
  send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } });
  activePrompt = null;
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

  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
          authMethods: [],
          agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        },
      });
      break;
    case 'session/new': {
      sessionId = 'stub-session-1';
      const result = { sessionId };
      if (METADATA === 'models') result.models = legacyModels();
      else result.configOptions = modelConfigOptions();
      send({ id: msg.id, result });
      break;
    }
    case 'session/set_config_option': {
      const { configId, value } = msg.params ?? {};
      if (configId === 'model' && !REJECT_MODEL) currentModel = value;
      if (configId === 'effort') currentEffort = value;
      send({ id: msg.id, result: { configOptions: modelConfigOptions() } });
      break;
    }
    case 'session/prompt':
      void runPrompt(msg.id, msg.params ?? {});
      break;
    case 'session/cancel':
      if (activePrompt) {
        activePrompt.cancelled = true;
        if (activePrompt.text.includes('PERMISSION_WAIT_FOR_RESPONSE')) break;
        for (const [rpcId, resolve] of pending) {
          pending.delete(rpcId);
          resolve({ outcome: { outcome: 'cancelled' } });
        }
        send({ id: activePrompt.id, result: { stopReason: 'cancelled' } });
        activePrompt = null;
      }
      break;
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } });
      }
  }
});

rl.on('close', () => process.exit(0));
