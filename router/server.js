/**
 * IntentBridge — Cross-Rollup Router Server
 * ==========================================
 * Off-chain routing engine for SC6019 Option 6.
 *
 * Architecture
 * ────────────
 *   User intent  →  /api/intents  →  Routing Engine  →  Best Rollup
 *                                           │
 *                            Scores each rollup by:
 *                              • Normalised fee       (cost score)
 *                              • Normalised latency   (speed score)
 *                              • Success probability  (reliability)
 *                            Weighted by user's routing preference.
 *
 * Trust model (for report)
 * ────────────────────────
 *   This router is a centralised component — a single point of trust.
 *   A malicious router could route to an expensive rollup it controls.
 *   Mitigations discussed in the analysis section of the frontend:
 *     1. Publish routing logic on-chain (IntentRegistry stores reason hash).
 *     2. Multiple competing routers with a fallback mechanism.
 *     3. User-specified max-fee to prevent routing abuse.
 *
 * Run:  node router/server.js
 */

"use strict";

const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── Rollup definitions ────────────────────────────────────────────────────────
//
// Each rollup entry represents a distinct execution environment.
// `baseFeeGwei` and `baseLatencyMs` are the floor values at zero congestion.
// Congestion is a dynamic variable updated every 4 seconds.

const ROLLUPS = {
  rollupA: {
    id:            "rollupA",
    name:          "ArbiNova",
    fullName:      "ArbiNova Rollup",
    rollupType:    "Optimistic",
    description:   "Arbitrum-style optimistic rollup. Lowest fees, 7-day challenge window, ideal for non-urgent transfers.",
    color:         "#00e5ff",
    baseFeeGwei:   0.5,   // very low — optimistic rollups batch calldata cheaply
    baseLatencyMs: 2000,  // slower soft-finality
    congestion:    10,
  },
  rollupB: {
    id:            "rollupB",
    name:          "OptiSwift",
    fullName:      "OptiSwift Network",
    rollupType:    "Optimistic",
    description:   "Optimism-style rollup with faster sequencer. Balanced fee and speed, good for DeFi interactions.",
    color:         "#ff4560",
    baseFeeGwei:   1.2,
    baseLatencyMs: 800,
    congestion:    35,
  },
  rollupC: {
    id:            "rollupC",
    name:          "ZkRapid",
    fullName:      "ZkRapid Proof Network",
    rollupType:    "ZK",
    description:   "ZK proof rollup. Near-instant finality due to validity proofs. Higher proof generation cost.",
    color:         "#7b61ff",
    baseFeeGwei:   3.0,   // higher — ZK proof overhead
    baseLatencyMs: 300,   // fastest — no challenge period
    congestion:    55,
  },
};

// ── Dynamic congestion simulation ─────────────────────────────────────────────
//
// Congestion changes realistically over time using sinusoidal waves with
// random noise — mimicking real block demand patterns.

let tick = 0;

function stepCongestion() {
  tick++;
  const noise = () => (Math.random() - 0.5) * 12;

  ROLLUPS.rollupA.congestion = clamp(
    10 + 18 * Math.sin(tick / 18)          + noise(), 0, 100);
  ROLLUPS.rollupB.congestion = clamp(
    35 + 22 * Math.sin(tick / 14 + 1.2)    + noise(), 0, 100);
  ROLLUPS.rollupC.congestion = clamp(
    55 + 28 * Math.sin(tick / 10 + 2.4)    + noise(), 0, 100);
}

setInterval(stepCongestion, 4000);

// ── Fee / latency / success models ───────────────────────────────────────────

/** Fee increases quadratically with congestion (mirrors EIP-1559 surge pricing) */
function getFee(rollupId) {
  const r  = ROLLUPS[rollupId];
  const c  = r.congestion / 100;          // 0–1
  return r.baseFeeGwei * (1 + c * c);     // quadratic surge
}

/** Latency increases linearly with congestion */
function getLatency(rollupId) {
  const r = ROLLUPS[rollupId];
  return Math.round(r.baseLatencyMs * (1 + r.congestion / 100));
}

/**
 * Success probability decreases with congestion.
 * Higher congestion → more mempool competition → higher revert/drop rate.
 * Returns a value in [0.70, 1.00].
 */
function getSuccessProb(rollupId) {
  return Math.max(0.70, 1 - ROLLUPS[rollupId].congestion / 333);
}

// ── Routing engine ────────────────────────────────────────────────────────────

const WEIGHTS = {
  cheapest: { fee: 0.70, latency: 0.15, success: 0.15 },
  fastest:  { fee: 0.10, latency: 0.75, success: 0.15 },
  balanced: { fee: 0.40, latency: 0.40, success: 0.20 },
};

/**
 * Score every rollup and return sorted results.
 * Scores are normalised so the "best" rollup on each criterion gets 100.
 */
function scoreAllRollups(preference) {
  const ids     = Object.keys(ROLLUPS);
  const weights = WEIGHTS[preference] || WEIGHTS.balanced;

  const fees      = ids.map(getFee);
  const latencies = ids.map(getLatency);

  const minFee = Math.min(...fees),    maxFee = Math.max(...fees);
  const minLat = Math.min(...latencies), maxLat = Math.max(...latencies);

  return ids
    .map((id, i) => {
      const fee     = fees[i];
      const latency = latencies[i];
      const success = getSuccessProb(id);

      // Normalise: 1 = best (lowest fee / lowest latency), 0 = worst
      const normFee = maxFee === minFee ? 1 : 1 - (fee - minFee) / (maxFee - minFee);
      const normLat = maxLat === minLat ? 1 : 1 - (latency - minLat) / (maxLat - minLat);

      const score =
        weights.fee     * normFee +
        weights.latency * normLat +
        weights.success * success;

      return {
        rollupId:    id,
        name:        ROLLUPS[id].name,
        fee:         +fee.toFixed(4),
        latency,
        congestion:  Math.round(ROLLUPS[id].congestion),
        successProb: +(success * 100).toFixed(1),
        score:       +(score * 100).toFixed(2),
        scoreBreakdown: {
          feeScore:     +(normFee  * 100).toFixed(1),
          latencyScore: +(normLat  * 100).toFixed(1),
          successScore: +(success  * 100).toFixed(1),
          weights,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Build a human-readable explanation of the routing decision */
function buildReasons(winner, allScores) {
  const r      = ROLLUPS[winner.rollupId];
  const second = allScores[1];
  const reasons = [];

  reasons.push(`Routed to ${r.name} with composite score ${winner.score}/100`);
  reasons.push(`Current fee: ${winner.fee} gwei (congestion: ${winner.congestion}%)`);
  reasons.push(`Estimated confirmation: ${winner.latency} ms`);
  reasons.push(`Execution success probability: ${winner.successProb}%`);

  const feeSaved = (second.fee - winner.fee).toFixed(4);
  if (parseFloat(feeSaved) > 0) {
    reasons.push(`Saves ${feeSaved} gwei vs. next-best option (${second.name})`);
  }
  if (winner.congestion < 20)  reasons.push(`Low congestion window — optimal routing timing`);
  if (winner.rollupId === "rollupC") reasons.push(`ZK finality guarantees fast settlement`);

  return reasons;
}

// ── In-memory intent store ────────────────────────────────────────────────────

const intentStore   = new Map();   // id → intent object
const intentHistory = [];          // recent executed intents (capped at 200)

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/rollups
 * Returns live state of all simulated rollup environments.
 */
app.get("/api/rollups", (_req, res) => {
  const rollups = Object.values(ROLLUPS).map(r => ({
    id:          r.id,
    name:        r.name,
    fullName:    r.fullName,
    rollupType:  r.rollupType,
    description: r.description,
    color:       r.color,
    fee:         +getFee(r.id).toFixed(4),
    latency:     getLatency(r.id),
    congestion:  Math.round(r.congestion),
    successProb: +(getSuccessProb(r.id) * 100).toFixed(1),
    execCount:   [...intentStore.values()]
                   .filter(i => i.selectedRollup === r.id && i.status === "executed").length,
  }));
  res.json({ rollups, timestamp: Date.now() });
});

/**
 * POST /api/intents/preview
 * Dry-run: returns routing decision without persisting an intent.
 * Body: { preference?: "cheapest"|"fastest"|"balanced" }
 */
app.post("/api/intents/preview", (req, res) => {
  const { preference = "balanced" } = req.body;
  const scores  = scoreAllRollups(preference);
  const winner  = scores[0];
  const reasons = buildReasons(winner, scores);
  res.json({ winner, allScores: scores, reasons, timestamp: Date.now() });
});

/**
 * POST /api/intents
 * Submit a user intent.  Router scores rollups and selects the best one.
 * Body: {
 *   intentType:  "payment"|"token_swap"|"asset_transfer"
 *   amount:      number (token units)
 *   token:       string  (token symbol or address)
 *   recipient:   string  (address)
 *   preference:  "cheapest"|"fastest"|"balanced"
 *   description: string  (optional user note)
 *   user:        string  (wallet address, optional)
 * }
 */
app.post("/api/intents", (req, res) => {
  const {
    intentType  = "payment",
    amount,
    token       = "ETH",
    recipient   = "0x" + crypto.randomBytes(20).toString("hex"),
    preference  = "balanced",
    description = "",
    user        = "0x" + crypto.randomBytes(20).toString("hex"),
  } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount must be > 0" });
  }

  const id      = "0x" + crypto.randomBytes(32).toString("hex");
  const scores  = scoreAllRollups(preference);
  const winner  = scores[0];
  const worst   = scores[scores.length - 1];
  const reasons = buildReasons(winner, scores);

  const feeSaved = Math.max(0, worst.fee - winner.fee);

  const intent = {
    id,
    user,
    intentType,
    amount:             Number(amount),
    token,
    recipient,
    preference,
    description,
    selectedRollup:     winner.rollupId,
    selectedRollupName: ROLLUPS[winner.rollupId].name,
    estimatedFee:       winner.fee,
    estimatedLatency:   winner.latency,
    routeScore:         winner.score,
    routingReasons:     reasons,
    allScores:          scores,
    feeSaved:           +feeSaved.toFixed(4),
    status:             "routed",
    submittedAt:        Date.now(),
    executedAt:         null,
    actualFee:          null,
  };

  intentStore.set(id, intent);

  // Simulate async execution after estimated latency (+ small jitter)
  const jitter = Math.random() * 300;
  setTimeout(() => {
    const i = intentStore.get(id);
    if (!i) return;
    // Actual fee is estimate ± 5%
    i.actualFee  = +(i.estimatedFee * (0.95 + Math.random() * 0.1)).toFixed(4);
    i.executedAt = Date.now();
    i.status     = "executed";

    intentHistory.unshift({ ...i });
    if (intentHistory.length > 200) intentHistory.pop();
  }, intent.estimatedLatency + jitter);

  res.json({ intent, message: "Intent routed successfully" });
});

/**
 * GET /api/intents/history
 * Returns the 20 most recently executed intents.
 */
app.get("/api/intents/history", (_req, res) => {
  res.json({ intents: intentHistory.slice(0, 20) });
});

/**
 * GET /api/intents/:id
 * Poll for intent execution status.
 */
app.get("/api/intents/:id", (req, res) => {
  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  res.json(intent);
});

/**
 * POST /api/intents/batch-preview
 * Preview how batching N identical intents reduces per-intent cost.
 * Demonstrates the scalability benefit of intent aggregation.
 * Body: { count: number, preference?: string }
 */
app.post("/api/intents/batch-preview", (req, res) => {
  const { count = 10, preference = "balanced" } = req.body;
  const scores   = scoreAllRollups(preference);
  const winner   = scores[0];

  // Batching model: gas overhead is amortised across N transactions.
  // Single tx base overhead: ~21000 gas.  Batch saves ~80% of base overhead.
  const singleFee = winner.fee;
  const batchFee  = singleFee + (singleFee * 0.2 * (count - 1)) / count;
  const saving    = +((singleFee - batchFee) * count).toFixed(4);

  res.json({
    rollup:      winner.name,
    count,
    singleFee,
    batchFeePerIntent: +batchFee.toFixed(4),
    totalSaving: saving,
    savingPct:   +(((singleFee - batchFee) / singleFee) * 100).toFixed(1),
  });
});

/**
 * GET /api/analytics
 * Aggregate statistics for the dashboard.
 */
app.get("/api/analytics", (_req, res) => {
  const executed = intentHistory.filter(i => i.status === "executed");
  const totalFeeSaved = executed.reduce((s, i) => s + (i.feeSaved || 0), 0);

  const byRollup = {};
  Object.values(ROLLUPS).forEach(r => {
    byRollup[r.id] = { name: r.name, count: 0, color: r.color };
  });
  executed.forEach(i => {
    if (byRollup[i.selectedRollup]) byRollup[i.selectedRollup].count++;
  });

  const byPref = { cheapest: 0, fastest: 0, balanced: 0 };
  executed.forEach(i => { if (byPref[i.preference] !== undefined) byPref[i.preference]++; });

  const avgFee = executed.length
    ? +(executed.reduce((s, i) => s + (i.actualFee || i.estimatedFee), 0) / executed.length).toFixed(4)
    : 0;

  res.json({
    totalIntents:  intentStore.size,
    totalExecuted: executed.length,
    totalFeeSaved: +totalFeeSaved.toFixed(4),
    avgFee,
    byRollup,
    byPreference: byPref,
  });
});

/**
 * POST /api/simulate/congestion
 * Demo helper: manually set congestion levels for a rollup.
 * Body: { rollupId, level }
 */
app.post("/api/simulate/congestion", (req, res) => {
  const { rollupId, level } = req.body;
  if (!ROLLUPS[rollupId] || level < 0 || level > 100) {
    return res.status(400).json({ error: "Invalid rollupId or level" });
  }
  ROLLUPS[rollupId].congestion = Number(level);
  res.json({ ok: true, rollupId, congestion: level });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nIntentBridge Router  →  http://localhost:${PORT}`);
  console.log(`Simulated rollups   :  ${Object.values(ROLLUPS).map(r => r.name).join("  |  ")}`);
  console.log(`Press Ctrl+C to stop\n`);
});

// ── Utility ───────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
