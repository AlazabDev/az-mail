# Alazab Agent Mail MCP

This mode gives each Microsoft Foundry agent a fixed employee-style outbound email identity while sharing one az-mail/Plunk delivery project.

## Architecture

```text
Microsoft Foundry agent
        |
        | Authorization: Bearer <agent-specific-token>
        v
https://mail.alazab.com/mcp
        |
        | token -> fixed mailbox identity
        v
az-mail MCP (apps/mcp/dist/http.js)
        |
        | POST /v1/send
        | From is injected server-side
        v
az-mail API -> verified sender domain -> recipient
```

The agent cannot provide a `from` or `reply-to` field. Those values are selected by the bearer token on the MCP server. One agent therefore cannot impersonate another agent even when both use the same MCP URL and the same underlying az-mail project.

## Default agent mailboxes

| Foundry agent | Default mailbox |
| --- | --- |
| `az-agent-backend` | `backend@agents.alazab.com` |
| `az-agent-azabot` | `azabot@agents.alazab.com` |
| `az-agent-auth` | `auth@agents.alazab.com` |
| `az-agent-prod` | `prod@agents.alazab.com` |
| `az-agent-maint` | `maint@agents.alazab.com` |
| `az-agent-core` | `core@agents.alazab.com` |
| `az-agent-bim` | `bim@agents.alazab.com` |
| `az-agent-finance` | `finance@agents.alazab.com` |
| `az-agent-payments` | `payments@agents.alazab.com` |
| `az-agent-copilot` | `copilot@agents.alazab.com` |
| `az-agent-project` | `project@agents.alazab.com` |
| `az-agent-vision` | `vision@agents.alazab.com` |

Change `AZ_MAIL_AGENT_DOMAIN` to use another verified domain. Per-agent overrides are supported through `AZ_MAIL_AGENT_IDENTITIES_JSON`.

## Exposed tools

The Foundry-facing server deliberately exposes only three tools:

- `az_mail_identity` — read the authenticated mailbox identity.
- `az_mail_verify_recipient` — validate an address before sending.
- `az_mail_send_email` — send a direct transactional/operational message as the authenticated agent.

Campaign, contact-administration, domain-administration and project-management tools are not registered in agent mode.

## 1. Verify the sender domain

Add `agents.alazab.com` to the az-mail project and complete its SPF/DKIM verification before enabling agents. The API already rejects `from` addresses whose domain is not verified for the project.

For real two-way employee mail, inbound delivery for `*@agents.alazab.com` must also be routed to a mailbox/inbound-mail service. This repository currently provides the outbound agent identity and Reply-To behavior; it does not implement an IMAP inbox.

## 2. Configure the server

Copy the example and replace every secret:

```bash
cp apps/mcp/.env.agent.example /etc/az-mail/mcp.env
chmod 600 /etc/az-mail/mcp.env
```

Generate one token for each agent. Example helper:

```bash
python3 - <<'PY'
import json, secrets
agents = [
  'az-agent-backend','az-agent-azabot','az-agent-auth','az-agent-prod',
  'az-agent-maint','az-agent-core','az-agent-bim','az-agent-finance',
  'az-agent-payments','az-agent-copilot','az-agent-project','az-agent-vision',
]
print(json.dumps({agent: secrets.token_urlsafe(48) for agent in agents}, separators=(',', ':')))
PY
```

Store the resulting JSON as `AZ_MAIL_AGENT_TOKENS_JSON`. Never commit the real token map.

## 3. Build and run

```bash
yarn install --immutable
yarn workspace @plunk/mcp build

set -a
. /etc/az-mail/mcp.env
set +a

yarn workspace @plunk/mcp serve:agent-http
```

Defaults:

- MCP URL on the host: `http://127.0.0.1:8787/mcp`
- Health check: `http://127.0.0.1:8787/healthz`
- Maximum MCP request size: 30 MiB
- Maximum recipients per `az_mail_send_email`: 10

## 4. Nginx

Terminate TLS at Nginx and proxy only the MCP path:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8787/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 300s;
}

location = /healthz {
    proxy_pass http://127.0.0.1:8787/healthz;
    proxy_set_header Host $host;
}
```

Recommended public endpoint:

```text
https://mail.alazab.com/mcp
```

Keep port 8787 bound to loopback; do not expose it through the firewall.

## 5. Microsoft Foundry connection model

Create one Foundry project connection per agent, all pointing at the same MCP URL but each carrying a different bearer token.

Conceptually:

```text
az-agent-finance
  -> connection: az-mail-finance
  -> Authorization: Bearer <finance-token>
  -> https://mail.alazab.com/mcp
  -> finance@agents.alazab.com

az-agent-payments
  -> connection: az-mail-payments
  -> Authorization: Bearer <payments-token>
  -> https://mail.alazab.com/mcp
  -> payments@agents.alazab.com
```

Attach the MCP tool with only these allowed tools:

```json
{
  "type": "mcp",
  "server_label": "az_mail",
  "server_url": "https://mail.alazab.com/mcp",
  "project_connection_id": "az-mail-finance",
  "allowed_tools": [
    "az_mail_identity",
    "az_mail_verify_recipient",
    "az_mail_send_email"
  ],
  "require_approval": "always"
}
```

Use the matching connection ID for each Foundry agent. Approval policy can later be relaxed for trusted operational workflows; mailbox identity remains server-enforced either way.

## Audit headers

Every message sent through agent mode adds:

```text
X-Az-Agent-Id: az-agent-finance
X-Az-Agent-Mailbox: finance@agents.alazab.com
X-Az-Origin: microsoft-foundry
```

These make downstream delivery logs and investigations attributable to the exact agent that initiated the message.
