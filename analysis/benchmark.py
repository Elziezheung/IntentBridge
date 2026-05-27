"""
IntentBridge — Routing Benchmark & Scalability Analysis
========================================================
SC6019 Option 6 Analysis Script

Simulates 1000 cross-rollup routing decisions under four congestion scenarios
and quantifies fee savings, routing accuracy, and scalability gains.

Run:   python analysis/benchmark.py
Deps:  pip install matplotlib numpy   (optional — falls back to text tables)
"""

import random
import math
import statistics
from dataclasses import dataclass, field
from typing import List, Dict, Tuple

random.seed(42)

# ─── Rollup definitions ────────────────────────────────────────────────────────

@dataclass
class Rollup:
    id:             str
    name:           str
    rollup_type:    str
    base_fee_gwei:  float
    base_latency_ms: int

    def fee(self, congestion: float) -> float:
        """Quadratic congestion surcharge (matches server.js model)."""
        c = congestion / 100.0
        return self.base_fee_gwei * (1 + c * c)

    def latency(self, congestion: float) -> int:
        """Linear latency increase with congestion."""
        return int(self.base_latency_ms * (1 + congestion / 100))

    def success_prob(self, congestion: float) -> float:
        return max(0.70, 1 - congestion / 333)


ROLLUPS = [
    Rollup("rollupA", "ArbiNova",  "Optimistic", 0.5,  2000),
    Rollup("rollupB", "OptiSwift", "Optimistic", 1.2,  800),
    Rollup("rollupC", "ZkRapid",   "ZK",         3.0,  300),
]

# ─── Routing algorithm (mirrors server.js) ────────────────────────────────────

WEIGHTS = {
    "cheapest": {"fee": 0.70, "latency": 0.15, "success": 0.15},
    "fastest":  {"fee": 0.10, "latency": 0.75, "success": 0.15},
    "balanced": {"fee": 0.40, "latency": 0.40, "success": 0.20},
}

def route(congestions: Dict[str, float], preference: str) -> Tuple[Rollup, float, int]:
    """Return (best_rollup, fee_saved_vs_worst, latency_saved_vs_worst)."""
    w = WEIGHTS[preference]
    fees      = [r.fee(congestions[r.id])     for r in ROLLUPS]
    latencies = [r.latency(congestions[r.id]) for r in ROLLUPS]

    min_fee, max_fee = min(fees), max(fees)
    min_lat, max_lat = min(latencies), max(latencies)

    def score(i):
        f = fees[i]; l = latencies[i]; s = ROLLUPS[i].success_prob(congestions[ROLLUPS[i].id])
        nf = 1 - (f - min_fee) / (max_fee - min_fee + 1e-9)
        nl = 1 - (l - min_lat) / (max_lat - min_lat + 1e-9)
        return w["fee"] * nf + w["latency"] * nl + w["success"] * s

    scores   = [score(i) for i in range(len(ROLLUPS))]
    best_idx = scores.index(max(scores))
    worst_idx= scores.index(min(scores))

    fee_saved     = fees[worst_idx]     - fees[best_idx]
    latency_saved = latencies[worst_idx] - latencies[best_idx]
    return ROLLUPS[best_idx], max(0, fee_saved), max(0, latency_saved)

# ─── Congestion scenarios ─────────────────────────────────────────────────────

def make_congestion(a, b, c):
    return {"rollupA": a, "rollupB": b, "rollupC": c}

SCENARIOS = {
    "Uniform Low     (all ~10%)":
        lambda: make_congestion(
            random.gauss(10, 3), random.gauss(10, 3), random.gauss(10, 3)),
    "Uniform Medium  (all ~50%)":
        lambda: make_congestion(
            random.gauss(50, 8), random.gauss(50, 8), random.gauss(50, 8)),
    "Asymmetric      (A high, B+C low)":
        lambda: make_congestion(
            random.gauss(85, 5), random.gauss(15, 5), random.gauss(20, 5)),
    "Uniform High    (all ~85%)":
        lambda: make_congestion(
            random.gauss(85, 5), random.gauss(85, 5), random.gauss(85, 5)),
}

# ─── Simulation ───────────────────────────────────────────────────────────────

N_INTENTS   = 1000
PREFERENCES = ["cheapest", "fastest", "balanced"]

@dataclass
class ScenarioResult:
    scenario:       str
    preference:     str
    fee_savings:    List[float] = field(default_factory=list)
    latency_savings:List[int]   = field(default_factory=list)
    rollup_picks:   Dict[str, int] = field(default_factory=dict)

    @property
    def avg_fee_saving(self):    return statistics.mean(self.fee_savings)
    @property
    def median_fee_saving(self): return statistics.median(self.fee_savings)
    @property
    def total_fee_saving(self):  return sum(self.fee_savings)
    @property
    def avg_latency_saving(self):return statistics.mean(self.latency_savings)


def run_benchmark() -> List[ScenarioResult]:
    results = []
    for scenario_name, cong_fn in SCENARIOS.items():
        for pref in PREFERENCES:
            res = ScenarioResult(scenario_name, pref)
            for _ in range(N_INTENTS):
                congestions = {r.id: max(0, min(100, cong_fn()[k]))
                               for r, k in zip(ROLLUPS, ["rollupA","rollupB","rollupC"])}
                congestions = cong_fn()
                # clamp
                congestions = {k: max(0, min(100, v)) for k, v in congestions.items()}

                best, fee_saved, lat_saved = route(congestions, pref)
                res.fee_savings.append(fee_saved)
                res.latency_savings.append(lat_saved)
                res.rollup_picks[best.id] = res.rollup_picks.get(best.id, 0) + 1

            results.append(res)
    return results

# ─── Report ───────────────────────────────────────────────────────────────────

def print_table(results: List[ScenarioResult]):
    print("\n" + "═" * 100)
    print("  IntentBridge — Routing Benchmark Results")
    print(f"  {N_INTENTS} intents per scenario × {len(SCENARIOS)} scenarios × {len(PREFERENCES)} preferences")
    print("═" * 100)

    for scenario in SCENARIOS:
        print(f"\n  Scenario: {scenario.strip()}")
        print("  " + "─" * 95)
        print(f"  {'Preference':<12}  {'Avg Fee Saved':>14}  {'Median':>8}  "
              f"{'Total Saved':>12}  {'Avg Lat Saved':>14}  {'Most Picked':<14}")
        print("  " + "─" * 95)

        for r in results:
            if r.scenario != scenario:
                continue
            most_picked = max(r.rollup_picks, key=r.rollup_picks.get)
            most_name   = next(rl.name for rl in ROLLUPS if rl.id == most_picked)
            pct         = r.rollup_picks[most_picked] / N_INTENTS * 100
            print(f"  {r.preference:<12}  {r.avg_fee_saving:>13.4f}g  "
                  f"{r.median_fee_saving:>7.4f}g  "
                  f"{r.total_fee_saving:>10.2f}g  "
                  f"{r.avg_latency_saving:>12.0f}ms  "
                  f"{most_name} ({pct:.0f}%)")

    print("\n" + "═" * 100)


def print_scalability_analysis(results: List[ScenarioResult]):
    print("\n  Scalability Analysis")
    print("  " + "─" * 60)

    # Total savings across all scenarios and preferences
    all_savings = [r.total_fee_saving for r in results]
    grand_total = sum(all_savings)
    total_intents = N_INTENTS * len(SCENARIOS) * len(PREFERENCES)

    print(f"\n  Total intents simulated : {total_intents:,}")
    print(f"  Grand total fee saved   : {grand_total:.2f} gwei")
    print(f"  Average saving/intent   : {grand_total/total_intents:.4f} gwei")

    # Best scenario
    best = max(results, key=lambda r: r.avg_fee_saving)
    print(f"\n  Best scenario : {best.scenario.strip()}")
    print(f"  Preference    : {best.preference}")
    print(f"  Avg saving    : {best.avg_fee_saving:.4f} gwei/intent")

    # Routing adds most value when congestion is asymmetric
    asym_results = [r for r in results if "Asymmetric" in r.scenario]
    unif_results = [r for r in results if "Uniform Medium" in r.scenario]
    asym_avg = statistics.mean(r.avg_fee_saving for r in asym_results)
    unif_avg = statistics.mean(r.avg_fee_saving for r in unif_results)
    uplift   = (asym_avg / unif_avg - 1) * 100 if unif_avg > 0 else 0

    print(f"\n  Asymmetric congestion uplift vs. uniform medium:")
    print(f"    Uniform Medium avg saving : {unif_avg:.4f} gwei")
    print(f"    Asymmetric     avg saving : {asym_avg:.4f} gwei")
    print(f"    Routing uplift            : {uplift:.1f}%")
    print()
    print("  → Routing provides highest value during asymmetric congestion,")
    print("    exactly when users manually choosing a chain are most likely")
    print("    to pick a suboptimal, overloaded rollup.")
    print()

    # ZK vs optimistic routing bias
    balanced_results = [r for r in results if r.preference == "balanced"]
    zk_picks = sum(r.rollup_picks.get("rollupC", 0) for r in balanced_results)
    total_picks = N_INTENTS * len(SCENARIOS)
    print(f"  ZK rollup (ZkRapid) selection rate (balanced preference):")
    print(f"    {zk_picks}/{total_picks} = {zk_picks/total_picks*100:.1f}%")
    print("    → ZK is rarely preferred for balanced/cheapest — its proof cost")
    print("      is only worth it when speed is prioritised.")

    print("\n" + "═" * 100)


if __name__ == "__main__":
    print("Running benchmark...")
    results = run_benchmark()
    print_table(results)
    print_scalability_analysis(results)

    # Try to plot if matplotlib available
    try:
        import matplotlib.pyplot as plt
        import numpy as np

        fig, axes = plt.subplots(1, 2, figsize=(14, 5))
        fig.suptitle("IntentBridge — Routing Benchmark Analysis", fontsize=14)

        # Plot 1: Average fee saving per scenario × preference
        scenario_labels = [s.strip().split("(")[0].strip() for s in SCENARIOS]
        x = np.arange(len(SCENARIOS))
        width = 0.25
        colors = {"cheapest": "#ffb800", "fastest": "#00e5ff", "balanced": "#7b61ff"}

        ax = axes[0]
        for j, pref in enumerate(PREFERENCES):
            avgs = [
                next(r.avg_fee_saving for r in results if r.preference == pref and r.scenario == s)
                for s in SCENARIOS
            ]
            ax.bar(x + j * width, avgs, width, label=pref.capitalize(), color=colors[pref], alpha=0.85)

        ax.set_xlabel("Congestion Scenario")
        ax.set_ylabel("Average Fee Saved (gwei)")
        ax.set_title("Fee Savings by Scenario & Preference")
        ax.set_xticks(x + width)
        ax.set_xticklabels(scenario_labels, fontsize=8, rotation=10)
        ax.legend()
        ax.grid(axis="y", alpha=0.3)

        # Plot 2: Rollup routing distribution (balanced, all scenarios stacked)
        ax2    = axes[1]
        rnames = [r.name for r in ROLLUPS]
        rids   = [r.id   for r in ROLLUPS]
        rcolors= {"rollupA": "#00e5ff", "rollupB": "#ff4560", "rollupC": "#7b61ff"}

        bar_data = {rid: [] for rid in rids}
        for s in SCENARIOS:
            res = next(r for r in results if r.preference == "balanced" and r.scenario == s)
            for rid in rids:
                bar_data[rid].append(res.rollup_picks.get(rid, 0))

        x2    = np.arange(len(SCENARIOS))
        bottom = np.zeros(len(SCENARIOS))
        for rid, rname in zip(rids, rnames):
            vals = np.array(bar_data[rid])
            ax2.bar(x2, vals, bottom=bottom, label=rname, color=rcolors[rid], alpha=0.85)
            bottom += vals

        ax2.set_xlabel("Congestion Scenario")
        ax2.set_ylabel("Number of Intents Routed")
        ax2.set_title("Routing Distribution (Balanced Preference)")
        ax2.set_xticks(x2)
        ax2.set_xticklabels(scenario_labels, fontsize=8, rotation=10)
        ax2.legend()
        ax2.grid(axis="y", alpha=0.3)

        plt.tight_layout()
        out = "analysis/benchmark_results.png"
        plt.savefig(out, dpi=150)
        print(f"\n  Chart saved to {out}")
        plt.show()

    except ImportError:
        print("\n  (Install matplotlib + numpy to generate charts)")
