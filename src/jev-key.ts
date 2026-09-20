/**
 * Resolving the Jev API key.
 *
 * The DSH credential seam is asked FIRST, because it already layers every source
 * a deployment may legitimately use — the launch environment, the managed
 * `$DSH_HOME/.credentials.yaml` (writable from the app's own settings UI), the
 * project `.env` and `$DSH_HOME/.env` — and it re-resolves per request, so a
 * rotated key needs no restart. Reading `process.env` directly stays as the
 * fallback for a deployment that does not mount the credentials row.
 *
 * This matters for more than convenience: a GUI-launched harness never runs the
 * user's shell startup files, so a key exported in `~/.zshenv` is invisible to it.
 * Going through the seam means "paste the key into DSH's credentials UI" is a
 * complete setup, for every installer, with no shell or launch-environment work.
 *
 * The seam is read structurally: this plugin must build without depending on
 * another package's type outlet, exactly as it already does for the `permissions`
 * projection. The ref is a plain POSIX identifier at runtime — a branded
 * `CredentialRef` is a compile-time construct only.
 * @module dsh-approval-review/jev-key
 */

/** Where a resolved key came from, for the log line and the status report. */
export type JevKeySource = 'credentials' | 'process-env' | 'none'

/** The outcome of one key lookup; `key` is absent when nothing was found. */
export interface JevKeyResolution {
  /** The key itself. Never logged and never written to the audit record. */
  readonly key?: string
  /** Which layer answered. */
  readonly source: JevKeySource
  /** The seam's own reported provenance (`user-env`, `file`, …), when it resolved. */
  readonly detail?: string
  /** Why the seam could not be used, when it threw. */
  readonly failure?: string
}

/** The part of `ctx.credentials` this plugin uses. */
export interface CredentialSeamLike {
  /** Resolve one credential ref, or `undefined` when it is not configured. */
  resolve(ref: string): Promise<unknown>
}

/**
 * Read the credential seam off a context value without trusting its shape.
 * @param value - whatever `ctx.get('credentials')` returned.
 * @returns the seam when it looks usable, otherwise undefined.
 */
export function readCredentialSeam(value: unknown): CredentialSeamLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const resolve = (value as { readonly resolve?: unknown }).resolve
  if (typeof resolve !== 'function') return undefined
  return { resolve: (ref: string) => (resolve as (ref: string) => Promise<unknown>).call(value, ref) }
}

/** A non-empty, trimmed string, or undefined. */
function usable(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : undefined
}

/**
 * Resolve the Jev API key: credential seam first, then the process environment.
 * @param input - the variable name, the seam (when mounted), and an environment.
 * @returns the key and its provenance; never throws.
 */
export async function resolveJevApiKey(input: {
  /** Environment variable name, from `reviewer.jev.apiKeyEnv`. */
  readonly envName: string
  /** The credential seam, when the deployment mounts one. */
  readonly seam?: CredentialSeamLike | undefined
  /** Environment to fall back to (`process.env` in production). */
  readonly env: Readonly<Record<string, string | undefined>>
}): Promise<JevKeyResolution> {
  let failure: string | undefined
  if (input.seam !== undefined) {
    try {
      const hit = await input.seam.resolve(input.envName)
      if (typeof hit === 'object' && hit !== null) {
        const key = usable((hit as { readonly value?: unknown }).value)
        if (key !== undefined) {
          const source = (hit as { readonly source?: unknown }).source
          return {
            key,
            source: 'credentials',
            ...typeof source === 'string' && source.length > 0 ? { detail: source } : {},
          }
        }
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  const fromEnv = usable(input.env[input.envName])
  if (fromEnv !== undefined) {
    return { key: fromEnv, source: 'process-env', ...failure === undefined ? {} : { failure } }
  }
  return { source: 'none', ...failure === undefined ? {} : { failure } }
}
