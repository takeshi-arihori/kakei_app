import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname);
const acceptedContexts = new Set([
  'group-management',
  'expense-recording',
  'settlement',
]);

type ContextLayer =
  'domain' | 'application' | 'presentation' | 'infrastructure';

type ModuleRole =
  | Readonly<{
      kind: 'context';
      context: string;
      layer: ContextLayer;
    }>
  | Readonly<{ kind: 'shared-domain' }>
  | Readonly<{ kind: 'shared-presentation'; generated: boolean }>
  | Readonly<{ kind: 'composition' }>
  | Readonly<{ kind: 'test' }>
  | Readonly<{ kind: 'unknown' }>;

type ModuleReference = Readonly<{
  specifier: string;
  line: number;
  analyzable: boolean;
}>;

const normalize = (path: string): string => path.split(sep).join('/');

const relativeToSource = (path: string): string =>
  normalize(relative(sourceRoot, path));

const isTestModulePath = (relativePath: string): boolean =>
  relativePath.endsWith('.spec.ts') ||
  relativePath.endsWith('.test.ts') ||
  relativePath.includes('/test/') ||
  relativePath.startsWith('test/') ||
  relativePath.includes('/__tests__/') ||
  relativePath.startsWith('__tests__/');

const classifyModule = (path: string): ModuleRole => {
  const relativePath = relativeToSource(path);

  if (isTestModulePath(relativePath)) {
    return { kind: 'test' };
  }

  if (relativePath === 'app.ts' || relativePath === 'main.ts') {
    return { kind: 'composition' };
  }

  if (relativePath.startsWith('shared/domain/')) {
    return { kind: 'shared-domain' };
  }

  if (relativePath.startsWith('presentation/graphql/')) {
    return {
      kind: 'shared-presentation',
      generated: relativePath.startsWith('presentation/graphql/generated/'),
    };
  }

  const [context, layer] = relativePath.split('/');
  if (
    context !== undefined &&
    layer !== undefined &&
    acceptedContexts.has(context) &&
    ['domain', 'application', 'presentation', 'infrastructure'].includes(layer)
  ) {
    return {
      kind: 'context',
      context,
      layer: layer as ContextLayer,
    };
  }

  return { kind: 'unknown' };
};

const collectModuleReferences = (
  sourceFile: ts.SourceFile,
): ModuleReference[] => {
  const references: ModuleReference[] = [];

  const addReference = (literal: ts.StringLiteralLike) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      literal.getStart(sourceFile),
    );
    references.push({
      specifier: literal.text,
      line: line + 1,
      analyzable: true,
    });
  };

  const addNonLiteralReference = (node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    references.push({
      specifier: '<non-literal-dynamic-import>',
      line: line + 1,
      analyzable: false,
    });
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addReference(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addReference(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        addReference(argument);
      } else {
        addNonLiteralReference(node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
};

const isExternalSpecifier = (specifier: string): boolean =>
  !specifier.startsWith('.') && !specifier.startsWith('/');

const validateProductionModuleLocation = (path: string): string | null => {
  const role = classifyModule(path);
  if (role.kind === 'unknown') {
    return `${relativeToSource(path)} is outside the accepted context and layer layout`;
  }
  if (role.kind === 'test') {
    return `${relativeToSource(path)} is a test module in the production scan`;
  }
  return null;
};

const validateDependency = (
  sourcePath: string,
  specifier: string,
  resolvedPath?: string,
): string | null => {
  const source = classifyModule(sourcePath);
  const sourceViolation = validateProductionModuleLocation(sourcePath);
  if (sourceViolation !== null) {
    return sourceViolation;
  }
  if (source.kind === 'unknown' || source.kind === 'test') {
    return `${relativeToSource(sourcePath)} is not production code`;
  }

  if (isExternalSpecifier(specifier)) {
    if (
      source.kind === 'shared-domain' ||
      (source.kind === 'context' &&
        (source.layer === 'domain' || source.layer === 'application'))
    ) {
      return `${relativeToSource(sourcePath)} must not depend on external module ${specifier}`;
    }
    return null;
  }

  if (resolvedPath === undefined) {
    return `${relativeToSource(sourcePath)} has unresolved local import ${specifier}`;
  }

  const target = classifyModule(resolvedPath);
  if (target.kind === 'test') {
    return `${relativeToSource(sourcePath)} must not depend on test module ${relativeToSource(resolvedPath)}`;
  }
  if (target.kind === 'unknown') {
    return `${relativeToSource(sourcePath)} depends on unclassified module ${relativeToSource(resolvedPath)}`;
  }
  if (source.kind === 'composition') {
    return null;
  }
  if (source.kind === 'shared-domain') {
    return target.kind === 'shared-domain'
      ? null
      : 'shared domain may depend only on shared domain';
  }
  if (source.kind === 'shared-presentation') {
    return target.kind === 'shared-presentation' ||
      (target.kind === 'context' && target.layer === 'presentation')
      ? null
      : 'shared GraphQL composition may depend only on shared or context presentation';
  }

  if (target.kind === 'context' && target.context !== source.context) {
    return `${source.context} must not depend on ${target.context} internals`;
  }

  if (source.layer === 'domain') {
    return target.kind === 'shared-domain' ||
      (target.kind === 'context' && target.layer === 'domain')
      ? null
      : `${source.context} domain has an inward dependency violation`;
  }
  if (source.layer === 'application') {
    return target.kind === 'shared-domain' ||
      (target.kind === 'context' &&
        ['application', 'domain'].includes(target.layer))
      ? null
      : `${source.context} application has an inward dependency violation`;
  }
  if (source.layer === 'presentation') {
    return (target.kind === 'shared-presentation' && target.generated) ||
      (target.kind === 'context' &&
        ['presentation', 'application'].includes(target.layer))
      ? null
      : `${source.context} presentation must call its application layer`;
  }

  return target.kind === 'context' &&
    ['infrastructure', 'application', 'domain'].includes(target.layer)
    ? null
    : `${source.context} infrastructure has an inward dependency violation`;
};

const listTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => path.endsWith('.ts'))
    .sort();

const loadCompilerOptions = (): ts.CompilerOptions => {
  const configPath = resolve(sourceRoot, '../tsconfig.json');
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  }
  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
  ).options;
};

const findArchitectureViolations = (): string[] => {
  const compilerOptions = loadCompilerOptions();
  const productionFiles = listTypeScriptFiles(sourceRoot).filter(
    (path) =>
      !isTestModulePath(relativeToSource(path)) &&
      !normalize(path).includes('/presentation/graphql/generated/'),
  );
  const violations: string[] = [];

  for (const path of productionFiles) {
    const sourceViolation = validateProductionModuleLocation(path);
    if (sourceViolation !== null) {
      violations.push(sourceViolation);
      continue;
    }

    const sourceFile = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    for (const reference of collectModuleReferences(sourceFile)) {
      if (!reference.analyzable) {
        violations.push(
          `${relativeToSource(path)} has non-literal dynamic import:${reference.line}`,
        );
        continue;
      }
      const resolved = isExternalSpecifier(reference.specifier)
        ? undefined
        : ts.resolveModuleName(
            reference.specifier,
            path,
            compilerOptions,
            ts.sys,
          ).resolvedModule?.resolvedFileName;
      const violation = validateDependency(path, reference.specifier, resolved);
      if (violation !== null) {
        violations.push(`${violation}:${reference.line}`);
      }
    }
  }

  return violations;
};

const fixturePath = (relativePath: string): string =>
  resolve(sourceRoot, relativePath);

describe('API architecture dependencies', () => {
  it('Group ManagementをContext単位に配置し、依存方向を守る', () => {
    expect(existsSync(fixturePath('group-management/domain/group.ts'))).toBe(
      true,
    );
    expect(
      existsSync(
        fixturePath('group-management/application/group-command-service.ts'),
      ),
    ).toBe(true);
    expect(existsSync(fixturePath('shared/domain/money.ts'))).toBe(true);
    expect(existsSync(fixturePath('domain'))).toBe(false);
    expect(existsSync(fixturePath('application'))).toBe(false);
    expect(findArchitectureViolations()).toEqual([]);
  });

  it.each([
    ["import { value } from './value.js';", './value.js'],
    ["import type { Value } from './value.js';", './value.js'],
    ["export { value } from './value.js';", './value.js'],
    ["export type { Value } from './value.js';", './value.js'],
    ["const value = import('./value.js');", './value.js'],
  ])('%s を依存として解析する', (source, expected) => {
    const sourceFile = ts.createSourceFile(
      'fixture.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      collectModuleReferences(sourceFile).map(({ specifier }) => specifier),
    ).toEqual([expected]);
  });

  it('解析不能な動的importを許可しない', () => {
    const sourceFile = ts.createSourceFile(
      'fixture.ts',
      'const value = import(target);',
      ts.ScriptTarget.Latest,
      true,
    );

    expect(collectModuleReferences(sourceFile)).toEqual([
      {
        specifier: '<non-literal-dynamic-import>',
        line: 1,
        analyzable: false,
      },
    ]);
  });

  it.each([
    'unapproved-context/domain/importless.ts',
    'group-management/unknown/importless.ts',
  ])('importを持たない未分類Production Module %s を拒否する', (path) => {
    expect(validateProductionModuleLocation(fixturePath(path))).not.toBeNull();
  });

  it.each([
    [
      '型importのLayer逆転',
      "import type { Value } from '../application/value.js';",
      'group-management/domain/a.ts',
      'group-management/application/value.ts',
    ],
    [
      '再exportのContext横断',
      "export { value } from '../../settlement/domain/value.js';",
      'group-management/domain/a.ts',
      'settlement/domain/value.ts',
    ],
    [
      '動的importのFramework依存',
      "const value = import('hono');",
      'group-management/domain/a.ts',
      undefined,
    ],
  ])('%s を違反として検出する', (_name, source, sourcePath, targetPath) => {
    const sourceFile = ts.createSourceFile(
      'fixture.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const [reference] = collectModuleReferences(sourceFile);

    expect(reference).toBeDefined();
    expect(
      validateDependency(
        fixturePath(sourcePath),
        reference?.specifier ?? '',
        targetPath === undefined ? undefined : fixturePath(targetPath),
      ),
    ).not.toBeNull();
  });

  it.each([
    ['group-management/domain/a.ts', './b.js', 'group-management/domain/b.ts'],
    [
      'group-management/domain/a.ts',
      '../../shared/domain/b.js',
      'shared/domain/b.ts',
    ],
    [
      'group-management/application/a.ts',
      '../domain/b.js',
      'group-management/domain/b.ts',
    ],
    [
      'group-management/presentation/a.ts',
      '../application/b.js',
      'group-management/application/b.ts',
    ],
    [
      'group-management/infrastructure/a.ts',
      '../application/b.js',
      'group-management/application/b.ts',
    ],
    [
      'app.ts',
      './group-management/domain/a.js',
      'group-management/domain/a.ts',
    ],
  ])('%s から許可された依存先へ参照できる', (source, specifier, target) => {
    expect(
      validateDependency(fixturePath(source), specifier, fixturePath(target)),
    ).toBeNull();
  });

  it.each([
    [
      'group-management/domain/a.ts',
      '../application/b.js',
      'group-management/application/b.ts',
    ],
    [
      'group-management/domain/a.ts',
      '../../settlement/domain/b.js',
      'settlement/domain/b.ts',
    ],
    ['group-management/domain/a.ts', 'hono', undefined],
    ['group-management/application/a.ts', 'graphql-yoga', undefined],
    ['unapproved-context/domain/a.ts', 'hono', undefined],
    [
      'group-management/presentation/a.ts',
      '../domain/b.js',
      'group-management/domain/b.ts',
    ],
    [
      'group-management/application/a.ts',
      './b.spec.js',
      'group-management/application/b.spec.ts',
    ],
    [
      'group-management/infrastructure/a.ts',
      '../../shared/domain/b.js',
      'shared/domain/b.ts',
    ],
    [
      'group-management/domain/a.ts',
      './b.test.js',
      'group-management/domain/b.test.ts',
    ],
    ['group-management/domain/a.ts', './missing.js', undefined],
  ])('%s から禁止された依存先を検出する', (source, specifier, target) => {
    expect(
      validateDependency(
        fixturePath(source),
        specifier,
        target === undefined ? undefined : fixturePath(target),
      ),
    ).not.toBeNull();
  });
});
