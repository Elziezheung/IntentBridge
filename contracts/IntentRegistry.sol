// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IntentRegistry
 * @notice On-chain ledger for cross-rollup user intents.
 *
 * Design philosophy
 * -----------------
 * The router is intentionally off-chain to keep latency low and costs
 * minimal — only the routing *decision* is anchored on-chain for
 * auditability.  This means users can verify which rollup was chosen and
 * why (via the reason hash), without paying for expensive on-chain routing
 * computation.
 *
 * Trust assumptions
 * -----------------
 * • The deployer sets the trusted router address (centralised trust point).
 * • A compromised router could route intents to an expensive rollup or one
 *   it controls.  Future work: multi-sig router or on-chain scoring.
 *
 * Scalability argument
 * --------------------
 * By abstracting chain selection from the user, the system can seamlessly
 * add new rollups without changing the user-facing intent interface.  As
 * the rollup ecosystem grows (hundreds of appchains), this routing layer
 * becomes increasingly valuable.
 */
contract IntentRegistry {
    // ─── Types ────────────────────────────────────────────────────────────────
    enum IntentType   { PAYMENT, TOKEN_SWAP, ASSET_TRANSFER }
    enum RoutingPref  { CHEAPEST, FASTEST, BALANCED }
    enum IntentStatus { PENDING, ROUTED, EXECUTED, FAILED }

    struct Intent {
        bytes32      id;
        address      user;
        IntentType   intentType;
        uint256      amount;
        address      token;
        address      recipient;
        RoutingPref  preference;
        IntentStatus status;
        uint256      submittedAt;
        // routing result (written by router)
        uint8        selectedRollupIndex;  // 0=A, 1=B, 2=C
        uint256      estimatedFeeGwei;
        uint256      estimatedLatencyMs;
        uint256      routeScore;           // 0–10000
        bytes32      reasonHash;           // keccak256 of off-chain reason string
        // execution result
        uint256      actualFeeGwei;
        uint256      executedAt;
        uint256      feeSavedGwei;         // vs. most expensive option
    }

    // ─── State ────────────────────────────────────────────────────────────────
    mapping(bytes32 => Intent) public intents;
    bytes32[] public intentIds;

    address public router;
    address public owner;

    uint256 public totalIntents;
    uint256 public totalExecuted;
    uint256 public totalFeeSavedGwei;

    // ─── Events ───────────────────────────────────────────────────────────────
    event IntentSubmitted(
        bytes32 indexed id,
        address indexed user,
        uint8  intentType,
        uint256 amount
    );
    event IntentRouted(
        bytes32 indexed id,
        uint8  selectedRollup,
        uint256 estimatedFeeGwei,
        uint256 estimatedLatencyMs,
        uint256 score
    );
    event IntentExecuted(
        bytes32 indexed id,
        uint256 actualFeeGwei,
        uint256 feeSavedGwei,
        uint256 timestamp
    );
    event IntentFailed(bytes32 indexed id, string reason);

    // ─── Modifier ─────────────────────────────────────────────────────────────
    modifier onlyRouter() {
        require(msg.sender == router || msg.sender == owner, "Not authorised");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _router) {
        router = _router;
        owner  = msg.sender;
    }

    // ─── Intent lifecycle ─────────────────────────────────────────────────────

    function submitIntent(
        address user,
        uint8   intentType,
        uint256 amount,
        address token,
        address recipient,
        uint8   preference
    ) external onlyRouter returns (bytes32 id) {
        require(intentType <= 2, "Invalid type");
        require(preference  <= 2, "Invalid preference");

        id = keccak256(abi.encodePacked(
            user, intentType, amount, token, recipient,
            block.timestamp, totalIntents
        ));

        // Use a storage pointer and assign fields individually.
        // A large struct literal with 17 fields in a single expression pushes
        // too many items onto the EVM stack (limit: 16), causing a compile error.
        Intent storage intent = intents[id];
        intent.id         = id;
        intent.user       = user;
        intent.intentType = IntentType(intentType);
        intent.amount     = amount;
        intent.token      = token;
        intent.recipient  = recipient;
        intent.preference = RoutingPref(preference);
        intent.status     = IntentStatus.PENDING;
        intent.submittedAt= block.timestamp;
        // Routing / execution fields default to zero — written by recordRouting / recordExecution.

        intentIds.push(id);
        totalIntents++;

        emit IntentSubmitted(id, user, intentType, amount);
    }

    function recordRouting(
        bytes32 id,
        uint8   selectedRollup,
        uint256 estimatedFeeGwei,
        uint256 estimatedLatencyMs,
        uint256 score,
        bytes32 reasonHash
    ) external onlyRouter {
        Intent storage intent = intents[id];
        require(intent.status == IntentStatus.PENDING, "Not pending");

        intent.selectedRollupIndex = selectedRollup;
        intent.estimatedFeeGwei    = estimatedFeeGwei;
        intent.estimatedLatencyMs  = estimatedLatencyMs;
        intent.routeScore          = score;
        intent.reasonHash          = reasonHash;
        intent.status              = IntentStatus.ROUTED;

        emit IntentRouted(id, selectedRollup, estimatedFeeGwei, estimatedLatencyMs, score);
    }

    function recordExecution(
        bytes32 id,
        uint256 actualFeeGwei,
        uint256 feeSavedGwei
    ) external onlyRouter {
        Intent storage intent = intents[id];
        require(intent.status == IntentStatus.ROUTED, "Not routed");

        intent.actualFeeGwei  = actualFeeGwei;
        intent.executedAt     = block.timestamp;
        intent.feeSavedGwei   = feeSavedGwei;
        intent.status         = IntentStatus.EXECUTED;

        totalExecuted++;
        totalFeeSavedGwei += feeSavedGwei;

        emit IntentExecuted(id, actualFeeGwei, feeSavedGwei, block.timestamp);
    }

    function recordFailure(bytes32 id, string calldata reason) external onlyRouter {
        intents[id].status = IntentStatus.FAILED;
        emit IntentFailed(id, reason);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function getIntent(bytes32 id) external view returns (Intent memory) {
        return intents[id];
    }

    function getIntentCount() external view returns (uint256) {
        return intentIds.length;
    }

    function getRecentIntentIds(uint256 count) external view returns (bytes32[] memory ids) {
        uint256 len   = intentIds.length;
        uint256 start = len > count ? len - count : 0;
        ids = new bytes32[](len - start);
        for (uint256 i = start; i < len; i++) {
            ids[i - start] = intentIds[i];
        }
    }

    function getGlobalStats() external view returns (
        uint256 total,
        uint256 executed,
        uint256 feeSavedGwei
    ) {
        return (totalIntents, totalExecuted, totalFeeSavedGwei);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setRouter(address newRouter) external {
        require(msg.sender == owner, "Not owner");
        router = newRouter;
    }
}
