export type OptionId = "A" | "B" | "C";

export type ProjectType = "game" | "software" | "other";

export type VerificationSurface = "visual" | "business_rule" | "mixed" | "text";

export type Reversibility = "trivial" | "git_revert" | "costly" | "irreversible";

export interface AskOption {
  id: OptionId;
  label: string;
  evidence: string[];
  predicted_next_step: string;
  cost_if_wrong: string;
  confidence: number;
}

export interface AgentAsk {
  id: string;
  project_id: string;
  project_name: string;
  project_type: ProjectType;
  verification_surface: VerificationSurface;
  title: string;
  context: string;
  options: AskOption[];
  default_option_id: OptionId;
  confidence: number;
  reversibility: Reversibility;
  expected_loss_if_wrong: number;
  requested_human_seconds: number;
  expires_in_seconds: number;
  created_at: string;
  /** If set, server POSTs the HumanDecision (or auto-resolution) to this URL. */
  callback_url?: string;
}

export interface RejectedAsk {
  id: string;
  project_id: string;
  reason: string;
  repair_instructions: string[];
}

export interface CouncilVote {
  persona: string;
  vote: OptionId;
  confidence: number;
  reason: string;
}

export interface CouncilResult {
  ask_id: string;
  votes: CouncilVote[];
  entropy: number;
  predicted_human_choice: OptionId;
  escalate: boolean;
  disagreement_axis: string;
}

export interface AttentionBid {
  ask_id: string;
  score: number;
  reason: string;
  show_now: boolean;
}

export type DecisionChoice = OptionId | "override";

export interface HumanDecision {
  ask_id: string;
  choice: DecisionChoice;
  override_text?: string;
  create_rule: boolean;
  created_at: string;
}

export interface JudgmentRule {
  id: string;
  scope: "project" | "all";
  project_id?: string;
  when: string;
  prefer: string;
  avoid: string;
  examples: string[];
  counterexamples: string[];
  priority: number;
  source_ask_id: string;
  created_at: string;
  status: "draft" | "accepted" | "rejected" | "stale";
  /** Lowercase keyword set extracted from source ask; used by council to filter relevance. */
  topic?: string[];
}

export type Urgency = "now" | "soon" | "today";

export type AskStatus =
  | "pending"
  | "auto_resolved"
  | "decided"
  | "expired"
  | "stale"
  | "rejected"
  | "skipped";

export interface AskRecord {
  ask: AgentAsk;
  council?: CouncilResult;
  bid?: AttentionBid;
  decision?: HumanDecision;
  status: AskStatus;
  rejection_reason?: string;
  repair_instructions?: string[];
  safe_default_option_id?: OptionId;
  urgency?: Urgency;
  /** ISO time when the user skipped (for cooldown re-surface). */
  skipped_at?: string;
  /** Webhook delivery state. */
  callback_status?: "pending" | "delivered" | "failed";
  callback_attempts?: number;
}
