export type AgentNotification = {
  id: string;
  sequence: number;
  fromSessionId: string;
  toSessionId: string;
  text: string;
  status: "queued" | "delivered" | "acknowledged";
  createdAt: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  actorId: string | null;
  actorName: string | null;
  direction: "incoming" | "outgoing";
};
export type NotificationRequest = { requestId: string; text: string; recipient: string };
export const NOTIFICATION_MAX_BYTES = 16 * 1024;
export function notificationBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
export function notificationStatus(status: AgentNotification["status"]): string {
  return { queued: "Queued", delivered: "Delivery attempted", acknowledged: "Accepted by agent" }[status];
}
/** Pages and polls may race; an older response must never regress delivery evidence. */
export function mergeNotifications(current: AgentNotification[], incoming: AgentNotification[]): AgentNotification[] {
  const rank = { queued: 0, delivered: 1, acknowledged: 2 };
  const result = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = result.get(message.id);
    if (!previous || rank[message.status] >= rank[previous.status]) result.set(message.id, message);
  }
  return [...result.values()].sort((a, b) => b.sequence - a.sequence);
}
export function notificationRequestMatches(pending: NotificationRequest, text: string, recipient: string): boolean {
  return pending.text === text.trim() && pending.recipient === recipient;
}
