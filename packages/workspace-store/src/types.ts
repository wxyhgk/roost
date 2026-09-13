export type SessionRecord = {
  id: string;
  title: string;
  note: string | null;
  projectId: string | null;
  cwd: string;
  closed: boolean;
};

export type ProjectRecord = {
  id: string;
  name: string;
  color: string;
};

export type WorkspaceSnapshot = {
  sessions: SessionRecord[];
  projects: ProjectRecord[];
  selectedId: string | null;
  selectedConversationId: string | null;
  followTerminalConversation: boolean;
  expandedProjectIds: string[];
  pinnedSessionIds: string[];
  sessionSeq: number;
  projectSeq: number;
};

export type ConversationSelection = {
  selectedConversationId: string | null;
  followTerminalConversation: boolean;
};

export type ConversationSelectionPatch = Partial<ConversationSelection>;

export type TerminalReplayRow = {
  raw: string;
  snapshot: string | null;
  updatedAt: number;
  stateJson: string | null;
};

export type WorkspaceStoreOptions = { dataDir: string };
