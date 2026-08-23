export interface AgentDefinition {
  id: string;
  localPart: string;
  displayName: string;
}

export interface AgentMailboxIdentity {
  id: string;
  displayName: string;
  email: string;
  replyTo: string;
}

export const AGENT_DEFINITIONS = [
  {id: 'az-agent-backend', localPart: 'backend', displayName: 'Alazab Backend Agent'},
  {id: 'az-agent-azabot', localPart: 'azabot', displayName: 'Azabot'},
  {id: 'az-agent-auth', localPart: 'auth', displayName: 'Alazab Auth Agent'},
  {id: 'az-agent-prod', localPart: 'prod', displayName: 'Alazab Production Agent'},
  {id: 'az-agent-maint', localPart: 'maint', displayName: 'Alazab Maintenance Agent'},
  {id: 'az-agent-core', localPart: 'core', displayName: 'Alazab Core Agent'},
  {id: 'az-agent-bim', localPart: 'bim', displayName: 'Alazab BIM Agent'},
  {id: 'az-agent-finance', localPart: 'finance', displayName: 'Alazab Finance Agent'},
  {id: 'az-agent-payments', localPart: 'payments', displayName: 'Alazab Payments Agent'},
  {id: 'az-agent-copilot', localPart: 'copilot', displayName: 'Alazab Copilot Agent'},
  {id: 'az-agent-project', localPart: 'project', displayName: 'Alazab Project Agent'},
  {id: 'az-agent-vision', localPart: 'vision', displayName: 'Alazab Vision Agent'},
] as const satisfies readonly AgentDefinition[];

interface AgentIdentityOverride {
  displayName?: string;
  email?: string;
  replyTo?: string;
}

export interface AgentDirectory {
  identities: readonly AgentMailboxIdentity[];
  authenticate(token: string): AgentMailboxIdentity | undefined;
  getById(id: string): AgentMailboxIdentity | undefined;
}

export class AgentIdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIdentityConfigError';
  }
}

/**
 * Build the fixed sender directory for Microsoft Foundry agents.
 *
 * A caller authenticates with a unique bearer token. The token selects the
 * mailbox server-side; the agent never gets to choose or override its `from`
 * address. This prevents one agent from impersonating another.
 */
export function loadAgentDirectory(env: NodeJS.ProcessEnv = process.env): AgentDirectory {
  const domain = normalizeDomain(env.AZ_MAIL_AGENT_DOMAIN ?? 'agents.alazab.com');
  const tokens = parseObject(env.AZ_MAIL_AGENT_TOKENS_JSON, 'AZ_MAIL_AGENT_TOKENS_JSON', true);
  const overrides = parseObject(env.AZ_MAIL_AGENT_IDENTITIES_JSON, 'AZ_MAIL_AGENT_IDENTITIES_JSON', false) as Record<
    string,
    AgentIdentityOverride
  >;

  const identities: AgentMailboxIdentity[] = [];
  const tokenToIdentity = new Map<string, AgentMailboxIdentity>();
  const idToIdentity = new Map<string, AgentMailboxIdentity>();

  for (const definition of AGENT_DEFINITIONS) {
    const tokenValue = tokens[definition.id];
    const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';

    if (token.length < 32) {
      throw new AgentIdentityConfigError(
        `AZ_MAIL_AGENT_TOKENS_JSON must contain a unique token of at least 32 characters for ${definition.id}.`,
      );
    }

    if (tokenToIdentity.has(token)) {
      throw new AgentIdentityConfigError(`Duplicate bearer token configured for ${definition.id}.`);
    }

    const overrideValue = overrides[definition.id];
    const override = isPlainObject(overrideValue) ? (overrideValue as AgentIdentityOverride) : undefined;
    const email = validateEmail(override?.email?.trim() || `${definition.localPart}@${domain}`, definition.id, 'email');
    const replyTo = validateEmail(override?.replyTo?.trim() || email, definition.id, 'replyTo');
    const displayName = override?.displayName?.trim() || definition.displayName;

    const identity: AgentMailboxIdentity = Object.freeze({
      id: definition.id,
      displayName,
      email,
      replyTo,
    });

    identities.push(identity);
    tokenToIdentity.set(token, identity);
    idToIdentity.set(identity.id, identity);
  }

  return {
    identities: Object.freeze(identities),
    authenticate(token: string) {
      return tokenToIdentity.get(token);
    },
    getById(id: string) {
      return idToIdentity.get(id);
    },
  };
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^@/, '');

  if (!domain || domain.includes('/') || domain.includes(':') || !/^[a-z0-9.-]+$/.test(domain)) {
    throw new AgentIdentityConfigError(`AZ_MAIL_AGENT_DOMAIN is not a valid mail domain: "${value}".`);
  }

  return domain;
}

function validateEmail(value: string, agentId: string, field: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AgentIdentityConfigError(`Invalid ${field} address for ${agentId}: "${value}".`);
  }

  return value.toLowerCase();
}

function parseObject(value: string | undefined, name: string, required: boolean): Record<string, unknown> {
  if (!value?.trim()) {
    if (required) {
      throw new AgentIdentityConfigError(`${name} is required.`);
    }

    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AgentIdentityConfigError(`${name} must be valid JSON: ${(error as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new AgentIdentityConfigError(`${name} must be a JSON object keyed by agent ID.`);
  }

  return parsed as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
