import {describe, expect, it} from 'vitest';

import {AgentIdentityConfigError, loadAgentDirectory} from '../agentIdentity.js';

const tokens = {
  'az-agent-backend': 'backend-token-00000000000000000000000000000000',
  'az-agent-azabot': 'azabot-token-000000000000000000000000000000000',
  'az-agent-auth': 'auth-token-00000000000000000000000000000000000',
  'az-agent-prod': 'prod-token-00000000000000000000000000000000000',
  'az-agent-maint': 'maint-token-0000000000000000000000000000000000',
  'az-agent-core': 'core-token-00000000000000000000000000000000000',
  'az-agent-bim': 'bim-token-000000000000000000000000000000000000',
  'az-agent-finance': 'finance-token-0000000000000000000000000000000000',
  'az-agent-payments': 'payments-token-000000000000000000000000000000000',
  'az-agent-copilot': 'copilot-token-0000000000000000000000000000000000',
  'az-agent-project': 'project-token-0000000000000000000000000000000000',
  'az-agent-vision': 'vision-token-00000000000000000000000000000000000',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AZ_MAIL_AGENT_DOMAIN: 'agents.alazab.com',
    AZ_MAIL_AGENT_TOKENS_JSON: JSON.stringify(tokens),
    ...overrides,
  };
}

describe('Alazab agent mailbox directory', () => {
  it('creates all 12 fixed agent identities', () => {
    const directory = loadAgentDirectory(env());

    expect(directory.identities).toHaveLength(12);
    expect(directory.getById('az-agent-finance')).toEqual({
      id: 'az-agent-finance',
      displayName: 'Alazab Finance Agent',
      email: 'finance@agents.alazab.com',
      replyTo: 'finance@agents.alazab.com',
    });
  });

  it('binds a token to exactly one agent identity', () => {
    const directory = loadAgentDirectory(env());

    expect(directory.authenticate(tokens['az-agent-payments'])?.id).toBe('az-agent-payments');
    expect(directory.authenticate(tokens['az-agent-finance'])?.id).toBe('az-agent-finance');
    expect(directory.authenticate('not-a-real-token')).toBeUndefined();
  });

  it('supports explicit mailbox overrides without changing the agent ID', () => {
    const directory = loadAgentDirectory(
      env({
        AZ_MAIL_AGENT_IDENTITIES_JSON: JSON.stringify({
          'az-agent-finance': {
            displayName: 'Alazab Finance',
            email: 'finance@alazab.com',
            replyTo: 'finance@alazab.com',
          },
        }),
      }),
    );

    expect(directory.getById('az-agent-finance')).toMatchObject({
      id: 'az-agent-finance',
      displayName: 'Alazab Finance',
      email: 'finance@alazab.com',
      replyTo: 'finance@alazab.com',
    });
  });

  it('refuses duplicate tokens', () => {
    const duplicate = {...tokens, 'az-agent-payments': tokens['az-agent-finance']};

    expect(() =>
      loadAgentDirectory(env({AZ_MAIL_AGENT_TOKENS_JSON: JSON.stringify(duplicate)})),
    ).toThrow(AgentIdentityConfigError);
  });
});
