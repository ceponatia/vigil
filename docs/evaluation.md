# Evaluation

This page governs how vigil measures itself: what it records before an outcome is known, how it classifies what actually happened, and what evidence is required before a change to strategy, model, or policy is allowed to affect real capital. [product.md](product.md) defines what success means; this page defines how that claim gets tested rather than asserted.

## Point-in-time integrity

vigil keeps distinct timestamps across the whole lifecycle of a decision — the **timestamp family**: event occurrence, publication, first observation, ingestion, feature availability, analysis completion, intent creation, quote acquisition, submission/broadcast, acknowledgement/inclusion, and fill/finality. A historical test may only use information that was actually available at the simulated decision time; nothing pulled from a later timestamp in the family may leak into an earlier one.

Revised articles, historical metadata, and changed tokenomics schedules are preserved as new versions rather than overwritten in place, so a replay can see exactly what was known at the time it claims to represent. Source disagreement and missing information are surfaced explicitly rather than silently resolved by an LLM guessing a plausible value.

## Opportunity journal

Every policy-eligible candidate is recorded **before** its outcome is known — executed, rejected, expired, intentionally missed, and correctly avoided all get a record at the same point in the pipeline, not just the ones that turn into trades. Each record retains market/portfolio state at the time, the proposed action, the reason codes involved, available capital, the alternative benchmark, model/prompt/policy versions, source timestamps, and the intended horizon.

Once an outcome matures, the journal also tracks realized/unrealized P&L, fees, slippage, network costs, fill probability, holding period, maximum favorable and adverse excursion, and time to invalidation. Short windows — five minutes, one hour, twenty-four hours — help diagnose timing quality without replacing a longer thesis's original objective.

## Error classification

Every mature outcome is classified into one of: a data-integrity error, a thesis error, an entry-timing error, a sizing/concentration error, an execution failure, or normal market uncertainty. A profitable trade that broke policy is still a process failure to record as one. A losing trade that followed a calibrated, policy-compliant process is not automatically a mistake.

An immediate adverse move right after entry and a genuinely invalidated longer-term thesis are kept as separate findings — one outcome is never used to permanently rewrite entry rules without corroborating evidence across a mature cohort.

## Counterfactuals and missed opportunities

A missed opportunity is only counted as one if vigil could plausibly have known about it in time, had spendable capital at the right venue, and could realistically have executed it under the depth, latency, and policy that actually applied at the time. Counterfactual entries and exits use the same predefined rules a live decision would have used — never the exact low followed by the exact high.

Counterfactuals share a capital budget: the same money cannot fund every simultaneous "winner" that a wider hypothetical scan turns up, and where order-book depth, route history, or queue position is unknown, the counterfactual carries an explicit uncertainty bound instead of a false-precision number. Unavailable execution routes, missing data, budget exclusions, policy rejections, late research, and a deliberate WAIT are all recorded as distinct reasons a candidate was not acted on — some of what looks like a miss afterward is a successful risk decision, not a bug.

## Validation protocol

- **Chronological splits.** Training, validation, and held-out test periods run in time order; observations whose forward outcome window crosses a split boundary are purged, and an embargo is applied where dependence could otherwise leak across the boundary. Delisted assets, point-in-time eligibility, tokenomics schedules, and first-seen news are all included rather than surviving only in a clean, backward-looking universe.
- **Realistic cost modeling.** Fees, spread/price impact, partial fills, queue position, latency, gas, route failures, and outages are modeled as they actually behave. An OHLC-only simulation does not prove fast-arbitrage execution; ambiguous same-bar stop/target ordering is resolved conservatively or marked unresolved rather than assumed in the strategy's favor.
- **Multiple-testing awareness.** Every strategy, feature, parameter, prompt, and model trial is registered, not just the ones that looked good. Deflated Sharpe Ratio and block-based uncertainty estimation are the methods evaluated for correcting an evaluation that ran many trials against dependent observations; neither one certifies future profit, and both exist to reduce a specific class of evaluation error, not to replace judgment.
- **LLM contamination caveat.** A present-day pretrained model may already know the outcome of a historical event supplied as a "backtest" input. Supplying an old article or anonymizing names does not make that test clean. A prospective shadow evaluation with frozen model and prompt versions is required to measure an LLM's actual incremental contribution, because only a forward-looking test is guaranteed free of this leak.

## Comparison baselines

Every proposed strategy or model is compared against at least:

- cash/settlement reserve and the passive BTC/ETH or relevant held-asset benchmark;
- a simple numerical strategy that runs without LLM research;
- the current production champion; and
- the proposed LLM-assisted strategy or challenger itself.

Assessment covers net results, open losses, drawdown, turnover, calibration, execution quality, cost sensitivity, and behavior across different market conditions — not a single aggregate number. A month of stable operation is operational evidence that the system runs correctly; it is not proof of durable alpha. Effective independent sample size and horizon overlap matter more than any universal trade-count threshold.

## Controlled adaptation

```text
Mature outcomes -> classify and propose improvement -> train/evaluate offline
      -> compare with frozen alternatives -> prospective shadow
      -> small approved live canary -> retain or roll back
```

Retraining does not by itself authorize deployment. A production champion and its independently evaluated challengers are both preserved so a promotion can be compared against what it is replacing. Initial live promotion, and any increase in capability or limits, requires the owner's approval; a later constrained automatic promotion is only permitted under an explicitly approved, tested promotion policy.

A losing canary pauses or returns to shadow — it never increases size to try to recover its own losses. Every promotion and rollback is reproducible from its data, code, model, prompt, and configuration hashes.

## Cadence of evaluation

An outcome label is only recorded once its predeclared horizon or terminal event actually matures — never estimated ahead of that point to make a report look more complete. Candidate-model evaluation runs in scheduled batches once sufficient mature evidence exists, rather than continuously chasing the newest partial result; retraining on a fresh batch is itself just another candidate for the pipeline above, not a promotion.

Success is measured net of costs, against the benchmarks above, over evidence that has actually matured — a stable month of running paper or shadow is operational evidence that the system behaves as designed, not evidence of alpha.
