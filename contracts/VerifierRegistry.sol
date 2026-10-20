// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVerifierRegistry} from "./interfaces/IVerifierRegistry.sol";
import {ICampaignEscrow} from "./interfaces/ICampaignEscrow.sol";

/// @title VerifierRegistry
/// @notice Open, staked verifier set for the Charity Donation Tracking System.
///         Anyone can stake ETH to join. Each verifier carries a reputation
///         score in [0, 200] that is the weight of their vote in MilestoneVoting.
///         Voting against the final consensus repeatedly is punished: the 3rd
///         consecutive wrong vote slashes 10% of the verifier's stake and sends
///         it to the affected campaign's escrow balance.
///
/// TRUST MODEL:
///   - `stake()` / `unstake()` are permissionless and only ever touch
///     `msg.sender`'s own balances.
///   - The reputation / strike / pending-vote hooks are `onlyMilestoneVoting`.
///   - `milestoneVoting` is wired once by the deployer and then frozen.
///   - This contract makes exactly one outbound call (to `escrow` during a
///     slash) and it is the last thing a slash does (checks-effects-interactions).
contract VerifierRegistry is IVerifierRegistry {
    // ─────────────────────────────────────────────────────────────────────────
    // Config (immutable)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Minimum ETH that must stay staked for a verifier to be eligible.
    uint256 public immutable minStake;

    /// @notice Deployer; may call `setMilestoneVoting` exactly once.
    address public immutable owner;

    /// @notice Escrow that receives slashed stake, credited to a campaign.
    ICampaignEscrow public immutable escrow;

    /// @notice The only address allowed to call the reputation / vote hooks.
    ///         Zero until wired; settable once.
    address public milestoneVoting;

    // ─────────────────────────────────────────────────────────────────────────
    // Verifier state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice True while `account` has at least `minStake` staked. The public
    ///         getter satisfies `IVerifierRegistry.isVerifier`.
    mapping(address => bool) public isVerifier;

    /// @notice Reputation / vote weight in [0, 200]; 0 for non-verifiers. The
    ///         public getter satisfies `IVerifierRegistry.reputationOf`.
    mapping(address => uint256) public reputationOf;

    /// @notice Running sum of `reputationOf` over every active verifier. Kept
    ///         incrementally (see `_setReputation`) so MilestoneVoting can read
    ///         the 66% / 20% denominator without iterating. The public getter
    ///         satisfies `IVerifierRegistry.totalWeight`.
    uint256 public totalWeight;

    /// @notice ETH currently staked per verifier. Survives a slash and remains
    ///         withdrawable even after the verifier drops below `minStake`.
    mapping(address => uint256) public stakedAmount;

    /// @notice Consecutive "voted against final consensus" strikes. Reset to 0
    ///         by any with-consensus vote and immediately after a slash.
    mapping(address => uint256) public againstStrikes;

    /// @notice Votes cast in rounds that have not been finalized yet. While this
    ///         is non-zero the verifier cannot `unstake()`.
    mapping(address => uint256) public pendingVotes;

    // ─────────────────────────────────────────────────────────────────────────
    // Policy constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private constant START_REPUTATION = 100;
    uint256 private constant MAX_REPUTATION = 200;
    uint256 private constant CONSENSUS_REWARD = 5;
    uint256 private constant DISSENT_PENALTY = 10;
    uint256 private constant STRIKES_BEFORE_SLASH = 3;
    uint256 private constant SLASH_BPS = 1_000; // 10% of stake (1_000 / 10_000)

    // ─────────────────────────────────────────────────────────────────────────
    // Reentrancy guard (minimal; equivalent to OpenZeppelin's ReentrancyGuard)
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private _lock = 1; // 1 = unlocked, 2 = locked (non-zero saves gas)

    modifier nonReentrant() {
        require(_lock == 1, "reentrant call");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle events (consensus events live on IVerifierRegistry)
    // ─────────────────────────────────────────────────────────────────────────

    event Staked(address indexed verifier, uint256 added, uint256 totalStaked);
    event Unstaked(address indexed verifier, uint256 amount);
    event VerifierJoined(address indexed verifier);
    event VerifierRemoved(address indexed verifier, string reason);
    event StrikeRecorded(address indexed verifier, uint256 strikes);
    event PendingVotesChanged(address indexed verifier, uint256 pendingVotes);
    event MilestoneVotingSet(address indexed milestoneVoting);
    event SlashRoutedToEscrow(
        address indexed verifier,
        uint256 indexed campaignId,
        uint256 amount
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyMilestoneVoting() {
        require(msg.sender == milestoneVoting, "only MilestoneVoting");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Construction / wiring
    // ─────────────────────────────────────────────────────────────────────────

    /// @param _minStake Minimum stake to be an eligible verifier (must be > 0).
    /// @param _escrow   CampaignEscrow deployment that receives slashed funds.
    constructor(uint256 _minStake, address _escrow) {
        require(_minStake > 0, "minStake = 0");
        require(_escrow != address(0), "escrow = 0");
        minStake = _minStake;
        escrow = ICampaignEscrow(_escrow);
        owner = msg.sender;
    }

    /// @notice Wire the MilestoneVoting contract once, after it is deployed.
    /// @dev One-shot on purpose: the privileged caller can never be repointed.
    function setMilestoneVoting(address _milestoneVoting) external onlyOwner {
        require(milestoneVoting == address(0), "already set");
        require(_milestoneVoting != address(0), "zero address");
        milestoneVoting = _milestoneVoting;
        emit MilestoneVotingSet(_milestoneVoting);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Staking
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Join the verifier pool, or top up an existing stake.
    /// @dev No external calls, so no reentrancy surface and no guard needed.
    ///      A first-time staker must send at least `minStake` in one go.
    ///      A returning member who was slashed out re-joins at `START_REPUTATION`
    ///      (policy choice: a slash wipes accrued reputation).
    function stake() external payable {
        require(msg.value > 0, "no ETH sent");

        uint256 newStake = stakedAmount[msg.sender] + msg.value;
        require(newStake >= minStake, "below minStake");

        stakedAmount[msg.sender] = newStake;

        if (!isVerifier[msg.sender]) {
            isVerifier[msg.sender] = true;                 // membership before reputation
            _setReputation(msg.sender, START_REPUTATION);  // adds weight to totalWeight
            againstStrikes[msg.sender] = 0;
            emit VerifierJoined(msg.sender);
        }

        emit Staked(msg.sender, msg.value, newStake);
    }

    /// @notice Leave the pool and withdraw the full remaining stake.
    /// @dev Blocked while any vote the caller cast is still awaiting
    ///      finalization (`pendingVotes`). Checks-Effects-Interactions plus the
    ///      `nonReentrant` guard: every storage slot is cleared before the ETH
    ///      send, so a re-entrant call fails `require(amount > 0)`.
    function unstake() external nonReentrant {
        uint256 amount = stakedAmount[msg.sender];
        require(amount > 0, "nothing staked");
        require(pendingVotes[msg.sender] == 0, "pending votes");

        // ---- Effects ----
        stakedAmount[msg.sender] = 0;
        if (isVerifier[msg.sender]) {
            _setReputation(msg.sender, 0); // subtracts old weight from totalWeight
            isVerifier[msg.sender] = false;
            againstStrikes[msg.sender] = 0;
            emit VerifierRemoved(msg.sender, "unstaked");
        }
        emit Unstaked(msg.sender, amount);

        // ---- Interaction (last) ----
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MilestoneVoting-only hooks
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IVerifierRegistry
    function applyVoteResult(
        address verifier,
        bool agreedWithConsensus,
        uint256 campaignId
    ) external nonReentrant onlyMilestoneVoting {
        // A verifier slash-dropped by another round finalizing first is no
        // longer in the active set; do not let this round re-accrue reputation
        // for them (a slash wipes accrued reputation — see `stake()`).
        if (!isVerifier[verifier]) return;

        if (agreedWithConsensus) {
            _setReputation(
                verifier,
                _addClamped(reputationOf[verifier], CONSENSUS_REWARD)
            );
            if (againstStrikes[verifier] != 0) {
                againstStrikes[verifier] = 0; // consecutive run broken
                emit StrikeRecorded(verifier, 0);
            }
            return;
        }

        _setReputation(
            verifier,
            _subClamped(reputationOf[verifier], DISSENT_PENALTY)
        );

        uint256 strikes = againstStrikes[verifier] + 1;
        if (strikes >= STRIKES_BEFORE_SLASH) {
            againstStrikes[verifier] = 0; // reset before slashing (effect first)
            emit StrikeRecorded(verifier, 0);
            _slash(verifier, campaignId);
        } else {
            againstStrikes[verifier] = strikes;
            emit StrikeRecorded(verifier, strikes);
        }
    }

    /// @notice General reputation lever for MilestoneVoting / future governance.
    /// @dev `applyVoteResult` is the structured path used by `finalizeRound`;
    ///      this is the manual one (e.g. correcting an off-by-one, a future
    ///      appeals process). Result is clamped to [0, 200].
    function adjustReputation(address verifier, int256 delta)
        external
        onlyMilestoneVoting
    {
        if (!isVerifier[verifier]) return; // non-verifiers hold no reputation
        require(delta != type(int256).min, "delta out of range");
        uint256 current = reputationOf[verifier];
        uint256 updated = delta >= 0
            ? _addClamped(current, uint256(delta))
            : _subClamped(current, uint256(-delta));
        _setReputation(verifier, updated);
    }

    /// @inheritdoc IVerifierRegistry
    function incrementPendingVotes(address verifier)
        external
        onlyMilestoneVoting
    {
        uint256 updated = pendingVotes[verifier] + 1;
        pendingVotes[verifier] = updated;
        emit PendingVotesChanged(verifier, updated);
    }

    /// @inheritdoc IVerifierRegistry
    function decrementPendingVotes(address verifier)
        external
        onlyMilestoneVoting
    {
        uint256 current = pendingVotes[verifier];
        require(current > 0, "no pending votes");
        unchecked {
            current -= 1;
        }
        pendingVotes[verifier] = current;
        emit PendingVotesChanged(verifier, current);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Single choke point for reputation writes. Keeps `totalWeight` in
    ///      lockstep, but only counts weight for addresses that are currently
    ///      active verifiers.
    function _setReputation(address verifier, uint256 newRep) internal {
        uint256 old = reputationOf[verifier];
        if (newRep == old) return;

        reputationOf[verifier] = newRep;
        if (isVerifier[verifier]) {
            totalWeight = totalWeight - old + newRep;
        }
        emit ReputationChanged(verifier, old, newRep);
    }

    /// @dev Slash 10% of current stake, route it to `campaignId`'s escrow
    ///      balance, and drop the verifier from the active set if the slash
    ///      pushes them under `minStake`. CEI: stake is reduced before the
    ///      external escrow call, which is the last statement.
    function _slash(address verifier, uint256 campaignId) internal {
        uint256 amount = (stakedAmount[verifier] * SLASH_BPS) / 10_000;
        if (amount == 0) {
            emit Slashed(verifier, 0);
            return;
        }

        // ---- Effects ----
        stakedAmount[verifier] -= amount;
        if (isVerifier[verifier] && stakedAmount[verifier] < minStake) {
            _setReputation(verifier, 0);
            isVerifier[verifier] = false;
            emit VerifierRemoved(verifier, "slashed below minStake");
        }
        emit Slashed(verifier, amount);
        emit SlashRoutedToEscrow(verifier, campaignId, amount);

        // ---- Interaction (last) ----
        escrow.creditSlashed{value: amount}(campaignId);
    }

    function _addClamped(uint256 x, uint256 d) internal pure returns (uint256) {
        uint256 r = x + d;
        return r > MAX_REPUTATION ? MAX_REPUTATION : r;
    }

    function _subClamped(uint256 x, uint256 d) internal pure returns (uint256) {
        return x > d ? x - d : 0;
    }
}
