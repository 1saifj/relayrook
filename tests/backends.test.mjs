import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKEND_IDS,
  allBackends,
  buildLaunchArgs,
  findConfigOption,
  getBackend,
  hasBackend,
  readEffortMetadata,
  readModelMetadata,
  resolveModel,
} from '../src/backends.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

test('the registry covers the five researched CLIs', () => {
  assert.deepEqual([...BACKEND_IDS].sort(), ['claude', 'codex', 'devin', 'kiro', 'opencode']);
  assert.equal(hasBackend('devin'), true);
  assert.equal(hasBackend('nope'), false);
  assert.throws(
    () => getBackend('nope'),
    (/** @type {any} */ err) => err.code === ERROR_CODES.unknown_backend,
  );
});

test('documented launch command lines are used verbatim', () => {
  const devin = getBackend('devin');
  assert.equal(devin.command, 'devin');
  assert.deepEqual(buildLaunchArgs(devin, {}), ['acp', '--model', 'swe-2-max']);

  const kiro = getBackend('kiro');
  assert.equal(kiro.command, 'kiro-cli');
  assert.deepEqual(buildLaunchArgs(kiro, { model: 'claude-opus-5', effort: 'max' }), [
    'acp',
    '--model',
    'claude-opus-5',
    '--effort',
    'max',
  ]);

  assert.deepEqual(buildLaunchArgs(getBackend('opencode'), { model: 'opencode-go/kimi-k2.7-code' }), ['acp']);
  assert.deepEqual(getBackend('codex').args, ['app-server', '--stdio']);
  assert.equal(getBackend('claude').command, 'claude-agent-acp');
});

test('the Devin swe-2-max pin is the default and is overridable only by an explicit pin', () => {
  const devin = getBackend('devin');
  assert.deepEqual(resolveModel(devin, null), { model: 'swe-2-max', source: 'backend-default' });
  assert.deepEqual(resolveModel(devin, 'other-model'), { model: 'other-model', source: 'pin' });
  assert.deepEqual(buildLaunchArgs(devin, { model: 'other-model' }), ['acp', '--model', 'other-model']);
});

test('legacy Kiro models metadata is read', () => {
  const sessionResult = {
    sessionId: 's1',
    models: {
      currentModelId: 'claude-opus-5',
      availableModels: [
        { modelId: 'auto', name: 'auto', description: 'Chosen by task' },
        { modelId: 'claude-opus-5', name: 'claude-opus-5', description: '1M context' },
      ],
    },
  };
  const meta = readModelMetadata(getBackend('kiro'), sessionResult);
  assert.equal(meta.metadataStyle, 'models');
  assert.equal(meta.currentModel, 'claude-opus-5');
  assert.deepEqual(
    meta.availableModels.map((m) => m.id),
    ['auto', 'claude-opus-5'],
  );
  assert.equal(meta.configId, null);
});

test('configOptions metadata is read on newer backends', () => {
  const sessionResult = {
    sessionId: 's2',
    configOptions: [
      { id: 'mode', category: 'mode', currentValue: 'auto', options: [{ value: 'auto' }] },
      {
        id: 'model',
        category: 'model',
        currentValue: 'opencode-go/kimi-k2.7-code',
        options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }, { value: 'opencode-go/kimi-k2.7-code' }],
      },
    ],
  };
  const meta = readModelMetadata(getBackend('opencode'), sessionResult);
  assert.equal(meta.metadataStyle, 'configOptions');
  assert.equal(meta.currentModel, 'opencode-go/kimi-k2.7-code');
  assert.equal(meta.configId, 'model');
  assert.equal(meta.availableModels.length, 2);
});

test('a backend advertising neither shape reports no model rather than guessing', () => {
  const meta = readModelMetadata(getBackend('devin'), { sessionId: 's3' });
  assert.equal(meta.currentModel, null);
  assert.deepEqual(meta.availableModels, []);
});

test('the effort option is discovered by category or id, not a hard-coded name', () => {
  const byCategory = readEffortMetadata({
    configOptions: [
      { id: 'thinking_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'high' }, { value: 'max' }] },
    ],
  });
  assert.equal(byCategory.configId, 'thinking_level');
  assert.equal(byCategory.currentEffort, 'high');
  assert.deepEqual(byCategory.availableEfforts, ['high', 'max']);

  const byId = readEffortMetadata({ configOptions: [{ id: 'reasoningEffort', currentValue: 'max', options: [] }] });
  assert.equal(byId.configId, 'reasoningEffort');

  const none = readEffortMetadata({ configOptions: [{ id: 'model', category: 'model' }] });
  assert.equal(none.configId, null);
});

test('findConfigOption prefers category then falls back to id patterns', () => {
  const options = [{ id: 'x', category: 'model' }, { id: 'effort' }];
  assert.equal(findConfigOption(options, 'model', []).id, 'x');
  assert.equal(findConfigOption(options, 'thought_level', [/effort/i]).id, 'effort');
  assert.equal(findConfigOption(undefined, 'model', []), null);
});

test('Codex declares discovery-only session support with a stated reason', () => {
  const codex = getBackend('codex');
  assert.equal(codex.sessionSupport, 'not-implemented');
  assert.match(codex.sessionSupportReason, /not implemented/i);
  const implemented = allBackends().filter((b) => b.sessionSupport === 'implemented').map((b) => b.id);
  assert.deepEqual(implemented.sort(), ['claude', 'devin', 'kiro', 'opencode']);
});

test('effort readback support is recorded per backend', () => {
  assert.equal(getBackend('kiro').effortReadback, true);
  assert.equal(getBackend('opencode').effortReadback, true);
});
