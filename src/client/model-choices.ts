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

import { JEV_ROUTE_PROVIDER } from '../model-override.ts'

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
 * Routes AND their display names from a client model-directory snapshot.
 *
 * The route id is what a command needs, but it is NOT the vendor's model name:
 * `deepseek-official/deepseek-flash` is the harness catalog's id whose display
 * name is "DeepSeek-V41-Flash", and a deployment's own providers name their
 * routes freely. Showing both is what stops "that model is not in my
 * subscription list" from being a mystery.
 * @param value - the directory state returned by `directoryFor(session).load()`.
 * @returns distinct route ids (catalog order) plus their display names.
 */
export function directoryRoutes(value: unknown): {
  readonly routes: readonly string[]
  readonly labels: Readonly<Record<string, string>>
} {
  const routes: string[] = []
  const labels: Record<string, string> = {}
  if (typeof value !== 'object' || value === null) return { routes, labels }
  const groups = (value as { readonly groups?: unknown }).groups
  if (!Array.isArray(groups)) return { routes, labels }
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
      if (!routes.includes(route)) routes.push(route)
      const name = (model as { readonly name?: unknown }).name
      if (typeof name === 'string' && name.length > 0 && name !== modelId) labels[route] = name
    }
  }
  return { routes, labels }
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
  return directoryRoutes(value).routes
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

/**
 * Filter routes for the picker's list.
 *
 * Matching is a case-insensitive substring over the whole `provider/model`
 * label, so typing `luna` and typing `codex/luna` both narrow to the same row.
 * An empty (or whitespace-only) query keeps the whole list.
 * @param routes - candidate labels.
 * @param query - what the operator typed.
 * @returns the matching labels, in input order.
 */
export function filterRoutes(routes: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return routes
  return routes.filter(route => route.toLowerCase().includes(needle))
}

/**
 * Jev model names the picker offers while the Jev engine is in force.
 *
 * Under `reviewer.engine: jev` this string is sent as the request's `model`
 * field, so these are the values that endpoint accepts; an LLM route id would be
 * rejected upstream.
 */
export const JEV_MODEL_CHOICES: readonly string[] = [
  `${JEV_ROUTE_PROVIDER}/jev-latest`,
  `${JEV_ROUTE_PROVIDER}/jev-preview`,
  `${JEV_ROUTE_PROVIDER}/jev-1.13.0`,
]

/**
 * The candidate list for the reviewer-model picker.
 *
 * One list spans both engines, and every row is a reviewer the session can
 * actually switch to: `provider/model` selects the LLM engine on that route, and
 * `typesafe/<model>` selects Jev. That is why the Jev rows carry their provider —
 * a bare model name only replaces a model on whatever engine is already in force,
 * which is how a listed row could be chosen and then visibly do nothing.
 * @param jevSelectable - whether the deployment acknowledged Jev egress; without
 * it a session may not switch to Jev, so those rows are not offered.
 * @param llmChoices - the LLM routes and the route in force, as the card sees them.
 * @returns distinct candidates, Jev models first when they are permitted.
 */
export function reviewerModelChoices(jevSelectable: boolean, llmChoices: readonly string[]): readonly string[] {
  const out: string[] = jevSelectable ? [...JEV_MODEL_CHOICES] : []
  const push = (value: string): void => {
    if (value.length > 0 && !out.includes(value)) out.push(value)
  }
  for (const route of llmChoices) push(route)
  return out
}
