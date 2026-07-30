# Trial interest + backfill vs patient choice + queues: simulation results

*2026-07-29 · companion to the `v2 · Trial interest` and `v2 · Patient choice` tabs in the Matching Playground*

## The two methods (and the baseline)

**Patient choice + queues** (the `v2 · Patient choice` tab): patients rank up to 3 trials in preference order (1st ♥3, 2nd ♥2, 3rd ♥1). The Hungarian optimizer maximizes total preference; exact ties break by each trial's own first-come queue. Preference is encoded *before* assignment, which assumes patients can rank trials before the clinical team plans.

**Trial interest + backfill** (the `v2 · Trial interest` tab): the clinical team marks which trials each patient *could* be offered (unordered, eligibility-gated). The optimizer proposes the fill-maximizing placement as the Thursday-meeting artifact, and each trial carries a backfill list (who the optimizer would seat next, derived by counterfactual re-solves). Offers are worked through the week: offer → consent → pre-screen → screen → enroll. A decline or screen-fail removes the patient from that trial only, and the backfill promotes in the same re-solve. Patient preference enters at the appointment, as a decline or a team pin, not before.

**Status quo** (the baseline both are trying to beat): a hand-matched Thursday meeting, one trial per patient, no backfill. A fall-through waits for the next meeting to be re-discussed and gets its next offer the week after that.

Two simulations were run against the playground's actual engines (`match-engine.js`, `engines-v345.js`), 400 randomized cohorts each: 8 patients, 4 trials carrying 1 to 2 seats (5.2 seats on average), ~60% eligibility per patient-trial pair. Each patient carries a hidden true preference ranking. The choice method sees it upfront as ranked picks; the interest method cannot (the team marks all eligible trials), so preference surfaces only as declines. Both methods face identical decline and screening randomness: acceptance by true-preference rank 95/85/70/55/45%, pre-screen pass 80%, screen pass 85%.

## Simulation 1: head-to-head on identical information

Both methods assign the same cohorts; fall-throughs knock the patient out of that trial only, and the system re-solves until nothing changes.

| Metric (per cohort) | Choice + queues | Interest + backfill |
|---|---|---|
| Fill rate (baseline funnel) | 86.8% | **88.3%** |
| Fill rate (harsh funnel: elig 45%, pre-screen 65%, screen 75%) | 69.6% | **71.1%** |
| Fill rate (preference-sensitive patients: accept 95/60/35/20/10%) | 81.8% | 81.9% |
| Enrolled at their true favorite | **74–79%** | 51–63% |
| Mean preference rank of enrolled seat (1 = favorite) | **1.24–1.32** | 1.46–1.67 |
| Declines (preference-sensitive scenario) | **1.2** | 2.3 |
| Offer conversations (preference-sensitive scenario) | **7.5** | 8.7 |
| Nurse workload (pre-screens + screens) | ~12 | ~12 |

Findings:

- **Interest wins fill by only ~1.5 percentage points.** Unordered interest gives the optimizer every eligible cell; ranked top-3 truncates options. The gap is small and stable across funnels.
- **Choice wins preference satisfaction by a lot**: roughly three quarters of enrolled patients land their true favorite, vs barely half to 60% under interest. With genuinely picky patients, preference-blind proposals generate nearly double the declines and ~16% more offer conversations. Each extra decline is a burned physician appointment.
- The max-match toggle made no measurable difference for the choice method: the theoretical "strong preferences sacrifice fill" failure mode essentially never bites at this scale.
- Nurse workload is identical: screening happens once per accepted offer regardless of method.

This comparison is, however, unfair to interest: it grants the choice method free, perfect, day-zero preference data that the real clinic does not produce. The patient is not in the room on Thursday.

## Simulation 2: calendar time, where the real advantages live

Same cohorts on an 84-day calendar. Offers land at the patient's next weekly appointment (+7 days after being proposed). Declines resolve at the offer, pre-screen fails at +2 days, screen fails or enrollment at +7 days. Five arms decompose the value chain:

| Arm | Fill | Filled by day 28 | Mean days to enroll | Seat-idle days | Appointments |
|---|---|---|---|---|---|
| Status quo (hand greedy, no backfill) | 86.8% | 74.3% | 20.6 | 29.0 | 7.5 |
| Optimizer, Thursday-cadence only | 88.8% | 75.9% | 20.5 | 27.7 | 7.7 |
| **Interest + instant backfill** | 88.7% | **81.7%** | **18.0** | **25.5** | 7.6 |
| Choice + queues, 100% ranked upfront | 87.6% | 82.1% | 17.4 | 25.7 | **7.2** |
| Choice + queues, 50% ranked upfront | 86.5% | 76.6% | 19.9 | 28.5 | 11.9 |

Findings:

1. **The optimizer alone buys fill, not speed** (+2 points fill, zero days saved). **The instant backfill buys speed**: +7 points filled-by-day-28, 2.6 days faster to enrollment, 3.5 fewer idle days per seat. The backfill advantage is a latency phenomenon; fill rate alone cannot see it.
2. **Choice + queues only beats interest when every patient ranks before Thursday.** At 50% ranking coverage its speed collapses to status-quo levels and it burns ~60% more appointments (ranking conversations plus re-picks). Interest + backfill delivers near choice-100 speed with zero pre-meeting patient engagement. That robustness is its real advantage.
3. **At the 84-day horizon, fill converges across methods.** The differences live in the first month and in workload.

## Recommendation

Run interest mode for the Thursday board (maximum fill, no patient data needed, team in control, liability posture preserved). At the appointment, present the proposed trial plus the patient's other open eligible options and treat the patient's pick as a pin: most pins are free tie-breaks or near-free swaps, which claws back most of the 15 to 25 point preference-satisfaction gap. If a patient-facing ranking step is added later, feed those rankings into the next snapshot; that closes the decline gap for good.

## Measuring this in production

The decision log is the instrument; add timestamps for "patient enters matching pool" and "slot opens". Metrics, each isolating one claimed advantage:

| Metric | What it isolates | Notes |
|---|---|---|
| Fall-through recovery latency (decline/fail → next offer for that seat) | The backfill | Status quo is structurally ~14 days; backfill should cut it to ~7. High-frequency, reaches significance fast |
| Vacancy survival curve (% of seats filled by day X) | Accrual speed | The sponsor-facing number; where the day-28 gap shows |
| Offers and declines per enrollment | Cost of preference-blindness | If interest-mode declines run hot, add preference capture |
| Appointments per enrollment (incl. ranking and re-selection visits) | Total clinic cost | This is what buries choice + queues at low ranking coverage |
| Ranking coverage (% of pool with usable rankings at assignment time) | Whether choice + queues is even feasible | Measure first; below ~80% coverage, choice cannot win per the sim |
| Pin rate and pin cost | Team trust in the optimizer | Both already logged; flags clinically-off proposals |
| Meeting minutes and patients decided per meeting | The prep-time pain point | Survey plus logs, before vs after |

Study design: against the status quo, use a before/after or stepped-wedge across clinics with recovery latency and filled-by-day-28 as primary endpoints (not total fill, which converges). Between interest and choice, do not A/B patients within one site: they compete for the same seats and contaminate each other. Alternate by cohort-week, or pilot patient-facing ranking with a subset and compare decline rates. Feed the logged reality (accept-by-rank, screen pass rates, coverage) back into the simulators; once calibrated, they become the what-if tool for questions like "what ranking coverage would justify building the patient-facing flow?"

## Caveats

- Decline and screen-fail probabilities are assumptions, not measurements; magnitudes will move with real rates. The *direction* of every gap was robust across the three parameterizations tested.
- Cohorts are small (8 patients, ~5 seats) and static; there is no rolling intake.
- The calendar model compresses clinic scheduling to a weekly appointment grid.
- Queue fairness (first-come order) and patient trust effects are not modeled.

## Reproducing

```sh
node docs/simulations/method-compare.js     # simulation 1 (head-to-head)
node docs/simulations/calendar-compare.js   # simulation 2 (calendar time, five arms)
```

Both scripts are deterministic (seeded LCG) and self-contained; tune the constants at the top (`N_RUNS`, `ELIG_P`, `ACCEPT_BY_RANK`, `PRESCREEN_PASS`, `SCREEN_PASS`) to test other assumptions.
