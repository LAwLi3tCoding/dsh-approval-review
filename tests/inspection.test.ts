import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInspector } from '../src/inspection.ts'
import { redactUnparsedText } from '../src/reviewer.ts'

const roots: string[] = []
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'approval-inspection-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return { root, cwd }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('isolated read-only inspection', () => {
  it('reads relevant scripts and redacts credential assignments', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, 'repair.sh'), 'echo repaired\nAPI_KEY=fixture-private-value\n')
    const inspect = createInspector(cwd, '{"command":"sh repair.sh"}', redactUnparsedText)
    const result = await inspect(JSON.stringify({ path: 'repair.sh', mode: 'read' }))
    expect(result).toContain('echo repaired')
    expect(result).not.toContain('fixture-private-value')
  })
  it('refuses traversal and symlinks to outside files', async () => {
    const { cwd, root } = await workspace()
    await writeFile(join(root, 'outside.txt'), 'private outside data')
    await symlink(join(root, 'outside.txt'), join(cwd, 'link'))
    const inspect = createInspector(cwd, '{}', redactUnparsedText)
    expect(await inspect(JSON.stringify({ path: '../outside.txt', mode: 'read' }))).toContain('Outside')
    expect(await inspect(JSON.stringify({ path: 'link', mode: 'read' }))).toContain('outside')
  })
  it('admits a named outside target but not its siblings', async () => {
    const { cwd, root } = await workspace()
    // realpath avoids the platform temp-directory alias in this explicit target fixture.
    const { realpath } = await import('node:fs/promises')
    const target = join(await realpath(root), 'target.txt')
    await writeFile(target, 'test target')
    const inspect = createInspector(cwd, JSON.stringify({ path: target }), redactUnparsedText)
    expect(await inspect(JSON.stringify({ path: target, mode: 'read' }))).toContain('test target')
    expect(await inspect(JSON.stringify({ path: join(root, 'sibling'), mode: 'stat' }))).toContain('Outside')
  })
  it('never reads a credential store even when named by the action', async () => {
    const { cwd } = await workspace()
    await writeFile(join(cwd, '.env'), 'SECRET=fixture')
    const inspect = createInspector(cwd, '{"path":".env"}', redactUnparsedText)
    expect(await inspect(JSON.stringify({ path: '.env', mode: 'read' }))).toContain('Credential-store')
  })
  it('reports missing, bounded directory contents and truncated text honestly', async () => {
    const { cwd } = await workspace()
    const inspect = createInspector(cwd, '{}', redactUnparsedText)
    expect(JSON.parse(await inspect('{"path":"missing","mode":"stat"}')).exists).toBe(false)
    await writeFile(join(cwd, 'large.txt'), 'a'.repeat(20000))
    expect(JSON.parse(await inspect('{"path":"large.txt","mode":"read"}')).truncated).toBe(true)
    expect(JSON.parse(await inspect('{"path":".","mode":"list"}')).entries).toHaveLength(1)
  })
})
