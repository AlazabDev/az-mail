import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {AgentMailboxIdentity} from '../agentIdentity.js';
import type {PlunkMcpConfig} from '../config.js';
import {buildAgentServer} from '../server.js';

const config: PlunkMcpConfig = {
  apiKey: 'sk_test',
  apiUrl: 'https://api.example.com',
  readOnly: false,
};

const finance: AgentMailboxIdentity = {
  id: 'az-agent-finance',
  displayName: 'Alazab Finance Agent',
  email: 'finance@agents.alazab.com',
  replyTo: 'finance@agents.alazab.com',
};

async function connect() {
  const handler = createMcpHandler(() => buildAgentServer(config, finance));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({name: 'agent-mail-test', version: '1.0.0'});
  await client.connect(transport);

  return {
    client,
    async close() {
      await client.close();
      await handler.close();
    },
  };
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

describe('Alazab agent mail MCP', () => {
  it('exposes only the narrow employee-mail surface', async () => {
    const {client, close} = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toEqual(['az_mail_identity', 'az_mail_verify_recipient', 'az_mail_send_email']);
    expect(names).not.toContain('plunk_send_campaign');
    expect(names).not.toContain('plunk_delete_contact');

    await close();
  });

  it('reports the mailbox bound to the authenticated server instance', async () => {
    const {client, close} = await connect();
    const result = await client.callTool({name: 'az_mail_identity', arguments: {}});

    expect(JSON.stringify(result.content)).toContain('finance@agents.alazab.com');
    expect(JSON.stringify(result.content)).toContain('az-agent-finance');

    await close();
  });

  it('forces the finance sender even if a caller tries to inject another from address', async () => {
    let sentBody: Record<string, unknown> | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url instanceof Request ? url.url : url);
      if (!target.startsWith('https://api.example.com')) throw new Error(`unexpected fetch to ${target}`);

      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({success: true, data: {emails: [{email: 'mail-1'}]}}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    });

    const {client, close} = await connect();
    const result = await client.callTool({
      name: 'az_mail_send_email',
      arguments: {
        to: 'vendor@example.com',
        subject: 'Invoice review',
        body: '<p>Please review.</p>',
        from: {name: 'Payments', email: 'payments@agents.alazab.com'},
      },
    });

    expect(result.isError).toBeFalsy();
    expect(sentBody?.from).toEqual({
      name: 'Alazab Finance Agent',
      email: 'finance@agents.alazab.com',
    });
    expect(sentBody?.reply).toBe('finance@agents.alazab.com');
    expect(sentBody?.headers).toMatchObject({
      'X-Az-Agent-Id': 'az-agent-finance',
      'X-Az-Agent-Mailbox': 'finance@agents.alazab.com',
      'X-Az-Origin': 'microsoft-foundry',
    });

    await close();
  });
});
