/**
 * Classification logic for compatibility matrix cells.
 */

export type CellClassification =
  | "supported"
  | "expected-incompatible"
  | "infrastructure"
  | "skipped"
  | "unexpected-failure"
  | "unexpected-pass";

export interface CellFacts {
  engineRef: string;
  packRef: string;
  actionCommit: string;
  runUrl: string;
  buildOutcome: "success" | "failure" | "timeout" | "cancelled";
  actionStatus?: string;
  passed?: number;
  failures?: number;
  warnings?: number;
  errors?: number;
  replayedCount?: number;
  total?: number;
  firstDiagnostic?: string;
  ranNoChecks: boolean;
}

export interface ExpectationEntry {
  engineRef: string;
  packRef: string;
  expectedStatus: "fail" | "error" | "execution-failed";
  failureSignature: string;
  runUrl: string;
  dateAdded: string;
  reason: string;
}

export interface ClassifiedCell {
  engineRef: string;
  packRef: string;
  actionCommit: string;
  runUrl: string;
  classification: CellClassification;
  reason: string;
  evidence: string;
}

export function classifyCell(
  facts: CellFacts,
  expectations: readonly ExpectationEntry[],
): ClassifiedCell;

export function shouldFailJob(classification: CellClassification): boolean;

export function formatCellRow(cell: ClassifiedCell): string;

export function formatResultsTable(cells: readonly ClassifiedCell[]): string;