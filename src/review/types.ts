export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES";

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "nit";
  file: string;
  line: number;
  description: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
}
