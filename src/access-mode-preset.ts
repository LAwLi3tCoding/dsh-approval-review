/**
 * The access-mode option this package owns — and the two things that keep it
 * honest across an install/uninstall cycle.
 *
 * WHY THIS MODULE EXISTS
 *
 * The plugin's gate (`reviewerPreset`) is only reachable while the harness's
 * access-mode catalog contains an option with that key. The plugin ships that
 * option in its own bundle patch, but a bundle patch is a LAYER: an id-targeted
 * override REPLACES the whole `permission` row config, so any later layer that
 * restates the row without this entry (a profile patch pinning its own preset
 * table, which is the normal way a deployment sets `defaultPreset`) silently
 * drops it. The menu then shows three entries, the plugin claims nothing, and
 * nothing in the log says why.
 *
 * The two guards here:
 *
 * 1. SELF-CHECK (`reviewerPreset` missing from `catalog()`): warn at mount and
 *    report in `/approval-review status`, naming the cause and the fix, so the
 *    silent failure becomes a stated one.
 * 2. MANAGED ENTRY (`manageAccessModePreset: true`, the default): the plugin
 *    writes the option into the profile's own patch layer through the
 *    `configEditor` service — which is where a later override can no longer
 *    shadow it — and removes it again when the bundle is uninstalled. Installing
 *    the plugin therefore adds the menu entry; uninstalling removes it. No
 *    leftover option.
 *
 * Ownership is never assumed: the plugin adopts an identical entry it finds in
 * the profile patch (so an entry a human pasted there is still cleaned up on
 * uninstall), and it only ever removes a `presets[reviewerPreset]` that is
 * byte-identical to {@link SHIPPED_PRESET} — a customized entry is left alone
 * with a log line saying so.
 *
 * Both services are read STRUCTURALLY. This plugin must build and mount without
 * the `permissionPresets` or `configEditor` packages present: every deployment
 * shape that lacks them simply keeps the warning path instead of failing.
 * @module dsh-approval-review/access-mode-preset
 */

import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

/** This package's name, as the profile bundle list spells it. */
export const PACKAGE_NAME = 'dsh-approval-review'

/** The package that owns the `permission` row this plugin contributes to. */
export const PERMISSION_PRESETS_PACKAGE = '@deepseek-ai/dsh-permission-presets'

/** The row id that package's bundle patch uses, for deployments that rename the module. */
export const PERMISSION_ROW_ID = 'permission'

/** The preset key this package ships; the default of `Config.reviewerPreset`. */
export const SHIPPED_PRESET_KEY = 'approve-for-me'

/** One access-mode entry as the catalog exposes it. */
export interface PresetOption {
  /** The preset key written into the session log. */
  readonly value: string
  /** The label the access-mode control renders. */
  readonly name: string
  /** The one-line explanation the control renders. */
  readonly description?: string
}

/** The catalog `permissionPresets.catalog()` returns, read for the option list only. */
export interface PermissionCatalog {
  /** Every currently selectable preset: configured entries, then `auto` while it is live. */
  readonly options: readonly PresetOption[]
}

/** The `permissionPresets` service, structurally typed. */
export interface PermissionPresetsLike {
  /** Read the process-level catalog exposed to current-session UI. */
  catalog(): PermissionCatalog
}

/** One loader entry, as `configEditor` addresses it. */
export interface LoaderEntryLike {
  /** The loader's own entry options; `id` is the patch id, `name` the module name. */
  readonly options: {
    /** The patch id this entry was declared under. */
    readonly id: string
    /** The module name that implements the entry. */
    readonly name: string
  }
}

/** One addressable profile row: the entry, plus its inherited and explicit config. */
export interface ProfileRowLike {
  /** The active loader entry. */
  readonly entry: LoaderEntryLike
  /** The composed value WITHOUT this profile patch's own config for the row. */
  readonly inherited: Record<string, unknown>
  /** The profile patch's explicit config for the row, when it has one. */
  readonly override: Record<string, unknown>
}

/**
 * The `configEditor` service, structurally typed.
 *
 * `documentPath` is a getter on the service (the profile patch this editor
 * writes); it is read for the uninstall check and treated as optional, because
 * a deployment may expose the service without it.
 */
export interface ConfigEditorLike {
  /** Addressable profile rows with unique patch ids. */
  entries(): readonly LoaderEntryLike[]
  /** Inherited and explicit profile values for the active entries. */
  configuration(): readonly ProfileRowLike[]
  /**
   * The profile patch file this editor writes; absent on a foreign service.
   */
  readonly documentPath?: string
  /** Validate, persist, and reconcile one row's next config. */
  edit(
    entry: LoaderEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/**
 * The part of the host's `hmr` service this plugin needs: the escape hatch out of
 * a running reload transaction.
 *
 * `runExclusive` marks "inside a transaction" with an `AsyncLocalStorage` store,
 * and Node carries that store into anything the transaction creates. Leaving it
 * is what lets a deferred write be accepted instead of rejected as nested.
 */
export interface HmrLike {
  /** The transaction store; absent on a service that does not expose it. */
  readonly executing?: {
    /** Run `fn` with an empty store — the documented way out of the context. */
    exit<T>(fn: () => T): T
  }
}

/**
 * The preset this package owns.
 *
 * MUST stay byte-identical to the `approve-for-me` entry in this package's
 * `cordis.patch.yml`: that patch is what a deployment without a competing
 * override gets, and it is what the managed write reproduces. A test pins the
 * two together, so drift fails the build instead of shipping.
 *
 * The knobs deliberately match `workspace-write`: the difference is WHO answers
 * an approval (this plugin's reviewer instead of a human prompt), not how far
 * the agent may reach. Keeping the boundary identical is what lets a session
 * switch between "a human answers" and "the reviewer answers" without changing
 * what the agent is allowed to attempt.
 */
export const SHIPPED_PRESET = {
  sandbox: 'workspace-write',
  approval: 'ask',
  name: '替我审批',
  description: '与"工作区内修改"相同的边界，但需要批准的动作先交给复核模型，只有危险或不确定的才转人工。',
} as const

/**
 * What the self-check found, reported by `/approval-review status`.
 *
 * Every variant is a RESTING state, not an error: a deployment that pins its own
 * preset table without this entry is misconfigured, not broken, and the report
 * says which of the two it is.
 */
export type AccessModeState =
  /** `reviewerPreset` is empty: the plugin claims in any access mode, so there is no entry to keep. */
  | { readonly kind: 'any-mode' }
  /** No `permissionPresets` service in this composition: the gate cannot be checked. */
  | { readonly kind: 'service-missing' }
  /** The catalog already offers the key from another layer (this package's own bundle patch). */
  | { readonly kind: 'provided' }
  /** The profile patch holds an identical entry; this plugin owns its removal. */
  | { readonly kind: 'adopted' }
  /** The entry was missing and this plugin wrote it into the profile patch. */
  | { readonly kind: 'written' }
  /** The entry is missing and `manageAccessModePreset` is off. */
  | { readonly kind: 'missing-unmanaged' }
  /** The entry is missing, management is on, but no `configEditor` is mounted. */
  | { readonly kind: 'missing-no-editor' }
  /** The check or the write failed; `detail` carries the reason. */
  | { readonly kind: 'failed'; readonly detail: string }

/** A logger surface, taken from the mounting context. */
type Logger = Pick<ReturnType<Context['logger']>, 'info' | 'warn' | 'debug'>

/** Read a row config's `presets` map without trusting its shape. */
function presetsOf(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const presets = config?.['presets']
  return presets !== null && typeof presets === 'object' && !Array.isArray(presets)
    ? { ...(presets as Record<string, unknown>) }
    : {}
}

/** Whether one row config declares this package's preset verbatim. */
function declaresShippedPreset(config: Record<string, unknown> | undefined, key: string): boolean {
  return isDeepStrictEqual(presetsOf(config)[key], { ...SHIPPED_PRESET })
}

/** Structural read of an optional service, so this package needs no type outlet for it. */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const lookup = ctx as unknown as { get(key: string): unknown }
  const service = lookup.get(name)
  return service === undefined || service === null ? undefined : service as T
}

/**
 * The mounted `permissionPresets` service, read structurally.
 * @param ctx - any context in this composition.
 * @returns the service, or undefined when this deployment has none.
 */
export function readPermissionPresets(ctx: Context): PermissionPresetsLike | undefined {
  return serviceOf<PermissionPresetsLike>(ctx, 'permissionPresets')
}

/**
 * Delays before each cleanup attempt, in milliseconds.
 *
 * The first one is deliberately not zero: an uninstall holds the HMR transaction
 * that is tearing this plugin down, and `configEditor.edit()` refuses to run
 * inside one — the first live uninstall failed with exactly "HMR transactions
 * cannot be nested". The later entries retry a write that is still contending
 * with the reload it is part of.
 */
export const CLEANUP_DELAYS_MS: readonly number[] = [250, 1000, 3000]

/**
 * Keep this plugin's access-mode entry present while it is installed, and gone
 * once it is not.
 *
 * One instance lives for the plugin's mount. `attach()` runs when the
 * `permissionPresets` service is available (which may be after this plugin
 * mounts), `detach()` runs when the plugin unmounts, and `state()` is read by
 * the status command at any time.
 */
export class AccessModePreset {
  /** The last observed state; `service-missing` until `attach()` runs. */
  private observed: AccessModeState = { kind: 'service-missing' }
  /** Whether the profile patch currently holds an entry this plugin may remove. */
  private owned = false
  /** Pending cleanup attempts, held so a GC pass cannot drop a scheduled timer. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Set once the plugin is unmounting, so a late `attach()` cannot re-write config. */
  private stopped = false
  /** Why the last cleanup attempt failed, reported once the attempts run out. */
  private lastError: unknown
  /**
   * This plugin's own logger, captured at construction: the deferred cleanup runs
   * after the mounting context is disposed, and reporting must not depend on it.
   */
  private readonly log: Logger
  /**
   * The host's transaction store, captured while the `hmr` service is definitely
   * reachable. The cleanup needs it after this plugin's context is on its way
   * out, and a lookup at that moment is what failed in the field.
   */
  private hmrExecuting: HmrLike['executing']

  /**
   * @param ctx - the mounting context, used for service lookups.
   * @param config - validated plugin configuration.
   * @param cleanupDelaysMs - delay before each cleanup attempt; tests shorten it.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly cleanupDelaysMs: readonly number[] = CLEANUP_DELAYS_MS,
  ) {
    this.log = ctx.logger('dsh-approval-review')
    this.captureHmrStore()
  }

  /** Remember the transaction store while the service is still in scope. */
  private captureHmrStore(): void {
    try {
      this.hmrExecuting = serviceOf<HmrLike>(this.ctx, 'hmr')?.executing ?? this.hmrExecuting
    } catch {
      // A lookup that throws is the same as no lookup: the escape stays absent.
    }
  }

  /** The gate key this deployment configured; empty means "any access mode". */
  private get key(): string {
    return this.config.reviewerPreset
  }

  /** The `configEditor` service, when this composition has one. */
  private editor(): ConfigEditorLike | undefined {
    return serviceOf<ConfigEditorLike>(this.ctx, 'configEditor')
  }

  /** The `permission` row this plugin contributes to, as `configEditor` addresses it. */
  private permissionEntry(editor: ConfigEditorLike): LoaderEntryLike | undefined {
    return editor.entries().find(entry =>
      entry.options.name === PERMISSION_PRESETS_PACKAGE || entry.options.id === PERMISSION_ROW_ID)
  }

  /** The current state, for the status command. */
  state(): AccessModeState {
    return this.observed
  }

  /**
   * Run the self-check, and adopt or write the entry when that is what the
   * configuration asks for. Never throws: a deployment that cannot be repaired
   * still gets the answerer and a precise warning.
   * @param service - the mounted `permissionPresets` service.
   */
  async attach(service: PermissionPresetsLike): Promise<void> {
    try {
      await this.attachChecked(service)
    } catch (error) {
      this.fail('access-mode check crashed', error)
    }
  }

  /** {@link attach}, with the crash guard lifted so the branches stay readable. */
  private async attachChecked(service: PermissionPresetsLike): Promise<void> {
    if (this.stopped) return
    // The service may have arrived after construction; take the store now too.
    this.captureHmrStore()
    const key = this.key
    if (key.length === 0) {
      this.observed = { kind: 'any-mode' }
      return
    }
    let present: boolean
    try {
      present = service.catalog().options.some(option => option.value === key)
    } catch (error) {
      this.fail('could not read the access-mode catalog', error)
      return
    }
    const editor = this.editor()
    // An identical entry in the profile patch is adopted even when the catalog
    // already shows the key: that entry is the one a human pasted there, and it
    // is the one that would otherwise outlive an uninstall.
    if (editor !== undefined && this.profileOwns(editor, key)) {
      this.owned = true
      this.observed = { kind: 'adopted' }
      if (!present) {
        this.log.warn(
          `the profile patch declares preset "${key}" but the access-mode catalog does not offer it; `
          + 'the plugin will claim nothing until it does',
        )
      }
      return
    }
    if (present) {
      this.observed = { kind: 'provided' }
      return
    }
    if (!this.config.manageAccessModePreset) {
      this.observed = { kind: 'missing-unmanaged' }
      this.warnMissing('manageAccessModePreset is false, so this plugin will not write it')
      return
    }
    if (editor === undefined) {
      this.observed = { kind: 'missing-no-editor' }
      this.warnMissing('no `configEditor` service is mounted, so it cannot be written automatically')
      return
    }
    const entry = this.permissionEntry(editor)
    if (entry === undefined) {
      this.fail(`no loader entry for "${PERMISSION_PRESETS_PACKAGE}" to write the preset into`, undefined)
      return
    }
    let conflict = false
    const written = await this.writeWithRetries(editor, entry, current => {
      const presets = presetsOf(current)
      const existing = presets[key]
      // Never overwrite a DIFFERENT definition that happens to share the key:
      // an operator's wording or a deployment's own knobs are not this
      // package's to replace. The catalog said the key was absent, so this is
      // a defence against a stale read, not the expected path.
      if (existing !== undefined && !isDeepStrictEqual(existing, { ...SHIPPED_PRESET })) {
        conflict = true
        return current
      }
      return { ...current, presets: { ...presets, [key]: { ...SHIPPED_PRESET } } }
    })
    if (!written) {
      this.fail(`could not write preset "${key}" into the profile patch`, this.lastError)
      return
    }
    if (conflict) {
      this.fail(`preset "${key}" already exists with a different definition; left untouched`, undefined)
      return
    }
    if (this.stopped) {
      // Unmounted while the write was in flight: leave nothing behind.
      await this.detach()
      return
    }
    this.owned = true
    this.observed = { kind: 'written' }
    this.log.info(
      `access mode "${key}" was missing from the catalog — most likely a later \`permission\` override `
      + `replaced the row this package ships. Wrote it into the profile patch (manageAccessModePreset).`,
    )
  }

  /**
   * Remove the entry this plugin owns — after the unmount that triggered it.
   *
   * Unmount also happens on app shutdown and on every config reload, and removing
   * the entry then would delete the menu option on a normal exit. The signal used
   * is the profile's own bundle list: the plugin manager removes the package from
   * `dsh.profile.bundles` before it reconciles the tree, so a missing entry means
   * uninstall.
   *
   * The write CANNOT run inside this call. An uninstall holds the HMR transaction
   * that is tearing this plugin down, and `configEditor.edit()` takes that same
   * lock (`hmr.runExclusive`), which fails with "HMR transactions cannot be
   * nested" — the first live uninstall hit exactly that and left the entry
   * behind. The removal is therefore scheduled on a plain timer, outside the
   * transaction, and retried while the reload it belongs to still contends for
   * the lock. A normal exit (bundle still listed) keeps the entry, and the next
   * mount adopts it again.
   */
  async detach(): Promise<void> {
    try {
      await this.detachChecked()
    } catch (error) {
      this.warnOrphan(error)
    }
  }

  /** {@link detach}, with the crash guard lifted. */
  private async detachChecked(): Promise<void> {
    this.stopped = true
    if (!this.owned) return
    // Capture the editor NOW: the mounting context is being disposed, so the
    // deferred attempts must not look the service up again.
    const editor = this.editor()
    if (editor === undefined) {
      this.warnOrphan(new Error('no configEditor service to write through'))
      return
    }
    // Leave the transaction BEFORE anything is scheduled — see `leaveHmrContext`.
    this.leaveHmrContext(() => this.scheduleCleanup(editor, 0))
  }

  /**
   * Start `run` with the host's HMR transaction context LEFT BEHIND.
   *
   * `hmr.runExclusive()` refuses to nest by reading an `AsyncLocalStorage` store,
   * and Node propagates that store into everything created inside the
   * transaction — including a `setTimeout` scheduled from `dispose`. A deferred
   * write therefore stays "nested" however long it waits: 0.6.1's 250ms / 1s / 3s
   * retries all failed with the same rejection. The store has to be left BEFORE
   * the first timer exists, and the service that owns it is the only handle on it.
   * Without that service the work still runs: it simply keeps the caller's
   * context, which is correct for a mount that never happened inside a reload.
   * @param run - work to start outside the transaction.
   */
  private leaveHmrContext(run: () => void): void {
    const service = serviceOf<HmrLike>(this.ctx, 'hmr')
    const executing = this.hmrExecuting ?? service?.executing
    // One line, at info level, because this is the step that silently failed twice
    // in the field: it names whether the store was reachable and how.
    this.log.info(
      'access-mode cleanup: hmr escape '
      + `${executing === undefined ? 'UNAVAILABLE' : this.hmrExecuting === undefined ? 'via lookup' : 'via captured reference'}`
      + ` (service=${service === undefined ? 'absent' : 'present'}`
      + `, executing=${executing === undefined ? 'absent' : typeof executing}`
      + `, exit=${typeof executing?.exit})`,
    )
    if (executing === undefined || typeof executing.exit !== 'function') {
      run()
      return
    }
    try {
      executing.exit(run)
    } catch {
      run()
    }
  }

  /**
   * One config write, issued OUTSIDE the caller's reload transaction.
   *
   * Both directions need this. A removal runs during the uninstall that tears the
   * plugin down, and the mount-time write runs during the enable that mounts it —
   * both are HMR transactions, and `configEditor.edit()` takes that same lock. The
   * store is left before `edit()` is called, because the guard reads it
   * synchronously at the top of `runExclusive`.
   * @param editor - the config editor to write through.
   * @param entry - the row's loader entry.
   * @param change - the row's next config, derived from its current one.
   * @returns a promise for the write.
   */
  private editOutsideTransaction(
    editor: ConfigEditorLike,
    entry: LoaderEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.leaveHmrContext(() => {
        editor.edit(entry, change).then(resolve, reject)
      })
    })
  }

  /**
   * Write one row config, retrying while the transaction that holds the lock
   * outlives the attempt. `editOutsideTransaction` queues behind that transaction
   * rather than failing on it, but the row can still be replaced under a reload,
   * and the editor refuses a write whose entry moved.
   * @param editor - the config editor to write through.
   * @param entry - the row's loader entry.
   * @param change - the row's next config, derived from its current one.
   * @returns true once a write succeeded; false when every attempt failed.
   */
  private async writeWithRetries(
    editor: ConfigEditorLike,
    entry: LoaderEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<boolean> {
    // The first attempt is immediate: with the transaction store left behind,
    // `hmr.runExclusive` queues behind the running reload instead of failing, so
    // waiting first would only delay the menu. The configured delays separate the
    // RETRIES, which cover a row that moved under the reload.
    for (let attempt = 0; attempt <= this.cleanupDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        const delay = this.cleanupDelaysMs[attempt - 1] ?? 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      }
      try {
        await this.editOutsideTransaction(editor, entry, change)
        return true
      } catch (error) {
        this.lastError = error
      }
    }
    return false
  }

  /**
   * One deferred cleanup attempt, with retries.
   * @param editor - the config editor captured before disposal.
   * @param attempt - index into the configured delay list.
   */
  private scheduleCleanup(editor: ConfigEditorLike, attempt: number): void {
    const delay = this.cleanupDelaysMs[attempt]
    if (delay === undefined) {
      this.warnOrphan(this.lastError)
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void (async () => {
        try {
          if (await this.bundleStillInstalled(editor)) {
            this.log.debug(
              `keeping access-mode preset "${this.key}": the profile still lists ${PACKAGE_NAME}`,
            )
            return
          }
          if (await this.tryRemove(editor)) return
        } catch (error) {
          this.lastError = error
        }
        this.scheduleCleanup(editor, attempt + 1)
      })()
    }, delay)
    this.timers.add(timer)
  }

  /**
   * Delete this plugin's preset from the profile patch, when it is still ours.
   * @param editor - the config editor captured before disposal.
   * @returns true when there is nothing left to retry.
   */
  private async tryRemove(editor: ConfigEditorLike): Promise<boolean> {
    const entry = this.permissionEntry(editor)
    if (entry === undefined) {
      this.warnOrphan(new Error(`no loader entry for "${PERMISSION_PRESETS_PACKAGE}"`))
      return true
    }
    // Decide from the profile patch's OWN config before touching the loader: a
    // customized entry is somebody else's now, and an `edit` that changes
    // nothing would still rewrite the row.
    const row = this.configurationRow(editor)
    const overridePresets = presetsOf(row?.override)
    if (!isDeepStrictEqual(overridePresets[this.key], { ...SHIPPED_PRESET })) {
      this.log.info(
        `kept access mode "${this.key}": the profile patch no longer holds this package's definition`,
      )
      return true
    }
    if (Object.keys(overridePresets).length <= 1) {
      this.log.info(
        `kept access mode "${this.key}": removing it would leave the permission row with no presets`,
      )
      return true
    }
    try {
      await this.editOutsideTransaction(editor, entry, current => {
        const presets = presetsOf(current)
        // Re-check against the live config, which is what the write replaces.
        if (!isDeepStrictEqual(presets[this.key], { ...SHIPPED_PRESET })) return current
        if (Object.keys(presets).length <= 1) return current
        delete presets[this.key]
        return { ...current, presets }
      })
    } catch (error) {
      this.lastError = error
      return false
    }
    this.owned = false
    this.log.info(
      `removed access mode "${this.key}" from the profile patch (${PACKAGE_NAME} is uninstalled)`,
    )
    return true
  }

  /** Whether the profile's bundle list still includes this package. */
  private async bundleStillInstalled(editor: ConfigEditorLike): Promise<boolean> {
    const documentPath = editor.documentPath
    // No path to read: keep the entry. A leftover option is recoverable; a deleted
    // one on a normal exit is a support ticket.
    if (documentPath === undefined) return true
    try {
      const text = await readFile(join(dirname(documentPath), 'package.json'), 'utf8')
      const manifest = JSON.parse(text) as { dsh?: { profile?: { bundles?: unknown } } }
      const bundles = manifest.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) return true
      return bundles.includes(PACKAGE_NAME)
    } catch {
      return true
    }
  }

  /** The row `configEditor` reports for the `permission` entry, when it has one. */
  private configurationRow(editor: ConfigEditorLike): ProfileRowLike | undefined {
    return editor.configuration().find(candidate =>
      candidate.entry.options.name === PERMISSION_PRESETS_PACKAGE
      || candidate.entry.options.id === PERMISSION_ROW_ID)
  }

  /** Whether the profile patch's own config for the row declares this preset verbatim. */
  private profileOwns(editor: ConfigEditorLike, key: string): boolean {
    try {
      return declaresShippedPreset(this.configurationRow(editor)?.override, key)
    } catch (error) {
      this.log.debug(
        `access-mode ownership could not be read: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /** The warning for a gate key the catalog does not offer and this plugin cannot add. */
  private warnMissing(reason: string): void {
    this.log.warn(
      `reviewerPreset "${this.key}" is missing from the access-mode catalog: ${reason}. `
      + 'Until that entry exists the plugin claims NOTHING and every approval goes to a human. '
      + 'An id-targeted `permission` override replaces the whole row config, which is what drops the '
      + 'entry this package ships — restate it there, or leave manageAccessModePreset on so the plugin '
      + 'writes it itself.',
    )
  }

  /** The warning for an entry this plugin could not delete while unmounting. */
  private warnOrphan(error?: unknown): void {
    const detail = error === undefined ? '' : ` (${error instanceof Error ? error.message : String(error)})`
    this.log.warn(
      `could not remove access-mode preset "${this.key}" from the profile patch${detail}. `
      + `It is a harmless leftover — with ${PACKAGE_NAME} gone nothing claims those requests and they `
      + 'go to a human prompt — but the menu still shows the entry. Delete that key from the '
      + '`permission` row in the profile patch to tidy up.',
    )
  }

  /** Record a failure and warn, keeping the plugin mounted. */
  private fail(what: string, error: unknown): void {
    const detail = error === undefined ? what : `${what}: ${error instanceof Error ? error.message : String(error)}`
    this.observed = { kind: 'failed', detail }
    this.log.warn(`access-mode preset check failed — ${detail}`)
  }
}

/**
 * The status-command line for one observed state.
 * @param state - the state reported by {@link AccessModePreset.state}.
 * @param key - the configured `reviewerPreset`.
 * @param zh - whether the command output is Chinese.
 * @returns one line for `/approval-review status`.
 */
export function describeAccessMode(state: AccessModeState, key: string, zh: boolean): string {
  switch (state.kind) {
    case 'any-mode':
      return zh
        ? '访问模式目录：不适用（reviewerPreset 为空，任意模式都认领）'
        : 'Access-mode catalog: not applicable (reviewerPreset is empty; any mode claims)'
    case 'service-missing':
      return zh
        ? '访问模式目录：无法核对（permissionPresets 服务未挂载）'
        : 'Access-mode catalog: not checkable (no permissionPresets service)'
    case 'provided':
      return zh
        ? `访问模式目录：含 ${key}`
        : `Access-mode catalog: contains ${key}`
    case 'adopted':
      return zh
        ? `访问模式目录：含 ${key}（profile 补丁提供，卸载时随插件移除）`
        : `Access-mode catalog: contains ${key} (from the profile patch; removed on uninstall)`
    case 'written':
      return zh
        ? `访问模式目录：缺少 ${key}，已自动写入 profile 补丁`
        : `Access-mode catalog: ${key} was missing and has been written into the profile patch`
    case 'missing-unmanaged':
      return zh
        ? `访问模式目录：缺少 ${key}，且 manageAccessModePreset=false —— 本插件不会认领任何请求`
        : `Access-mode catalog: ${key} is missing and manageAccessModePreset=false — the plugin claims nothing`
    case 'missing-no-editor':
      return zh
        ? `访问模式目录：缺少 ${key}，且 configEditor 不可用，需手动补进 permission 行`
        : `Access-mode catalog: ${key} is missing and configEditor is unavailable — add it by hand`
    case 'failed':
      return zh
        ? `访问模式目录：核对失败（${state.detail}）`
        : `Access-mode catalog: check failed (${state.detail})`
  }
}
