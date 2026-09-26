export const AGENT_START_UNAVAILABLE_REASON =
  "Agent start requires remote runner — not implemented";

export type AgentStartSelection = {
  taskId: string;
  environmentId: string;
  environmentStatus: string;
};

/**
 * Desktop may only request a real server start. Until a start endpoint exists,
 * every selection stays unavailable with an explicit reason — never simulate.
 */
export function describeAgentStartAvailability(
  selection: Partial<AgentStartSelection> | null,
): { available: false; reason: string } {
  if (!selection?.taskId?.trim()) {
    return {
      available: false,
      reason: "Select a created task before requesting agent start.",
    };
  }
  if (!selection.environmentId?.trim()) {
    return {
      available: false,
      reason: "Select a verified environment before requesting agent start.",
    };
  }
  if (selection.environmentStatus !== "verified") {
    return {
      available: false,
      reason:
        "Environment must be verified on the web before agent start can be requested.",
    };
  }
  return { available: false, reason: AGENT_START_UNAVAILABLE_REASON };
}
