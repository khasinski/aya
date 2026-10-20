// Measures the production automatic-input adapter with and without user files.
// Offline only: the host bridge below validates the real VT revision but does
// not open a socket, write to a PTY, launch Aya, or paint a renderer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');

process.chdir(path.resolve(__dirname, '..'));
const { UserRuleProvider } = require('../dist-electron/screen-user-rule-provider.js');
const { GuardedRuleInput } = require('../dist-electron/screen-user-rule-input.js');
const { loadBundledScreenRules } = require('../dist-electron/screen-rule-data.js');
const { openVtPane, closeVtPane, writeVtPane, vtSnapshot, vtSnapshotMatches } = require('../dist-electron/vt-mirror.js');

const paneCount = 25;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const stats = values => ({
  samples: values.length,
  meanUs: values.reduce((sum, value) => sum + value, 0) / values.length,
  p50Us: percentile(values, 0.50),
  p95Us: percentile(values, 0.95),
  maxUs: Math.max(...values),
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function makeFixture(withRules) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aya-user-rule-delivery-home-'));
  fs.chmodSync(home, 0o700);
  const directory = path.join(home, 'screen-rules');
  if (withRules) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'claude.json'), JSON.stringify({
      schemaVersion: 1,
      ruleSetVersion: 'delivery-benchmark-1',
      agent: 'claude',
      rules: [{ id: 'benchmark-no-match', kind: 'prompt', region: 'tail', pattern: 'NEVER_MATCH_AYA_BENCHMARK_8f2c', flags: '' }],
    }), { mode: 0o600 });
  }

  const provider = new UserRuleProvider(directory, loadBundledScreenRules());
  const startupStart = performance.now();
  provider.start();
  if (withRules) await waitFor(() => provider.configuration().available && !!provider.configuration().manifest, 5000, 'user rule worker initialization');
  else assert.deepEqual(provider.configuration().manifest, null);
  const providerStartupMs = performance.now() - startupStart;

  const paneIds = Array.from({ length: paneCount }, (_, index) => `delivery-latency-fixture-${index}`);
  const screens = new Map();
  for (const paneId of paneIds) {
    openVtPane(paneId, 120, 40, () => {}, 'claude', false);
    writeVtPane(paneId, '❯ ');
  }
  for (const paneId of paneIds) {
    const screen = await vtSnapshot(paneId);
    assert.ok(screen?.revision, 'benchmark needs a host-applied revision');
    assert.equal(screen.agent, 'claude');
    screens.set(paneId, screen);
  }
  // Let the mirrors' normal post-output status scans settle before timing an
  // idle-pane delivery; otherwise all 25 setup timers land inside the sample.
  await delay(300);
  const calls = { snapshot: 0, check: 0, legacyWrite: 0, fencedWrite: 0 };
  const host = {
    snapshot: async id => { assert.ok(screens.has(id)); calls.snapshot++; return screens.get(id); },
    check: async (id, fence) => { calls.check++; return screens.has(id) && vtSnapshotMatches(id, fence); },
    writeLegacy: async (id, data, stillAllowed) => {
      assert.ok(screens.has(id));
      if (stillAllowed && !stillAllowed()) throw new Error('legacy write refused');
      calls.legacyWrite++;
      return true;
    },
    writeFenced: async (id, data, fence) => {
      if (!screens.has(id) || !vtSnapshotMatches(id, fence)) throw new Error('stale benchmark fence');
      calls.fencedWrite++;
      return true;
    },
  };
  const input = new GuardedRuleInput(provider, host);
  return {
    provider, input, calls, paneIds, providerStartupMs,
    close: async () => {
      input.dispose();
      for (const paneId of paneIds) closeVtPane(paneId);
      await provider.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function sample(fixture, count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const paneId = fixture.paneIds[i % fixture.paneIds.length];
    const result = await fixture.input.write('team', paneId, `benchmark ${i}`, { phase: 'paste' });
    assert.equal(result, true);
      values.push((performance.now() - start) * 1000); // microseconds
  }
  return values;
}

(async () => {
  const rawUs = {};
  const cases = {};
  for (const [name, withRules] of [['noUserFiles', false], ['withUserFile', true]]) {
    const fixture = await makeFixture(withRules);
    try {
      // Warm the adapter and, for the configured case, the already-initialized worker.
      await sample(fixture, 20);
      const values = await sample(fixture, 200);
      rawUs[name] = values;
      cases[name] = {
        ...stats(values),
        paneCount,
        providerStartupMs: fixture.providerStartupMs,
        workerStarted: withRules,
        calls: fixture.calls,
      };
      if (withRules) {
        assert.equal(fixture.calls.snapshot, 220);
        assert.equal(fixture.calls.check, 220);
        assert.equal(fixture.calls.fencedWrite, 220);
        assert.equal(fixture.calls.legacyWrite, 0);
      } else {
        assert.equal(fixture.calls.snapshot, 0, 'no-file fast path must not acquire screen snapshots');
        assert.equal(fixture.calls.check, 0, 'no-file fast path must not check revisions');
        assert.equal(fixture.calls.fencedWrite, 0);
        assert.equal(fixture.calls.legacyWrite, 220);
      }
    } finally {
      await fixture.close();
    }
  }
  const result = {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    panes: { count: paneCount, agent: 'claude', cols: 120, rows: 40, shell: false, composerSeen: true },
    fixtureRule: 'one real private user/claude.json prompt rule that cannot match the benchmark screen',
    warmupWrites: 20,
    measuredWrites: 200,
    cases,
    rawUs,
    scope: 'One local serialized trial across 25 active xterm VT mirrors (120x40 Claude idle composers) using the real UserRuleProvider, UserRuleRuntime worker, coordinator and GuardedRuleInput. The host adapter uses applied xterm snapshots and checks each live revision, but host calls are in-process stubs: no socket/PTY, team transport, Aya startup, renderer DOM or paint is measured. The no-file case verifies the production legacy fast path issues zero snapshot/revision/evaluator requests. The user-file case includes snapshot acquisition, real worker evaluation, current-revision check and guarded-write dispatch. This is not a concurrent 25-request saturation test. Latencies are microseconds; nearest-rank percentiles use ceil(n*p). The monotonic performance.now interval includes promise and instrumentation overhead.',
  };
  fs.mkdirSync('test-results', { recursive: true });
  const runtime = process.versions.electron ? 'electron' : 'node';
  fs.writeFileSync(`test-results/screen-user-rule-delivery-${runtime}.json`, JSON.stringify(result, null, 2) + '\n');
  const { rawUs: _rawUs, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
