/** Fixed room-wide budgets per minute; independent of per-IP edge limits. */
export const ROOM_BUDGETS = { http: 180, ticket: 24, epoch: 12, upgrade: 24 } as const;
