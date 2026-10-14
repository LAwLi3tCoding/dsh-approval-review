/**
 * The access-mode entry's two guards.
 *
 * Case 1 (SELF-CHECK) is the behaviour that turns a silently inert plugin into a
 * stated one: when a later `permission` override has replaced the row this
 * package ships, the gate key is absent from the catalog and the plugin must say
 * so — at mount, and in `/approval-review status`.
 *
 * Case 2 (MANAGED ENTRY) is the install/uninstall lifecycle the operator asked
 * for: installing adds the menu entry, uninstalling removes it, and a shutdown
 * (which unmounts every plugin too) must NOT remove it. The uninstall signal is
 * the profile's own bundle list, so those cases drive a temp profile directory
 * rather than a stub.
 * @module dsh-approval-review/tests/access-mode-preset
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { apply, Config } from '../src/index.ts'
import type { Config as ConfigShape } from '../src/config.ts'
import {
  AccessModePreset,
  PACKAGE_NAME,
  PERMISSION_PRESETS_PACKAGE,
  SHIPPED_PRESET,
  SHIPPED_PRESET_KEY,
  describeAccessMode,
  type ConfigEditorLike,
  type LoaderEntryLike,
  type PermissionPresetsLike,
} from '../src/access-mode-preset.ts'

/** The three presets every deployment starts from. */
const BASE_PRESETS: Record<string, unknown> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

/** The keys a profile that never mentions this package offers. */
const BASE_KEYS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** The definition this package ships, as a mutable copy. */
const OWNED = { ...SHIPPED_PRESET } as Record<string, unknown>

/** The loader entry `configEditor` addresses for the permission row. */
const PERMISSION_ENTRY: LoaderEntryLike = {
  options: { id: 'permission', name: PERMISSION_PRESETS_PACKAGE },
}

/** Temp profile directories created by one case, removed afterwards. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A profile directory whose `package.json` decides whether the bundle still is
 * installed — the signal `detach()` reads.
 * @param bundles - the profile's `dsh.profile.bundles`, or undefined to omit the key.
 * @returns the profile patch path the fake editor reports.
 */
async function profileWith(bundles: readonly string[] | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'approval-review-profile-'))
  tempDirs.push(dir)
  const manifest = bundles === undefined ? {} : { dsh: { profile: { bundles: [...bundles] } } }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  return join(dir, 'cordis.patch.yml')
}

/** One recorded fake-editor call. */
interface EditorCall {
  readonly next: Record<string, unknown>
}

/** The fake editor, with the handles a case needs to model a live profile. */
interface FakeEditor extends ConfigEditorLike {
  /** Every `edit()` call the plugin made. */
  readonly calls: EditorCall[]
  /** How many `edit()` invocations were attempted, retries included. */
  readonly attempts: number
  /** The row's live config. */
  config(): Record<string, unknown>
  /** Replace the row's live config, as another layer or a reload would. */
  setConfig(next: Record<string, unknown>): void
  /** Replace the profile patch's own config for the row. */
  setOverride(next: Record<string, unknown>): void
}

/**
 * A `configEditor` stand-in that keeps the row's config in memory and records
 * every write, which is what the assertions read.
 * @param options - the row's starting config, its profile-patch override, the
 *   patch path to report, an optional failure to throw from `edit`, how many
 *   leading `edit` calls should fail the way a nested HMR transaction does, and
 *   the transaction store a real host would report as "inside a transaction".
 * @returns the editor plus its recorded state.
 */
function fakeEditor(options: {
  inherited?: Record<string, unknown>
  override?: Record<string, unknown>
  documentPath?: string
  fail?: Error
  failFirst?: number
  nested?: AsyncLocalStorage<boolean>
} = {}): FakeEditor {
  const inherited = options.inherited ?? { presets: { ...BASE_PRESETS } }
  let current: Record<string, unknown> = inherited
  let override: Record<string, unknown> = options.override ?? {}
  let failuresLeft = options.failFirst ?? 0
  let attempts = 0
  const calls: EditorCall[] = []
  return {
    calls,
    get attempts() { return attempts },
    config: () => current,
    setConfig: next => { current = next },
    setOverride: next => { override = next },
    entries: () => [PERMISSION_ENTRY],
    configuration: () => [{ entry: PERMISSION_ENTRY, inherited, override }],
    ...options.documentPath === undefined ? {} : { documentPath: options.documentPath },
    async edit(_entry, change) {
      attempts += 1
      if (options.fail !== undefined) throw options.fail
      // The host's real guard, reproduced exactly: `hmr.runExclusive()` rejects
      // whenever the CALLING async context still carries the transaction store,
      // and Node propagates that store into timers created inside it.
      if (options.nested?.getStore() === true) {
        throw new Error('HMR transactions cannot be nested')
      }
      if (failuresLeft > 0) {
        failuresLeft -= 1
        // The exact rejection the first live uninstall hit.
        throw new Error('HMR transactions cannot be nested')
      }
      const next = change(current, inherited)
      calls.push({ next })
      current = next
    },
  }
}

/** A `permissionPresets` stand-in that offers exactly the given keys. */
function fakeCatalog(values: readonly string[]): PermissionPresetsLike {
  return { catalog: () => ({ options: values.map(value => ({ value, name: value })) }) }
}

/** Resolve a plugin config the way the Loader does, defaults included. */
function configOf(overrides: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (value: unknown) => ConfigShape)(overrides)
}

/**
 * Capture the plugin's own log lines by shadowing the context's logger. Cordis
 * exposes `logger(name)` as a prototype method, so an own property on the
 * instance is what a test can redirect.
 * @param ctx - the mounting context.
 * @returns the captured lines, prefixed by level.
 */
function captureLogs(ctx: Context): string[] {
  const lines: string[] = []
  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    value: () => ({
      info: (message: string) => lines.push(`info ${message}`),
      warn: (message: string) => lines.push(`warn ${message}`),
      debug: (message: string) => lines.push(`debug ${message}`),
      error: (message: string) => lines.push(`error ${message}`),
    }),
  })
  return lines
}

/**
 * Wait for the deferred cleanup attempts to finish.
 *
 * Removal is scheduled on plain timers, never inline: an uninstall holds the HMR
 * transaction that is tearing the plugin down, and the profile write takes that
 * same lock. The cases inject millisecond delays, so this settles at once.
 * @returns a promise that resolves after the last attempt had time to run.
 */
const settle = (): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, 25)
})

/** Mount the owner with the services a case provides. */
async function mounted(options: {
  config?: Record<string, unknown>
  presets?: PermissionPresetsLike
  editor?: ConfigEditorLike
  hmr?: unknown
} = {}): Promise<{ owner: AccessModePreset; ctx: Context; logs: string[] }> {
  const ctx = new Context()
  const logs = captureLogs(ctx)
  if (options.editor !== undefined) ctx.provide('configEditor', options.editor as never)
  if (options.hmr !== undefined) ctx.provide('hmr', options.hmr as never)
  const owner = new AccessModePreset(ctx, configOf(options.config), [0, 1, 2])
  if (options.presets !== undefined) await owner.attach(options.presets)
  return { owner, ctx, logs }
}

/** The presets map of one row config, for assertions. */
function presetsOfConfig(config: Record<string, unknown>): Record<string, unknown> {
  return (config['presets'] ?? {}) as Record<string, unknown>
}

describe('shipped preset definition', () => {
  it('matches the bundle patch this package ships', async () => {
    const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const entry = new RegExp(
      `${SHIPPED_PRESET_KEY}:\\s*\\n\\s*sandbox:\\s*(\\S+)\\s*\\n\\s*approval:\\s*(\\S+)\\s*\\n`
      + '\\s*name:\\s*(\\S+)\\s*\\n\\s*description:\\s*(.+)',
      'u',
    ).exec(text)
    expect(entry, 'cordis.patch.yml no longer declares the preset this package owns').not.toBeNull()
    expect(entry?.[1]).toBe(SHIPPED_PRESET.sandbox)
    expect(entry?.[2]).toBe(SHIPPED_PRESET.approval)
    expect(entry?.[3]).toBe(SHIPPED_PRESET.name)
    expect(entry?.[4]?.trim()).toBe(SHIPPED_PRESET.description)
  })

  it('is the gate key and management default the schema ships', () => {
    const config = configOf()
    expect(config.reviewerPreset).toBe(SHIPPED_PRESET_KEY)
    expect(config.manageAccessModePreset).toBe(true)
  })
})

describe('self-check', () => {
  it('reports a catalog that already offers the gate key, without writing', async () => {
    const editor = fakeEditor()
    const { owner } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'provided' })
    expect(editor.calls).toHaveLength(0)
  })

  it('warns instead of writing when management is off', async () => {
    const editor = fakeEditor()
    const { owner, logs } = await mounted({
      config: { manageAccessModePreset: false },
      presets: fakeCatalog([...BASE_KEYS]),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'missing-unmanaged' })
    expect(editor.calls).toHaveLength(0)
    const warning = logs.find(line => line.startsWith('warn ')) ?? ''
    expect(warning).toContain(SHIPPED_PRESET_KEY)
    expect(warning).toContain('claims NOTHING')
    expect(warning).toContain('manageAccessModePreset')
  })

  it('warns when the key is missing and no config editor is mounted', async () => {
    const { owner, logs } = await mounted({ presets: fakeCatalog([...BASE_KEYS]) })
    expect(owner.state()).toEqual({ kind: 'missing-no-editor' })
    expect(logs.some(line => line.includes('configEditor'))).toBe(true)
  })

  it('has nothing to check when the gate claims in any access mode', async () => {
    const editor = fakeEditor()
    const { owner } = await mounted({
      config: { reviewerPreset: '' },
      presets: fakeCatalog(['read-only']),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'any-mode' })
    expect(editor.calls).toHaveLength(0)
  })

  it('keeps the plugin mounted when the editor refuses the write', async () => {
    const editor = fakeEditor({ fail: new Error('overridden by a home patch') })
    const { owner, logs } = await mounted({ presets: fakeCatalog([...BASE_KEYS]), editor })
    expect(owner.state()).toMatchObject({ kind: 'failed', detail: expect.stringContaining('home patch') })
    expect(logs.some(line => line.includes('access-mode preset check failed'))).toBe(true)
  })

  it('leaves a different definition that shares the key alone', async () => {
    const editor = fakeEditor({
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: { sandbox: 'danger-full-access', approval: 'ask' } } },
    })
    const { owner, logs } = await mounted({ presets: fakeCatalog([...BASE_KEYS]), editor })
    expect(owner.state()).toMatchObject({ kind: 'failed', detail: expect.stringContaining('different definition') })
    expect(editor.calls).toHaveLength(1)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY])
      .toEqual({ sandbox: 'danger-full-access', approval: 'ask' })
    expect(logs.some(line => line.includes('left untouched'))).toBe(true)
  })

  it('writes the missing entry while the mount itself runs inside a reload transaction', async () => {
    // An enable is an HMR transaction too, so the mount-time write has to leave
    // the store exactly like the removal does. This is the half that failed in
    // the field right after the uninstall half was fixed.
    const store = new AsyncLocalStorage<boolean>()
    const ctx = new Context()
    const logs = captureLogs(ctx)
    const editor = fakeEditor({ nested: store })
    ctx.provide('configEditor', editor as never)
    ctx.provide('hmr', { executing: store } as never)
    const owner = new AccessModePreset(ctx, configOf(), [0, 1, 2])
    await store.run(true, async () => {
      await owner.attach(fakeCatalog([...BASE_KEYS]))
    })
    expect(owner.state()).toEqual({ kind: 'written' })
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(OWNED)
    expect(logs.some(line => line.includes('hmr escape'))).toBe(true)
  })

  it('reports a mount-time write that could not leave the transaction', async () => {
    const store = new AsyncLocalStorage<boolean>()
    const ctx = new Context()
    const logs = captureLogs(ctx)
    const editor = fakeEditor({ nested: store })
    ctx.provide('configEditor', editor as never)
    const owner = new AccessModePreset(ctx, configOf(), [0, 1, 2])
    await store.run(true, async () => {
      await owner.attach(fakeCatalog([...BASE_KEYS]))
    })
    expect(owner.state().kind).toBe('failed')
    expect(editor.calls).toHaveLength(0)
    expect(logs.some(line => line.includes('could not write preset'))).toBe(true)
  })
})

describe('managed entry', () => {
  it('writes the missing entry into the profile patch, keeping the other presets', async () => {
    const editor = fakeEditor()
    const { owner, logs } = await mounted({ presets: fakeCatalog([...BASE_KEYS]), editor })
    expect(owner.state()).toEqual({ kind: 'written' })
    expect(editor.calls).toHaveLength(1)
    const presets = presetsOfConfig(editor.config())
    expect(Object.keys(presets)).toEqual([...BASE_KEYS, SHIPPED_PRESET_KEY])
    expect(presets[SHIPPED_PRESET_KEY]).toEqual(OWNED)
    expect(logs.some(line => line.includes('Wrote it into the profile patch'))).toBe(true)
  })

  it('adopts an identical entry a human already pasted into the profile patch', async () => {
    const editor = fakeEditor({
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
    })
    const { owner } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'adopted' })
    expect(editor.calls).toHaveLength(0)
  })

  it('does not adopt a customized entry that merely shares the key', async () => {
    const editor = fakeEditor({
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: { sandbox: 'danger-full-access', approval: 'ask' } } },
    })
    const { owner } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'provided' })
    expect(editor.calls).toHaveLength(0)
  })
})

describe('uninstall cleanup', () => {
  /** A mounted plugin whose entry came from the profile patch, with `bundles` on disk. */
  async function adopted(bundles: readonly string[] | undefined): Promise<{
    owner: AccessModePreset
    editor: FakeEditor
    logs: string[]
  }> {
    const documentPath = await profileWith(bundles)
    const editor = fakeEditor({
      documentPath,
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
    })
    const { owner, logs } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    expect(owner.state()).toEqual({ kind: 'adopted' })
    return { owner, editor, logs }
  }

  it('removes the entry once the bundle is gone from the profile', async () => {
    const { owner, editor } = await adopted(['dsh-base', 'dsh-web-app'])
    await owner.detach()
    await settle()
    expect(editor.calls).toHaveLength(1)
    const presets = presetsOfConfig(editor.config())
    expect(presets[SHIPPED_PRESET_KEY]).toBeUndefined()
    expect(Object.keys(presets)).toEqual([...BASE_KEYS])
  })

  it('retries a write that a nested HMR transaction rejected', async () => {
    const documentPath = await profileWith([])
    const editor = fakeEditor({
      documentPath,
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      failFirst: 1,
    })
    const { owner, logs } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    await owner.detach()
    await settle()
    expect(editor.attempts).toBe(2)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toBeUndefined()
    expect(logs.some(line => line.includes('removed access mode'))).toBe(true)
    expect(logs.some(line => line.includes('could not remove'))).toBe(false)
  })

  it('reports the leftover when every attempt stays blocked', async () => {
    const documentPath = await profileWith([])
    const editor = fakeEditor({
      documentPath,
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      failFirst: 3,
    })
    const { owner, logs } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    await owner.detach()
    await settle()
    expect(editor.attempts).toBe(3)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(OWNED)
    expect(logs.some(line => line.includes('could not remove access-mode preset'))).toBe(true)
  })

  it('leaves the reload transaction context before the deferred write', async () => {
    // The real mechanism: the host marks "inside an HMR transaction" with an
    // AsyncLocalStorage store, and Node carries that store into every timer the
    // transaction creates — so a deferred write is rejected as nested however
    // long it waits. Unmounting inside `store.run(...)` models the uninstall.
    const store = new AsyncLocalStorage<boolean>()
    const documentPath = await profileWith([])
    const editor = fakeEditor({
      documentPath,
      nested: store,
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
    })
    const { owner, logs } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
      hmr: { executing: store },
    })
    expect(owner.state()).toEqual({ kind: 'adopted' })
    await store.run(true, async () => {
      await owner.detach()
    })
    await settle()
    expect(editor.attempts).toBe(1)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toBeUndefined()
    expect(logs.some(line => line.includes('removed access mode'))).toBe(true)
  })

  it('reports the leftover when the transaction context cannot be left', async () => {
    // No `hmr` service to leave through: the deferred write keeps the caller's
    // context, so the guard keeps rejecting. The plugin must say so, not fail
    // silently — this is the fallback, not the expected path.
    const store = new AsyncLocalStorage<boolean>()
    const documentPath = await profileWith([])
    const editor = fakeEditor({
      documentPath,
      nested: store,
      override: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: OWNED } },
    })
    const { owner, logs } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    await store.run(true, async () => {
      await owner.detach()
    })
    await settle()
    expect(editor.attempts).toBe(3)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(OWNED)
    expect(logs.some(line => line.includes('could not remove access-mode preset'))).toBe(true)
  })

  it('keeps the entry on a shutdown, where the bundle is still installed', async () => {
    const { owner, editor, logs } = await adopted(['dsh-base', PACKAGE_NAME])
    await owner.detach()
    await settle()
    expect(editor.calls).toHaveLength(0)
    expect(editor.attempts).toBe(0)
    expect(logs.some(line => line.includes('keeping access-mode preset'))).toBe(true)
  })

  it('keeps an entry the operator has since customized', async () => {
    const { owner, editor, logs } = await adopted([])
    const customized = { ...OWNED, description: 'mine now' }
    editor.setOverride({ presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: customized } })
    editor.setConfig({ presets: { ...BASE_PRESETS, [SHIPPED_PRESET_KEY]: customized } })
    await owner.detach()
    await settle()
    expect(editor.calls).toHaveLength(0)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(customized)
    expect(logs.some(line => line.includes('kept access mode'))).toBe(true)
  })

  it('never empties the preset table', async () => {
    const documentPath = await profileWith([])
    const editor = fakeEditor({
      documentPath,
      override: { presets: { [SHIPPED_PRESET_KEY]: OWNED } },
      inherited: { presets: { [SHIPPED_PRESET_KEY]: OWNED } },
    })
    const { owner, logs } = await mounted({ presets: fakeCatalog([SHIPPED_PRESET_KEY]), editor })
    await owner.detach()
    await settle()
    expect(editor.calls).toHaveLength(0)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(OWNED)
    expect(logs.some(line => line.includes('no presets'))).toBe(true)
  })

  it('writes nothing at all when it never owned the entry', async () => {
    const documentPath = await profileWith([])
    const editor = fakeEditor({ documentPath })
    const { owner } = await mounted({
      presets: fakeCatalog([...BASE_KEYS, SHIPPED_PRESET_KEY]),
      editor,
    })
    await owner.detach()
    await settle()
    expect(editor.attempts).toBe(0)
  })
})

describe('mount wiring', () => {
  it('runs the check through the plugin mount, not only when called by hand', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const editor = fakeEditor()
    ctx.provide('configEditor', editor as never)
    ctx.provide('permissionPresets', fakeCatalog([...BASE_KEYS]) as never)
    apply(ctx, configOf())
    // `inject` delivers the service on the microtask queue, and the managed write
    // is issued immediately after it; a turn of the loop is enough for both.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(editor.calls).toHaveLength(1)
    expect(presetsOfConfig(editor.config())[SHIPPED_PRESET_KEY]).toEqual(OWNED)
  })
})

describe('status line', () => {
  it('names the shadowing override in both languages', () => {
    expect(describeAccessMode({ kind: 'provided' }, SHIPPED_PRESET_KEY, true)).toContain(SHIPPED_PRESET_KEY)
    expect(describeAccessMode({ kind: 'missing-unmanaged' }, SHIPPED_PRESET_KEY, true))
      .toContain('不会认领任何请求')
    expect(describeAccessMode({ kind: 'missing-unmanaged' }, SHIPPED_PRESET_KEY, false))
      .toContain('claims nothing')
    expect(describeAccessMode({ kind: 'written' }, SHIPPED_PRESET_KEY, false)).toContain('profile patch')
    expect(describeAccessMode({ kind: 'failed', detail: 'boom' }, SHIPPED_PRESET_KEY, true)).toContain('boom')
    expect(describeAccessMode({ kind: 'any-mode' }, '', true)).toContain('任意模式')
    expect(describeAccessMode({ kind: 'service-missing' }, SHIPPED_PRESET_KEY, false)).toContain('permissionPresets')
  })
})
