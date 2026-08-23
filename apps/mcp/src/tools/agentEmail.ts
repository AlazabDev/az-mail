import * as z from 'zod';

import type {AgentMailboxIdentity} from '../agentIdentity.js';
import type {PlunkClient} from '../client.js';
import {jsonResult, register, runTool, type ToolContext} from './shared.js';

const recipient = z.union([
  z.string().email().describe('Recipient email address'),
  z.object({
    name: z.string().min(1).max(200).optional().describe('Recipient display name'),
    email: z.string().email().describe('Recipient email address'),
  }),
]);

const attachment = z.object({
  filename: z.string().min(1).max(255).describe('Attachment filename'),
  content: z.string().min(1).describe('Base64 encoded attachment content'),
  contentType: z.string().min(1).max(255).describe('MIME type, for example application/pdf'),
});

export function registerAgentEmailTools(ctx: ToolContext, client: PlunkClient, identity: AgentMailboxIdentity): void {
  register(
    ctx,
    'az_mail_identity',
    {
      title: 'Get my agent mailbox identity',
      description:
        'Return the authenticated agent ID, fixed sender address and reply-to address. The sender identity is enforced by the server and cannot be changed by the agent.',
      inputSchema: z.object({}),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    },
    async () =>
      jsonResult('Authenticated agent mailbox:', {
        agentId: identity.id,
        displayName: identity.displayName,
        email: identity.email,
        replyTo: identity.replyTo,
      }),
  );

  register(
    ctx,
    'az_mail_verify_recipient',
    {
      title: 'Verify recipient email',
      description: 'Check recipient syntax, disposable-domain status and MX records before sending mail.',
      inputSchema: z.object({
        email: z.string().email().describe('Recipient email address to verify'),
      }),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({email}) =>
      runTool(async () => {
        const result = await client.request({method: 'POST', path: '/v1/verify', body: {email}});
        return jsonResult('Verification result:', result);
      }),
  );

  register(
    ctx,
    'az_mail_send_email',
    {
      title: 'Send email from my agent mailbox',
      description: [
        'Send a transactional email as the authenticated Alazab agent.',
        'The From and Reply-To identities are fixed by the MCP bearer token and cannot be supplied or overridden in this tool.',
        'Use this for direct operational correspondence, notifications, reports and requested attachments.',
        'Maximum 10 recipients per call. Do not use this tool for marketing campaigns or audience-wide broadcasts.',
      ].join('\n'),
      inputSchema: z.object({
        to: z
          .union([recipient, z.array(recipient).min(1).max(10)])
          .describe('One recipient or up to 10 named recipients.'),
        subject: z
          .string()
          .min(1)
          .max(998)
          .refine((value) => !/[\r\n]/.test(value), 'Subject cannot contain newlines')
          .optional()
          .describe('Subject line. Required unless template is provided.'),
        body: z.string().min(1).optional().describe('HTML email body. Required unless template is provided.'),
        template: z.string().min(1).optional().describe('Optional az-mail template ID.'),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Template variables and contact data passed to az-mail.'),
        attachments: z
          .array(attachment)
          .max(10)
          .optional()
          .describe('Optional attachments. Content must be Base64 encoded.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({to, subject, body, template, data, attachments}) =>
      runTool(async () => {
        if (!template && (!subject || !body)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Provide either a template ID, or both subject and body.',
              },
            ],
            isError: true,
          };
        }

        const result = await client.request({
          method: 'POST',
          path: '/v1/send',
          body: {
            to,
            subject,
            body,
            template,
            from: {
              name: identity.displayName,
              email: identity.email,
            },
            reply: identity.replyTo,
            data,
            attachments,
            headers: {
              'X-Az-Agent-Id': identity.id,
              'X-Az-Agent-Mailbox': identity.email,
              'X-Az-Origin': 'microsoft-foundry',
            },
          },
        });

        return jsonResult(`Sent as ${identity.displayName} <${identity.email}>.`, {
          agent: {
            id: identity.id,
            email: identity.email,
          },
          result,
        });
      }),
  );
}
