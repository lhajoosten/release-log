export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalConflictError";
  }
}
export function proposalObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProposalConflictError("GitHub returned incomplete proposal evidence.");
  return Object.fromEntries(Object.entries(value));
}
