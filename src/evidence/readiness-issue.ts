export interface ReadinessIssue {
  readonly location: "title" | "context" | "commit";
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly sha?: string;
}
