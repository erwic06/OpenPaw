export interface Task {
  id: string;
  title: string;
  status: string;
  type: string;
  contract: string;
  dependencies: string[];
  assigned: string;
  artifacts: string[];
  acceptance: string;
  notes: string[];
}
