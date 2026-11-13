# DSH compatibility

The current development target is **DSH 0.2.2-rc.2**, the official npm `next`
version checked on 2026-11-13 (`latest` was still 0.2.2-rc.1). The DSH
development dependencies are pinned to that release so tests exercise its actual
APIs. The development Zod pin follows that host's 4.6.6 version to avoid
incompatible schema types from a second version.

Zod is also a required runtime peer at **`^4.4.3`**. The shipped host bundle
imports it directly, so a development-only declaration is not enough for an
isolated installation. It remains external and is not added as a separate direct
dependency. Hosts with automatic peer installation disabled must provide this
peer explicitly in the profile's dependency environment.

DSH 0.2.2-rc.2 moved its own Zod from 4.4.3 to 4.6.6. The previous exact `4.4.3`
peer made a strict install of that host add a second Zod copy for the plugin, and
an exact `4.4.3 || 4.6.6` union failed the older host's strict install, because
that host resolves a newer Zod through its own `^4.4.3`. The caret peer accepts
whichever compatible Zod the host provides. In the strict-install smoke test the
plugin shares one Zod package with DSH 0.2.2-rc.2 (4.6.6), 0.2.2-rc.1 and
0.2.1-rc.2 (4.4.3), and 0.1.5-rc.3, both with its transitive newer Zod and with
an explicit top-level `zod: "4.4.3"` provider. The projection boundary uses each
schema's own validation method, so a mixed layout is not assumed to be an
identity conflict either.

DSH 0.2.2-rc.2 also added `@deepseek-ai/dsh-error` (peer of `dsh-llm`) and
`@deepseek-ai/dsh-attachment` (peer of `dsh-commands`); both are development
dependencies only. The plugin does not import them, and its runtime peers are
unchanged.

The existing older-host peer ranges are retained. The newer clauses admit the
0.2.1 and 0.2.2 prerelease lines with ordinary npm semantics. Their upper bound
is `<0.3.0-0`: the host evaluates peers with `includePrerelease: true`, so
`<0.3.0` alone would also admit unreviewed 0.3.0 alpha and RC builds.

## API changes handled

- Tool results may be flat messages identified by `source.callId` instead of
  nested `tool-result` blocks. The audit trail and stop-on-rejection circuit
  breaker read both shapes, and reject conflicting result identities.
- Reviewer evidence declares its own `approval-review` message source instead
  of the removed catch-all `plugin` source.
- Modern subagents use `startActivation` rather than `start`. Passing the old
  `persona` and `toolFilter` fields to the new API would not enforce them.
  The adapter reserves a child ID, registers the recursion guard before
  creation, and installs the reviewer policy and hard tool restrictions in the
  host's awaited `agent/created` barrier before any child work is released.
- The modern child has both a scoped visibility restriction and an execution
  guard. Even a tool registered later in the child's own scope cannot execute
  outside the configured read-only subset of `read`, `glob`, and `grep`.
  Its complete, literal system prompt contains the reviewer policy. The
  parent's tools and prompt are unchanged.
- This modern path requires a local backend such as `spawn` or `fork`.
  Unsupported external providers and failed initialization follow the existing
  reviewer-failure policy; they do not receive an unrestricted fallback.
  Older hosts retain their capability-checked `start` path.

Cancellation, deadline, late-start disposal, and recursion-guard lifetime are
covered by regression tests. The latest-host native-execution test checks that
a child read runs, a dynamically registered child write is denied before its
body executes, the parent can still write, and the assembled reviewer prompt
contains the reviewer policy without inherited prompt text.

## Verification

Run `pnpm check` for TypeScript, the full test suite, and the checked-in host and
client bundles. The integration suite mounts the real approval service,
session-projection registry, and LLM runtime with a scripted model adapter.
The peer matrix also rejects 0.3.0 numeric, alpha, beta, RC, and stable versions.

Live Jev tests require `TYPESAFE_API_KEY` and are skipped without it. A passing
local suite does not claim live model-provider or desktop UI testing. The
checked-in bundles support GitHub installs; merging does not publish a new npm
release. Restart DSH after installing an updated plugin build.

`pnpm test:package` additionally builds and packs the plugin, installs it in
fresh isolated dependency fixtures with no hoisting and strict peer checks,
and verifies import plus the real host's projection registration/validation.
It covers 0.2.2-rc.2, 0.2.2-rc.1, 0.2.1-rc.2, and both older-host Zod layouts described above.
It needs registry access and pnpm, but runs no dependency install scripts or
live model calls. Set `PNPM_STORE_DIR` if the default pnpm store is unavailable.
To reproduce a packaging regression with an existing tarball, run
`node scripts/test-package.mjs /path/to/package.tgz`.

## Upstream contracts

- [Official 0.2.2-rc.2 source](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.2)
- [Compatibility evaluator](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts)
- [Subagent activation service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/subagent/subagent/src/index.ts)
- [Subagent manager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/subagent/subagent/src/manager.ts)
- [Message source and tool-result shapes](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/llm/llm/src/message.ts)
