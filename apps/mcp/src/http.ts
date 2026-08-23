#!/usr/bin/env node

/**
 * Remote Streamable HTTP MCP entry point for Alazab Microsoft Foundry agents.
 *
 * No new web-framework dependency is needed: the MCP SDK already exposes a
 * Web Fetch handler, and this file bridges Node's built-in HTTP server to it.
 * Bind to loopback and place Nginx/TLS in front in production.
 */

import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';

import {createMcpHandler} from '@modelcontextprotocol/server';

import {AgentIdentityConfigError, loadAgentDirectory} from './agentIdentity.js';
import {ConfigError, loadConfig} from './config.js';
import {buildAgentServer, SERVER_VERSION} from './server.js';

const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

async function main(): Promise<void> {
  const config = loadConfig();
  const directory = loadAgentDirectory();
  const host = (process.env.AZ_MAIL_MCP_HOST ?? '127.0.0.1').trim();
  const port = parsePort(process.env.AZ_MAIL_MCP_PORT ?? '8787');
  const allowedHosts = new Set(
    (process.env.AZ_MAIL_MCP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!isLoopbackHost(host) && allowedHosts.size === 0) {
    throw new ConfigError(
      'AZ_MAIL_MCP_ALLOWED_HOSTS is required when AZ_MAIL_MCP_HOST is not loopback. ' +
        'Set a comma-separated list such as mail.alazab.com.',
    );
  }

  const handlers = new Map(
    directory.identities.map((identity) => [
      identity.id,
      createMcpHandler(() => buildAgentServer(config, identity)),
    ]),
  );

  const server = createServer((req, res) => {
    void route(req, res, {host, port, allowedHosts, directory, handlers}).catch((error: unknown) => {
      console.error(`[az-mail-mcp] request failed: ${(error as Error).message}`);

      if (!res.headersSent) {
        writeJson(res, 500, {error: 'internal_error'});
      } else {
        res.destroy(error as Error);
      }
    });
  });

  server.listen(port, host, () => {
    console.error(
      `[az-mail-mcp] v${SERVER_VERSION} ready on http://${host}:${port}/mcp — ` +
        `${directory.identities.length} fixed agent mailboxes`,
    );
  });

  const shutdown = async () => {
    server.close();
    await Promise.all([...handlers.values()].map((handler) => handler.close()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

interface RouteContext {
  host: string;
  port: number;
  allowedHosts: Set<string>;
  directory: ReturnType<typeof loadAgentDirectory>;
  handlers: Map<string, ReturnType<typeof createMcpHandler>>;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (path === '/healthz') {
    writeJson(res, 200, {
      status: 'ok',
      service: 'az-mail-mcp',
      version: SERVER_VERSION,
      mailboxes: ctx.directory.identities.length,
    });
    return;
  }

  if (path !== '/mcp') {
    writeJson(res, 404, {error: 'not_found'});
    return;
  }

  if (!hostAllowed(req.headers.host, ctx.allowedHosts)) {
    writeJson(res, 421, {error: 'misdirected_request'});
    return;
  }

  const token = readBearerToken(req.headers.authorization);
  const identity = token ? ctx.directory.authenticate(token) : undefined;

  if (!identity) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="az-mail-mcp"');
    writeJson(res, 401, {error: 'invalid_token'});
    return;
  }

  const handler = ctx.handlers.get(identity.id);
  if (!handler) {
    writeJson(res, 500, {error: 'mailbox_handler_missing'});
    return;
  }

  const body = await readBody(req);
  const protocol = firstHeader(req.headers['x-forwarded-proto']) ?? 'http';
  const authority = req.headers.host ?? `${ctx.host}:${ctx.port}`;
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const request = new Request(`${protocol}://${authority}${req.url ?? '/mcp'}`, {
    method: req.method ?? 'POST',
    headers,
    body: body.length > 0 ? body : undefined,
  });

  const response = await handler.fetch(request);
  res.statusCode = response.status;

  response.headers.forEach((value, name) => res.setHeader(name, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
  }

  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (req.method === 'GET' || req.method === 'HEAD') return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > MAX_REQUEST_BYTES) {
      throw new Error(`MCP request exceeded ${MAX_REQUEST_BYTES} bytes.`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function readBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function hostAllowed(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  if (allowedHosts.size === 0) return true;
  if (!hostHeader) return false;

  const host = hostHeader.replace(/^\[/, '').replace(/\](:\d+)?$/, '').split(':')[0]?.toLowerCase();
  return Boolean(host && allowedHosts.has(host));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`AZ_MAIL_MCP_PORT must be a TCP port, received "${value}".`);
  }
  return port;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof AgentIdentityConfigError) {
    console.error(`[az-mail-mcp] configuration error: ${error.message}`);
    process.exit(1);
  }

  console.error(`[az-mail-mcp] fatal: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
