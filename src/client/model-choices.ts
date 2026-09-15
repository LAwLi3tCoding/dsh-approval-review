/**
 * Reviewer-route choices for the Approvals tab's model picker.
 *
 * The reviewer runs as a subagent, so the routes a deployment actually offers it
 * are already published as session projections — this module just reads them
 * instead of hardcoding a model list that would go stale:
 *
 * - `subagentModelSelectionPolicy`: the deployment's allowed subagent routes
 *   (`subagent-model-selection.allowedModels` in `settings.yaml`);
 * - `modelSelection.lastUsed`: the session's own route, i.e. what "inherit"
 *   resolves to.
 *
 * Everything is read structurally and defensively: a projection this host does
 * not publish, or an entry with a non-string half, contributes nothing rather
 * than breaking the picker.
 * @module dsh-approval-review/client/model-choices
 */

/** One `{provider, model}` route, when both halves are strings. */
function routeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { readonly provider?: unknown; readonly model?: unknown }
  if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') return undefined
  if (entry.provider.length === 0 || entry.model.length === 0) return undefined
  return `${entry.provider}/${entry.model}`
}

/** Every valid route in a projection that carries a list of them. */
function routesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const route = routeOf(entry)
    if (route !== undefined) out.push(route)
  }
  return out
}

/**
 * Every route in a client model-directory snapshot (`modelDirectories` service).
 *
 * This is the SAME catalog the composer's model seat and the `/model` picker
 * read, so the reviewer picker offers exactly the models the deployment
 * configures locally — minus anything the catalog failed to load, which it
 * reports separately and which we deliberately do not guess at.
 * @param value - the directory state returned by `directoryFor(session).load()`.
 * @returns distinct `provider/model` labels in catalog order.
 */
export function routesFromDirectory(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return []
  const groups = (value as { readonly groups?: unknown }).groups
  if (!Array.isArray(groups)) return []
  const out: string[] = []
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const id = (group as { readonly id?: unknown }).id
    const models = (group as { readonly models?: unknown }).models
    if (typeof id !== 'string' || id.length === 0 || !Array.isArray(models)) continue
    for (const model of models) {
      if (typeof model !== 'object' || model === null) continue
      const modelId = (model as { readonly id?: unknown }).id
      if (typeof modelId !== 'string' || modelId.length === 0) continue
      const route = `${id}/${modelId}`
      if (!out.includes(route)) out.push(route)
    }
  }
  return out
}

/**
 * Build the picker's option list.
 *
 * Order is deliberate: the session override in force first (so a route chosen
 * outside the deployment's list still shows as the current selection), then the
 * session's own model, then the deployment's allowed subagent routes. Duplicates
 * collapse, so a model that is both the session default and an allowed route
 * appears once.
 * @param input - the projections' raw values plus the override in force.
 * @returns distinct `provider/model` labels, in display order.
 */
export function reviewerRouteChoices(input: {
  /** The session override in force, as `provider/model`, when one is set. */
  readonly current?: string | undefined
  /** Raw `modelSelection` projection value. */
  readonly sessionDefault?: unknown
  /** Raw `subagentModelSelectionPolicy` projection value. */
  readonly allowed?: unknown
}): readonly string[] {
  const out: string[] = []
  const push = (route: string | undefined): void => {
    if (route === undefined || route.length === 0 || out.includes(route)) return
    out.push(route)
  }
  push(input.current)
  const session = typeof input.sessionDefault === 'object' && input.sessionDefault !== null
    ? (input.sessionDefault as { readonly lastUsed?: unknown }).lastUsed
    : undefined
  push(routeOf(session))
  for (const route of routesOf(input.allowed)) push(route)
  return out
}
