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

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const INSTRUCTIONS = 'Use draw.io tools only for diagram file operations. Domain and business decisions belong to the calling skill.';

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

function modernResult(result, { cacheable = false } = {}) {
  return {
    ...result,
    resultType: 'complete',
    ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
    _meta: { [SERVER_INFO_META]: SERVER_INFO }
  };
}

function toolResult(payload, isError = false, modern = false) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError
  };
  return modern ? modernResult(result) : result;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DrawioError('INVALID_ARGUMENTS', `${label} must be an object`);
  }
  return value;
}

function modernRequestMeta(message) {
  const meta = message.params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
}

function validateModernRequest(message, context) {
  const meta = modernRequestMeta(message);
  if (!meta) {
    return protocolError(message.id, -32602, 'Invalid params', { reason: '2026-07-28 requests require params._meta' });
  }

  const requestedVersion = meta[PROTOCOL_VERSION_META];
  if (typeof requestedVersion !== 'string') {
    return protocolError(message.id, -32602, 'Invalid params', { reason: `${PROTOCOL_VERSION_META} is required` });
  }
  if (requestedVersion !== MODERN_PROTOCOL_VERSION) {
    return protocolError(message.id, -32022, 'Unsupported protocol version', {
      supported: [MODERN_PROTOCOL_VERSION],
      requested: requestedVersion
    });
  }

  const clientCapabilities = meta[CLIENT_CAPABILITIES_META];
  if (!clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) {
    return protocolError(message.id, -32602, 'Invalid params', { reason: `${CLIENT_CAPABILITIES_META} is required` });
  }

  if (context.protocolEra === 'legacy') {
    return protocolError(message.id, -32600, 'Invalid Request', { reason: 'connection is already using a legacy initialize-era protocol' });
  }
  context.protocolEra = 'modern';
  return null;
}

function isModernRequest(message, context) {
  return context.protocolEra === 'modern' || modernRequestMeta(message)?.[PROTOCOL_VERSION_META] !== undefined || message.method === 'server/discover';
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
    if (message.method === 'notifications/initialized' && context.protocolEra === 'legacy') {
      context.legacyInitialized = true;
    }
    return null;
  }

  const modern = isModernRequest(message, context);
  if (modern) {
    const validationError = validateModernRequest(message, context);
    if (validationError) return validationError;
  } else if (message.method !== 'initialize' && context.protocolEra !== 'legacy') {
    return protocolError(message.id, -32600, 'Invalid Request', { reason: 'legacy clients must initialize before sending requests' });
  }

  try {
    switch (message.method) {
      case 'server/discover':
        return response(message.id, modernResult({
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS
        }, { cacheable: true }));
      case 'initialize': {
        if (context.protocolEra === 'modern') {
          return protocolError(message.id, -32601, 'Method not found', { method: message.method });
        }
        const requestedVersion = message.params?.protocolVersion;
        const protocolVersion = LEGACY_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : LEGACY_PROTOCOL_VERSIONS[0];
        context.protocolEra = 'legacy';
        context.legacyInitialized = false;
        return response(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS
        });
      }
      case 'ping':
        return modern
          ? protocolError(message.id, -32601, 'Method not found', { method: message.method })
          : response(message.id, {});
      case 'tools/list':
        return response(message.id, modern
          ? modernResult({ tools: TOOL_DEFINITIONS }, { cacheable: true })
          : { tools: TOOL_DEFINITIONS });
      case 'tools/call': {
        const toolName = message.params?.name;
        if (typeof toolName !== 'string' || toolName === '') {
          return protocolError(message.id, -32602, 'Invalid params', { reason: 'params.name is required' });
        }
        try {
          const payload = await executeTool(toolName, message.params?.arguments ?? {}, context);
          return response(message.id, toolResult(payload, false, modern));
        } catch (error) {
          if (error?.protocolCode) return protocolError(message.id, error.protocolCode, error.message);
          const payload = {
            error: error instanceof DrawioError ? error.code : 'TOOL_ERROR',
            message: error instanceof Error ? error.message : String(error)
          };
          return response(message.id, toolResult(payload, true, modern));
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
