// Shared HTTP contract between MCP wrappers, the coordination server, the
// CLI and (by convention, since it is plain JS) the Chrome extension.

export type AgentStatus = "idle" | "active";

export interface AgentAction {
  text: string;
  type: string;
  timestamp: string;
}

/** A tab owned by an agent. pageId is in the owning wrapper's chrome-devtools-mcp id space. */
export interface AgentTab {
  pageId: number;
  /** Chrome extension tab id (chrome.tabs), null if unknown (e.g. isolated contexts). */
  tabId: number | null;
  url: string;
  title: string;
}

export interface AgentPublic {
  id: string;
  clientName: string;
  clientVersion: string;
  label: string;
  color: string;
  taskName: string;
  status: AgentStatus;
  halted: boolean;
  tabs: AgentTab[];
  currentPageId: number | null;
  /** Most recent actions, oldest first (max 20). */
  actions: AgentAction[];
  createdAt: string;
  lastActionAt: string | null;
}

/**
 * What a tab's content script (and therefore the web page itself, which can
 * read the overlay DOM) gets to know. Deliberately minimal: no task name and
 * no action text (which can contain URLs of other sites), only the action type.
 */
export interface TabView {
  agentId: string;
  label: string;
  color: string;
  status: AgentStatus;
  halted: boolean;
  /** Type of the agent's latest action, e.g. "click"; null on non-current tabs. */
  lastActionType: string | null;
  current: boolean;
}

export interface StatePayload {
  version: string;
  protocol: number;
  agents: AgentPublic[];
  /** Keyed by Chrome tab id (as a string). Only tabs with a known tabId appear. */
  tabs: Record<string, TabView>;
}

export interface IdentityPayload {
  identity: "web-mcp-server";
  version: string;
  protocol: number;
  pid: number;
  /** hex(HMAC-SHA256(token, challenge)) when /.identity was called with ?challenge=. */
  proof?: string;
}

export const SERVER_IDENTITY = "web-mcp-server";
