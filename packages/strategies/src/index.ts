export {
  DEFAULT_STRATEGY_CONFIG,
  HORIZONS,
  STRATEGY_NO_SIGNAL_CODES,
  candidateSchema,
  generateCandidate,
} from "./candidate";
export type { Candidate, GenerateCandidateParams, GenerateCandidateResult, Horizon, StrategyConfig, StrategyNoSignalCode } from "./candidate";

export { buildPositionPlan, positionPlanSchema, trancheSchema } from "./position-plan";
export type { BuildPositionPlanParams, PositionPlan, Tranche } from "./position-plan";

export { CANDIDATE_OUTCOMES, evaluateEntry } from "./no-chasing";
export type { CandidateOutcome, EntryEvaluation, EntryEvaluationRecord, EvaluateEntryParams } from "./no-chasing";

export { addDecimal, compareDecimal, fromScaled, scaleOf, subtractDecimal, toScaled } from "./scaled-decimal";
