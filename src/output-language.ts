/**
 * Resolve the language this plugin EMITS in, from the harness's own setting.
 *
 * Host-side only, and deliberately not the browser: a reviewer call, a command
 * result, and a log line are all produced where `navigator.language` does not
 * exist. The single source of truth is the `locale` settings namespace behind
 * `设置 → 通用 → 语言` — the same value the language picker writes.
 *
 * ONE resolver serves every consumer, which is the point: a deployment must not
 * be able to end up with a Chinese ledger beside English reviewer prose. The
 * configured `language` decides (`auto` by default), and `auto` reads the live
 * preference at every call, so a switch applies to the NEXT command and the NEXT
 * verdict without a restart.
 *
 * What this does NOT govern, by design: text already recorded in the session log
 * — a previous verdict's prose, a command's earlier output — and the wire enums
 * (`allow`/`deny`, `low`/`medium`/…), which the parser validates as English
 * tokens. See `docs`/README for the boundary.
 * @module dsh-approval-review/output-language
 */

import type { Context } from '@deepseek-ai/cordis'

/** A language this plugin can emit prose in. */
export type OutputLanguage = 'en' | 'zh'

/** The `language` setting: an explicit language, or follow the harness. */
export type LanguageSetting = OutputLanguage | 'auto'

/**
 * The host settings registry, read structurally and OPTIONALLY.
 *
 * `settings` belongs to another plugin and this plugin declares no dependency on
 * it, so only the single read used here is declared. A host without it never
 * sees a language preference, which is not an error.
 */
interface SettingsFace {
  /**
   * @param ns - settings namespace to read.
   * @returns the namespace's resolved value, or undefined while unregistered.
   */
  get(ns: string): unknown
}

/** The `locale` settings section the language picker writes. */
interface LocaleSection {
  /** Explicit language id; absent delegates the choice to the browser. */
  readonly preference?: unknown
}

/**
 * Resolve the language this plugin should emit prose in.
 *
 * With no settings service, or with no explicit preference recorded, this falls
 * back to English — the same fallback the browser half's locale catalog uses,
 * because an absent preference delegates the choice to a browser the host cannot
 * see.
 * @param ctx - host context whose optional settings service owns the section.
 * @param config - resolved plugin config (only `language` is read).
 * @returns the language to emit.
 */
export function resolveOutputLanguage(
  ctx: Context,
  config: { readonly language: LanguageSetting },
): OutputLanguage {
  if (config.language !== 'auto') return config.language
  const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as SettingsFace | undefined
  const section = settings?.get?.('locale') as LocaleSection | undefined
  const preference = section?.preference
  return typeof preference === 'string' && preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Whether the resolved output language is Chinese.
 *
 * @param ctx - host context whose optional settings service owns the section.
 * @param config - resolved plugin config (only `language` is read).
 * @returns true when emitted prose should be Chinese.
 */
export function outputIsZh(
  ctx: Context,
  config: { readonly language: LanguageSetting },
): boolean {
  return resolveOutputLanguage(ctx, config) === 'zh'
}
