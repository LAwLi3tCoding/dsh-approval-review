/** Networked package-install smoke test. No model credentials or install scripts are used. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'dsh-package-smoke-'))
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
})
const cases = [
  { version: '0.2.2-rc.1', cordis: '4.1.0', schemastery: '3.19.0', explicit: false, shared: true },
  { version: '0.2.1-rc.2', cordis: '4.0.5', schemastery: '3.18.5', explicit: false, shared: true },
  // This old host permits newer Zod transitively. Check both valid layouts.
  { version: '0.1.5-rc.3', cordis: '4.0.2', schemastery: '3.18.2', explicit: false, shared: false },
  { version: '0.1.5-rc.3', cordis: '4.0.2', schemastery: '3.18.2', explicit: true, shared: true },
]
const probe = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Approval from '@deepseek-ai/dsh-user-approval';
import Commands from '@deepseek-ai/dsh-commands';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as plugin from 'dsh-approval-review';
const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve('dsh-approval-review'));
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-session-projection'));
const shared = pluginRequire.resolve('zod') === hostRequire.resolve('zod');
assert.equal(pluginRequire('zod/package.json').version, '4.4.3');
if (process.argv[2] === 'shared') assert.equal(shared, true, 'expected the host-provided Zod instance');
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(Projections);
  await ctx.plugin(Approval);
  await ctx.plugin(Commands);
  new LlmRuntime(ctx);
  await ctx.plugin(plugin, { manageAccessModePreset: false });
  await new Promise(setImmediate);
  const session = ctx.sessions.create();
  session.append('turn/start', { turn: 1 });
  const snapshot = ctx.sessionProjections.snapshot(session);
  assert.ok(snapshot.values.approvalReview, 'plugin projection must register and validate its view');
  assert.equal(snapshot.values.approvalReview.total, 0);
  console.log(JSON.stringify({
    host: require('@deepseek-ai/dsh-session-projection/package.json').version,
    pluginZod: pluginRequire('zod/package.json').version,
    hostZod: hostRequire('zod/package.json').version,
    sharedZod: shared, importAndProjection: 'passed',
  }));
} finally { await ctx.fiber.dispose(); }
`

try {
  // An optional prebuilt tarball makes the pre-fix failure reproducible too.
  const supplied = process.argv[2]
  const tarball = supplied === undefined
    ? join(work, JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root))[0].filename)
    : resolve(supplied)
  for (const [index, entry] of cases.entries()) {
    const cwd = mkdtempSync(join(work, `host-${index}-`))
    const dependencies = Object.fromEntries(Object.keys(manifest.peerDependencies)
      .filter(name => name.startsWith('@deepseek-ai/'))
      .map(name => [name, name.startsWith('@deepseek-ai/dsh-')
        ? entry.version : name === '@deepseek-ai/cordis' ? entry.cordis : entry.schemastery]))
    dependencies[manifest.name] = `file:${tarball}`
    if (entry.explicit) dependencies.zod = '4.4.3'
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, 2))
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'),
      'nodeLinker: isolated\nhoist: false\nstrictPeerDependencies: true\nautoInstallPeers: true\n')
    writeFileSync(join(cwd, 'probe.mjs'), probe)
    run('pnpm', ['install', '--ignore-scripts', '--no-hoist', '--strict-peer-dependencies',
      ...process.env.PNPM_STORE_DIR ? ['--store-dir', process.env.PNPM_STORE_DIR] : [],
    ], cwd)
    console.log(run(process.execPath, ['probe.mjs', entry.shared ? 'shared' : 'compatible'], cwd).trim())
  }
  rmSync(work, { recursive: true, force: true })
} catch (error) {
  console.error(`Package smoke test failed. Fixture retained at ${work}`)
  if (error.stdout) console.error(String(error.stdout))
  if (error.stderr) console.error(String(error.stderr))
  throw error
}
