import {
  createDiagramFile,
  DrawioError,
  readDiagramFile,
  updateDiagramFile,
  validateDiagramFile
} from './drawio.mjs';

export const SERVER_INFO = { name: 'kakei-drawio-mcp', version: '0.1.0' };
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PATH_PROPERTY = {
  type: 'string',
  description: 'Repository-root-relative path ending in .drawio. Absolute paths and paths escaping the root are rejected.'
};

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    style: { type: 'string' }
  }
};

const EDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'source', 'target'],
  properties: {
    id: { type: 'string' },
    source: { type: 'string' },
    target: { type: 'string' },
    label: { type: 'string' },
    style: { type: 'string' }
  }
};

const DIAGRAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'nodes', 'edges'],
  properties: {
    name: { type: 'string' },
    nodes: { type: 'array', items: NODE_SCHEMA },
    edges: { type: 'array', items: EDGE_SCHEMA }
  }
};

export const TOOL_DEFINITIONS = [
  {
    name: 'drawio_create',
    title: 'Create draw.io diagram',
    description: 'Create an uncompressed draw.io file from a typed diagram specification. Does not infer domain concepts or business rules.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'diagram'],
      properties: {
        path: PATH_PROPERTY,
        diagram: DIAGRAM_SCHEMA,
        overwrite: { type: 'boolean', default: false, description: 'Must be explicitly true to replace an existing file.' }
      }
    }
  },
  {
    name: 'drawio_read',
    title: 'Read draw.io diagram',
    description: 'Read a supported uncompressed draw.io file and return a typed diagram specification instead of raw XML.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: PATH_PROPERTY }
    }
  },
  {
    name: 'drawio_update',
    title: 'Update draw.io diagram',
    description: 'Apply typed operations to a supported uncompressed draw.io file. Removing a node also removes connected edges.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'operations'],
      properties: {
        path: PATH_PROPERTY,
        operations: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              {
                type: 'object', additionalProperties: false, required: ['type', 'name'],
                properties: { type: { const: 'rename_diagram' }, name: { type: 'string' } }
              },
              {
                type: 'object', additionalProperties: false, required: ['type', 'node'],
                properties: { type: { const: 'upsert_node' }, node: NODE_SCHEMA }
              },
              {
                type: 'object', additionalProperties: false, required: ['type', 'edge'],
                properties: { type: { const: 'upsert_edge' }, edge: EDGE_SCHEMA }
              },
              {
                type: 'object', additionalProperties: false, required: ['type', 'id'],
                properties: { type: { const: 'remove_element' }, id: { type: 'string' } }
              }
            ]
          }
        }
      }
    }
  },
  {
    name: 'drawio_validate',
    title: 'Validate draw.io diagram',
    description: 'Validate that a draw.io file is a supported uncompressed mxGraphModel with internally valid nodes and edges.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: PATH_PROPERTY }
    }
  }
];

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function protocolError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toolResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError
  };
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DrawioError('INVALID_ARGUMENTS', `${label} must be an object`);
  }
  return value;
}

export async function executeTool(name, args, context) {
  const input = requireObject(args ?? {}, 'arguments');
  switch (name) {
    case 'drawio_create':
      return createDiagramFile({
        rootDirectory: context.rootDirectory,
        requestedPath: input.path,
        diagram: input.diagram,
        overwrite: input.overwrite === true
      });
    case 'drawio_read':
      return readDiagramFile({ rootDirectory: context.rootDirectory, requestedPath: input.path });
    case 'drawio_update':
      return updateDiagramFile({
        rootDirectory: context.rootDirectory,
        requestedPath: input.path,
        operations: input.operations
      });
    case 'drawio_validate':
      return validateDiagramFile({ rootDirectory: context.rootDirectory, requestedPath: input.path });
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { protocolCode: -32601 });
  }
}

export async function handleMcpMessage(message, context) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return protocolError(message?.id ?? null, -32600, 'Invalid Request');
  }

  if (!Object.hasOwn(message, 'id')) {
    if (message.method === 'notifications/initialized') return null;
    return null;
  }

  try {
    switch (message.method) {
      case 'server/discover':
        return response(message.id, {
          resultType: 'complete',
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'Use draw.io tools only for diagram file operations. Domain and business decisions belong to the calling skill.'
        });
      case 'initialize': {
        const requestedVersion = message.params?.protocolVersion;
        const protocolVersion = LEGACY_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : LEGACY_PROTOCOL_VERSIONS[0];
        return response(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Use draw.io tools only for diagram file operations. Domain and business decisions belong to the calling skill.'
        });
      }
      case 'ping':
        return response(message.id, {});
      case 'tools/list':
        return response(message.id, { tools: TOOL_DEFINITIONS });
      case 'tools/call': {
        const toolName = message.params?.name;
        if (typeof toolName !== 'string' || toolName === '') {
          return protocolError(message.id, -32602, 'Invalid params', { reason: 'params.name is required' });
        }
        try {
          const payload = await executeTool(toolName, message.params?.arguments ?? {}, context);
          return response(message.id, toolResult(payload));
        } catch (error) {
          if (error?.protocolCode) return protocolError(message.id, error.protocolCode, error.message);
          const payload = {
            error: error instanceof DrawioError ? error.code : 'TOOL_ERROR',
            message: error instanceof Error ? error.message : String(error)
          };
          return response(message.id, toolResult(payload, true));
        }
      }
      default:
        return protocolError(message.id, -32601, 'Method not found', { method: message.method });
    }
  } catch (error) {
    return protocolError(message.id, -32603, 'Internal error', {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
