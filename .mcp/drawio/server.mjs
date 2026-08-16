#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMcpMessage } from './lib/protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '../..');
const rootDirectory = path.resolve(process.env.DRAWIO_MCP_ROOT ?? defaultRoot);

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeParseError(raw, error) {
  const payload = {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32700,
      message: 'Parse error',
      data: { message: error instanceof Error ? error.message : String(error) }
    }
  };
  process.stderr.write(`drawio-mcp rejected invalid JSON (${Buffer.byteLength(raw, 'utf8')} bytes)\n`);
  writeMessage(payload);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', async (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeParseError(line, error);
    return;
  }

  const reply = await handleMcpMessage(message, { rootDirectory });
  if (reply) writeMessage(reply);
});

input.on('close', () => {
  process.exitCode = 0;
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`drawio-mcp uncaught exception: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`drawio-mcp unhandled rejection: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
