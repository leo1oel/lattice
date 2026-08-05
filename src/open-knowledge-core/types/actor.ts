export type PrincipalId = string;
export type SessionId = string;

export type Actor = {
  principal: PrincipalId | null;
  agent_session: SessionId | null;
  kind: 'human' | 'agent' | 'system';
};
