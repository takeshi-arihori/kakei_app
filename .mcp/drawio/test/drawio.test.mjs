import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDiagramFile,
  DrawioError,
  parseDiagram,
  readDiagramFile,
  resolveSafeDrawioPath,
  serializeDiagram,
  updateDiagramFile,
  validateDiagramFile
} from '../lib/drawio.mjs';
import { handleMcpMessage } from '../lib/protocol.mjs';

const diagram = {
  name: 'Domain Model',
  nodes: [
    { id: 'household', label: 'Household', x: 40, y: 40 },
    { id: 'transaction', label: 'Transaction', x: 300, y: 40 }
  ],
  edges: [
    { id: 'household-transaction', source: 'household', target: 'transaction', label: '1 : many' }
  ]
};

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drawio-mcp-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('safe path stays within root and requires .drawio', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(resolveSafeDrawioPath(root, 'docs/domain.drawio'), path.join(root, 'docs/domain.drawio'));
  assert.throws(() => resolveSafeDrawioPath(root, '../outside.drawio'), (error) => error instanceof DrawioError && error.code === 'PATH_OUTSIDE_ROOT');
  assert.throws(() => resolveSafeDrawioPath(root, '/tmp/outside.drawio'), (error) => error instanceof DrawioError && error.code === 'INVALID_PATH');
  assert.throws(() => resolveSafeDrawioPath(root, 'docs/domain.xml'), (error) => error instanceof DrawioError && error.code === 'INVALID_PATH');
});

test('serialize and parse round-trip supported diagram data', () => {
  const xml = serializeDiagram(diagram);
  assert.match(xml, /darkMode="0"/);
  const parsed = parseDiagram(xml);
  assert.equal(parsed.name, diagram.name);
  assert.deepEqual(parsed.nodes.map(({ id, label }) => ({ id, label })), [
    { id: 'household', label: 'Household' },
    { id: 'transaction', label: 'Transaction' }
  ]);
  assert.deepEqual(parsed.edges.map(({ id, source, target, label }) => ({ id, source, target, label })), diagram.edges);
});

test('create does not overwrite unless explicitly requested', async () => {
  await withTempRoot(async (root) => {
    await createDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio', diagram });
    await assert.rejects(
      createDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio', diagram }),
      (error) => error instanceof DrawioError && error.code === 'ALREADY_EXISTS'
    );

    const result = await readDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio' });
    assert.equal(result.validation.valid, true);
    assert.equal(result.diagram.nodes.length, 2);
  });
});

test('update removes connected edges when a node is removed', async () => {
  await withTempRoot(async (root) => {
    await createDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio', diagram });
    const result = await updateDiagramFile({
      rootDirectory: root,
      requestedPath: 'docs/domain.drawio',
      operations: [
        { type: 'rename_diagram', name: 'Updated Domain Model' },
        { type: 'remove_element', id: 'transaction' }
      ]
    });
    assert.equal(result.diagram.name, 'Updated Domain Model');
    assert.deepEqual(result.diagram.nodes.map((node) => node.id), ['household']);
    assert.deepEqual(result.diagram.edges, []);

    const persisted = await readFile(path.join(root, 'docs/domain.drawio'), 'utf8');
    assert.doesNotMatch(persisted, /id="transaction"/);
    assert.doesNotMatch(persisted, /id="household-transaction"/);
  });
});

test('validate reports a supported diagram as valid', async () => {
  await withTempRoot(async (root) => {
    await createDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio', diagram });
    const validation = await validateDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio' });
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.counts, { nodes: 2, edges: 1 });
  });
});

test('modern discovery and legacy initialize are both supported', async () => {
  await withTempRoot(async (root) => {
    const modern = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, { rootDirectory: root });
    assert.equal(modern.result.resultType, 'complete');
    assert.deepEqual(modern.result.supportedVersions, ['2026-07-28']);

    const legacy = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    }, { rootDirectory: root });
    assert.equal(legacy.result.protocolVersion, '2025-11-25');
  });
});

test('tools/list exposes only diagram operations', async () => {
  await withTempRoot(async (root) => {
    const result = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { rootDirectory: root });
    assert.deepEqual(result.result.tools.map((tool) => tool.name), [
      'drawio_create',
      'drawio_read',
      'drawio_update',
      'drawio_validate'
    ]);
  });
});

test('tool operational errors are returned as MCP tool errors', async () => {
  await withTempRoot(async (root) => {
    const result = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'drawio_read', arguments: { path: '../outside.drawio' } }
    }, { rootDirectory: root });
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.error, 'PATH_OUTSIDE_ROOT');
  });
});
