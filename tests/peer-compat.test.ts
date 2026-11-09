/**
 * Compatibility guard: the DSH Loader refuses a plugin whose own dsh requirements
 * the running host does not satisfy — at install time and again at every profile
 * startup — comparing the runtime version against `engines.dsh` when present,
 * otherwise against every `@deepseek-ai/dsh*` peer with `includePrerelease: true`.
 * A stale upper bound silently disables the plugin, so the supported matrix is
 * pinned here.
 * @module dsh-approval-review/tests/peer-compat
 */

import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

/** DSH runtimes this package claims to load on. Widen a peer range before adding a version. */
const SUPPORTED_DSH_VERSIONS = ['0.1.5-rc.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.5', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1']

/** The line this package must not claim yet: a new minor needs its own review. */
const UNSUPPORTED_DSH_VERSIONS = ['0.1.2-alpha.1', '0.3.0-0', '0.3.0-alpha.1', '0.3.0-beta.1', '0.3.0-rc.1', '0.3.0', '1.0.0']

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies: Record<string, string>; peerDependencies: Record<string, string> }

const dshPeers = Object.entries(manifest.peerDependencies).filter(
  ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
)

describe('dsh peer compatibility', () => {
  it('declares the dsh packages it loads against', () => {
    expect(dshPeers).toHaveLength(7)
    expect(new Set(dshPeers.map(([, range]) => range)).size).toBe(1)
  })

  it.each(SUPPORTED_DSH_VERSIONS)('accepts DSH %s', (version) => {
    for (const [name, range] of dshPeers) {
      expect(
        satisfies(version, range, { includePrerelease: true }),
        `${name} rejects DSH ${version}: ${range}`,
      ).toBe(true)
    }
  })

  it('develops and tests against the latest reviewed host, including npm prerelease semantics', () => {
    for (const [name, range] of dshPeers) {
      expect(manifest.devDependencies[name]).toBe('0.2.2-rc.1')
      expect(satisfies('0.2.2-rc.1', range), `${name} rejects the tested prerelease in npm`).toBe(true)
    }
  })

  it.each(UNSUPPORTED_DSH_VERSIONS)('refuses unreviewed DSH %s', (version) => {
    for (const [name, range] of dshPeers) {
      expect(
        satisfies(version, range, { includePrerelease: true }),
        `${name} accepts ${version}`,
      ).toBe(false)
    }
  })
})
