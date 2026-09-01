import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function modernParams(extra = {}) {
  return {
    ...extra,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' }
    }
  };
}

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

test('update preserves existing draw.io structure while patching typed fields', async () => {
  await withTempRoot(async (root) => {
    const xml = `<mxfile host="custom-host" agent="draw.io">
  <diagram id="existing-page" name="Existing Diagram">
    <mxGraphModel dx="1862" dy="925" pageWidth="1800" pageHeight="1800" customGraphAttribute="keep-me">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="section" value="Section" style="swimlane;" parent="1" vertex="1" customCellAttribute="keep-me">
          <mxGeometry x="30" y="95" width="1740" height="345" as="geometry">
            <mxRectangle x="30" y="95" width="190" height="40" as="alternateBounds"/>
          </mxGeometry>
        </mxCell>
        <mxCell id="child" value="Before" style="rounded=0;" parent="section" vertex="1">
          <mxGeometry x="40" y="50" width="180" height="100" as="geometry"/>
        </mxCell>
        <mxCell id="relation" value="Before edge" style="edgeStyle=orthogonalEdgeStyle;" parent="section" source="section" target="child" edge="1">
          <mxGeometry relative="1" as="geometry">
            <Array as="points"><mxPoint x="100" y="200"/></Array>
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
    const target = path.join(root, 'docs/domain.drawio');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, xml, 'utf8');

    const current = await readDiagramFile({ rootDirectory: root, requestedPath: 'docs/domain.drawio' });
    const section = current.diagram.nodes.find((node) => node.id === 'section');
    assert.deepEqual(
      { x: section.x, y: section.y, width: section.width, height: section.height },
      { x: 30, y: 95, width: 1740, height: 345 }
    );

    await updateDiagramFile({
      rootDirectory: root,
      requestedPath: 'docs/domain.drawio',
      operations: [
        { type: 'rename_diagram', name: 'Renamed Diagram' },
        { type: 'upsert_node', node: { ...section, label: 'Updated Section' } },
        {
          type: 'upsert_node',
          node: { id: 'child', label: 'After', x: 40, y: 50, width: 180, height: 100, style: 'rounded=0;' }
        },
        {
          type: 'upsert_edge',
          edge: { id: 'relation', source: 'section', target: 'child', label: 'After edge', style: 'edgeStyle=orthogonalEdgeStyle;' }
        }
      ]
    });

    const persisted = await readFile(target, 'utf8');
    assert.equal(persisted, xml
      .replace('name="Existing Diagram"', 'name="Renamed Diagram"')
      .replace('value="Section"', 'value="Updated Section"')
      .replace('value="Before"', 'value="After"')
      .replace('value="Before edge"', 'value="After edge"'));
    assert.match(persisted, /parent="section"/);
    assert.match(persisted, /pageWidth="1800" pageHeight="1800" customGraphAttribute="keep-me"/);
    assert.match(persisted, /customCellAttribute="keep-me"/);
    assert.match(persisted, /as="alternateBounds"/);
    assert.match(persisted, /<Array as="points"><mxPoint x="100" y="200"\/><\/Array>/);
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

test('modern discovery advertises required cache fields and legacy initialize remains available', async () => {
  await withTempRoot(async (root) => {
    const modernContext = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const modern = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: modernParams()
    }, modernContext);
    assert.equal(modern.result.resultType, 'complete');
    assert.equal(modern.result.ttlMs, 0);
    assert.equal(modern.result.cacheScope, 'private');
    assert.deepEqual(modern.result.supportedVersions, ['2026-07-28']);
    assert.deepEqual(modern.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'kakei-drawio-mcp', version: '0.1.0' });

    const legacyContext = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const legacy = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    }, legacyContext);
    assert.equal(legacy.result.protocolVersion, '2025-11-25');
    assert.equal(legacyContext.protocolEra, 'legacy');
  });
});

test('modern requests reject a missing per-request envelope', async () => {
  await withTempRoot(async (root) => {
    const context = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const result = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, context);
    assert.equal(result.error.code, -32602);
  });
});

test('modern requests reject an unsupported protocol version', async () => {
  await withTempRoot(async (root) => {
    const context = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const result = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2099-01-01',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    }, context);
    assert.equal(result.error.code, -32022);
    assert.deepEqual(result.error.data.supported, ['2026-07-28']);
  });
});

test('tools/list exposes only diagram operations with modern result metadata', async () => {
  await withTempRoot(async (root) => {
    const context = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const result = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: modernParams()
    }, context);
    assert.equal(result.result.resultType, 'complete');
    assert.equal(result.result.ttlMs, 0);
    assert.equal(result.result.cacheScope, 'private');
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
    const context = { rootDirectory: root, protocolEra: null, legacyInitialized: false };
    const result = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: modernParams({ name: 'drawio_read', arguments: { path: '../outside.drawio' } })
    }, context);
    assert.equal(result.result.resultType, 'complete');
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.error, 'PATH_OUTSIDE_ROOT');
  });
});
