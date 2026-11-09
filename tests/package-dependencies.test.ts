/** Guard dependencies of the shipped host bundle, not just the source checkout. */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const bundle = ts.createSourceFile(
  'index.js',
  readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
)
const specifiers = new Set<string>()
function visit(node: ts.Node): void {
  const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
    ? node.moduleSpecifier
    : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      ? node.arguments[0]
      : undefined
  if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.add(specifier.text)
  ts.forEachChild(node, visit)
}
visit(bundle)

describe('published host dependencies', () => {
  it('declares every external package as a runtime dependency or required peer', () => {
    const packages = [...specifiers].filter(name => !isBuiltin(name) && !name.startsWith('.'))
      .map(name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
    expect(packages).toContain('zod')
    for (const name of packages) {
      const requiredPeer = manifest.peerDependencies[name] !== undefined
        && manifest.peerDependenciesMeta?.[name]?.optional !== true
      expect(manifest.dependencies[name] !== undefined || requiredPeer,
        `${name} is imported by lib/index.js but not declared for runtime installation`).toBe(true)
    }
  })

  it('uses the reviewed host Zod version without installing a separate direct dependency', () => {
    expect(manifest.peerDependencies.zod).toBe('4.4.3')
    expect(manifest.devDependencies.zod).toBe('4.4.3')
    expect(manifest.dependencies.zod).toBeUndefined()
  })
})
