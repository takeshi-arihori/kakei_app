import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export class DrawioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrawioError';
    this.code = code;
  }
}

export function resolveSafeDrawioPath(rootDirectory, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new DrawioError('INVALID_PATH', 'path must be a non-empty string');
  }
  if (path.isAbsolute(requestedPath)) {
    throw new DrawioError('INVALID_PATH', 'absolute paths are not allowed');
  }
  if (path.extname(requestedPath).toLowerCase() !== '.drawio') {
    throw new DrawioError('INVALID_PATH', 'path must end with .drawio');
  }

  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new DrawioError('PATH_OUTSIDE_ROOT', 'path must stay inside the configured repository root');
  }
  return target;
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function unescapeXml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function assertId(id, kind) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id === '0' || id === '1') {
    throw new DrawioError('INVALID_ID', `${kind} id must match ${ID_PATTERN} and must not be 0 or 1`);
  }
}

function numberOrDefault(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DrawioError('INVALID_NUMBER', 'geometry values must be finite numbers');
  }
  return value;
}

export function normalizeDiagramSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DrawioError('INVALID_DIAGRAM', 'diagram must be an object');
  }

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Domain Model';
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  const seen = new Set(['0', '1']);

  const nodes = rawNodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new DrawioError('INVALID_NODE', `nodes[${index}] must be an object`);
    }
    assertId(node.id, 'node');
    if (seen.has(node.id)) throw new DrawioError('DUPLICATE_ID', `duplicate id: ${node.id}`);
    seen.add(node.id);
    if (typeof node.label !== 'string' || node.label.trim() === '') {
      throw new DrawioError('INVALID_NODE', `nodes[${index}].label must be a non-empty string`);
    }
    return {
      id: node.id,
      label: node.label,
      x: numberOrDefault(node.x, 40 + (index % 4) * 240),
      y: numberOrDefault(node.y, 40 + Math.floor(index / 4) * 160),
      width: numberOrDefault(node.width, 180),
      height: numberOrDefault(node.height, 100),
      style: typeof node.style === 'string' && node.style.trim()
        ? node.style
        : 'rounded=1;whiteSpace=wrap;html=1;'
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges.map((edge, index) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      throw new DrawioError('INVALID_EDGE', `edges[${index}] must be an object`);
    }
    assertId(edge.id, 'edge');
    if (seen.has(edge.id)) throw new DrawioError('DUPLICATE_ID', `duplicate id: ${edge.id}`);
    seen.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new DrawioError('INVALID_EDGE', `edges[${index}] source/target must reference existing nodes`);
    }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: typeof edge.label === 'string' ? edge.label : '',
      style: typeof edge.style === 'string' && edge.style.trim()
        ? edge.style
        : 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;'
    };
  });

  return { name, nodes, edges };
}

export function serializeDiagram(diagramInput) {
  const diagram = normalizeDiagramSpec(diagramInput);
  const nodeXml = diagram.nodes.map((node) =>
    `        <mxCell id="${escapeXml(node.id)}" value="${escapeXml(node.label)}" style="${escapeXml(node.style)}" vertex="1" parent="1">\n` +
    `          <mxGeometry x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" as="geometry" />\n` +
    '        </mxCell>'
  ).join('\n');
  const edgeXml = diagram.edges.map((edge) =>
    `        <mxCell id="${escapeXml(edge.id)}" value="${escapeXml(edge.label)}" style="${escapeXml(edge.style)}" edge="1" parent="1" source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">\n` +
    '          <mxGeometry relative="1" as="geometry" />\n' +
    '        </mxCell>'
  ).join('\n');

  const content = [nodeXml, edgeXml].filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="kakei-drawio-mcp" version="1.0">\n  <diagram name="${escapeXml(diagram.name)}" id="page-1">\n    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0" darkMode="0">\n      <root>\n        <mxCell id="0" />\n        <mxCell id="1" parent="0" />\n${content}${content ? '\n' : ''}      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n`;
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  for (const match of text.matchAll(pattern)) attributes[match[1]] = unescapeXml(match[2]);
  return attributes;
}

export function parseDiagram(xml) {
  if (typeof xml !== 'string' || !xml.includes('<mxfile') || !xml.includes('<mxGraphModel')) {
    throw new DrawioError('UNSUPPORTED_XML', 'file is not an uncompressed draw.io mxGraphModel document');
  }

  const diagramMatch = xml.match(/<diagram\b([^>]*)>/);
  const diagramAttributes = diagramMatch ? parseAttributes(diagramMatch[1]) : {};
  const cells = [];
  const cellPattern = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  for (const match of xml.matchAll(cellPattern)) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id || attrs.id === '0' || attrs.id === '1') continue;
    const inner = match[2] ?? '';
    const geometryMatch = inner.match(/<mxGeometry\b([^>]*)\/>/);
    const geometry = geometryMatch ? parseAttributes(geometryMatch[1]) : {};
    cells.push({ attrs, geometry });
  }

  const nodes = cells.filter(({ attrs }) => attrs.vertex === '1').map(({ attrs, geometry }) => ({
    id: attrs.id,
    label: attrs.value ?? '',
    x: Number(geometry.x ?? 0),
    y: Number(geometry.y ?? 0),
    width: Number(geometry.width ?? 180),
    height: Number(geometry.height ?? 100),
    style: attrs.style ?? ''
  }));
  const edges = cells.filter(({ attrs }) => attrs.edge === '1').map(({ attrs }) => ({
    id: attrs.id,
    source: attrs.source,
    target: attrs.target,
    label: attrs.value ?? '',
    style: attrs.style ?? ''
  }));

  return normalizeDiagramSpec({ name: diagramAttributes.name ?? 'Domain Model', nodes, edges });
}

export function validateDiagramXml(xml) {
  const errors = [];
  const warnings = [];
  if (!xml.includes('<mxfile')) errors.push('missing mxfile root');
  if (!xml.includes('<diagram')) errors.push('missing diagram element');
  if (!xml.includes('<mxGraphModel')) errors.push('missing mxGraphModel');
  if (!xml.includes('<root>')) errors.push('missing graph root');
  if (!/darkMode="0"/.test(xml)) warnings.push('darkMode="0" is not set');

  let diagram;
  try {
    diagram = parseDiagram(xml);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: diagram ? { nodes: diagram.nodes.length, edges: diagram.edges.length } : { nodes: 0, edges: 0 }
  };
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readLimited(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new DrawioError('NOT_FILE', 'path does not point to a file');
  if (metadata.size > MAX_FILE_BYTES) throw new DrawioError('FILE_TOO_LARGE', `draw.io file exceeds ${MAX_FILE_BYTES} bytes`);
  return readFile(filePath, 'utf8');
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
  await rename(tempPath, filePath);
}

export async function createDiagramFile({ rootDirectory, requestedPath, diagram, overwrite = false }) {
  const filePath = resolveSafeDrawioPath(rootDirectory, requestedPath);
  if (!overwrite && await exists(filePath)) {
    throw new DrawioError('ALREADY_EXISTS', 'target file already exists; set overwrite=true explicitly to replace it');
  }
  const xml = serializeDiagram(diagram);
  await atomicWrite(filePath, xml);
  return { path: path.relative(path.resolve(rootDirectory), filePath), diagram: normalizeDiagramSpec(diagram) };
}

export async function readDiagramFile({ rootDirectory, requestedPath }) {
  const filePath = resolveSafeDrawioPath(rootDirectory, requestedPath);
  const xml = await readLimited(filePath);
  const validation = validateDiagramXml(xml);
  if (!validation.valid) throw new DrawioError('INVALID_DRAWIO', validation.errors.join('; '));
  return { path: path.relative(path.resolve(rootDirectory), filePath), diagram: parseDiagram(xml), validation };
}

export function applyOperations(diagramInput, operations) {
  const diagram = normalizeDiagramSpec(diagramInput);
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new DrawioError('INVALID_OPERATIONS', 'operations must be a non-empty array');
  }

  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const edges = new Map(diagram.edges.map((edge) => [edge.id, edge]));
  let name = diagram.name;

  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new DrawioError('INVALID_OPERATION', `operations[${index}] must be an object`);
    }
    switch (operation.type) {
      case 'rename_diagram':
        if (typeof operation.name !== 'string' || operation.name.trim() === '') {
          throw new DrawioError('INVALID_OPERATION', 'rename_diagram requires a non-empty name');
        }
        name = operation.name.trim();
        break;
      case 'upsert_node': {
        const node = normalizeDiagramSpec({ name, nodes: [operation.node], edges: [] }).nodes[0];
        if (edges.has(node.id)) throw new DrawioError('DUPLICATE_ID', `id is already used by an edge: ${node.id}`);
        nodes.set(node.id, node);
        break;
      }
      case 'upsert_edge': {
        const edge = operation.edge;
        if (!edge || typeof edge !== 'object') throw new DrawioError('INVALID_OPERATION', 'upsert_edge requires edge');
        assertId(edge.id, 'edge');
        if (nodes.has(edge.id)) throw new DrawioError('DUPLICATE_ID', `id is already used by a node: ${edge.id}`);
        if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
          throw new DrawioError('INVALID_EDGE', 'edge source/target must reference existing nodes');
        }
        edges.set(edge.id, {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: typeof edge.label === 'string' ? edge.label : '',
          style: typeof edge.style === 'string' && edge.style.trim()
            ? edge.style
            : 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;'
        });
        break;
      }
      case 'remove_element': {
        assertId(operation.id, 'element');
        if (nodes.delete(operation.id)) {
          for (const [edgeId, edge] of edges) {
            if (edge.source === operation.id || edge.target === operation.id) edges.delete(edgeId);
          }
        } else {
          edges.delete(operation.id);
        }
        break;
      }
      default:
        throw new DrawioError('INVALID_OPERATION', `unsupported operation type: ${operation.type}`);
    }
  }

  return normalizeDiagramSpec({ name, nodes: [...nodes.values()], edges: [...edges.values()] });
}

export async function updateDiagramFile({ rootDirectory, requestedPath, operations }) {
  const current = await readDiagramFile({ rootDirectory, requestedPath });
  const updated = applyOperations(current.diagram, operations);
  const filePath = resolveSafeDrawioPath(rootDirectory, requestedPath);
  await atomicWrite(filePath, serializeDiagram(updated));
  return { path: current.path, diagram: updated, validation: validateDiagramXml(serializeDiagram(updated)) };
}

export async function validateDiagramFile({ rootDirectory, requestedPath }) {
  const filePath = resolveSafeDrawioPath(rootDirectory, requestedPath);
  const xml = await readLimited(filePath);
  return { path: path.relative(path.resolve(rootDirectory), filePath), ...validateDiagramXml(xml) };
}
