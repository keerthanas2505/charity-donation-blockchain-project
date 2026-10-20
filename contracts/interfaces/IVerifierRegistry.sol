// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVerifierRegistry
/// @notice The slice of VerifierRegistry that other contracts are allowed to call.
///         Only MilestoneVoting consumes this today: it needs to know who is a
///         verifier, how much each vote weighs, the total weight in the system,
///         and it needs to push the outcome of a finished round back so the
///         registry can move reputation and (eventually) slash stake.
///
/// DESIGN: An interface is a *contract-to-contract API boundary*. We put only
///         the four functions MilestoneVoting actually calls here — not the
///         `stake()` / `withdraw()` functions, because no other contract calls
///         those (users call them directly). Keeping interfaces minimal means
///         a caller can't accidentally depend on internals, and the compiler
///         forces the real contract to implement exactly this shape.
interface IVerifierRegistry {
    /// @notice Emitted when reputation changes so off-chain indexers can follow it.
    event ReputationChanged(address indexed verifier, uint256 oldRep, uint256 newRep);

    /// @notice Emitted when a verifier crosses the 3-strike line and loses 10% of stake.
    event Slashed(address indexed verifier, uint256 amount);

    /// @notice True if `account` currently has an active stake and is allowed to vote.
    /// @dev MilestoneVoting calls this to reject votes from non-verifiers.
    function isVerifier(address account) external view returns (bool);

    /// @notice Current reputation of `account`, in the range [0, 200].
    /// @dev This is the weight of that verifier's vote. Returns 0 for non-verifiers.
    function reputationOf(address account) external view returns (uint256);

    /// @notice Sum of `reputationOf` across every active verifier.
    /// @dev MilestoneVoting uses this as the denominator for the 66% approval
    ///      threshold and the 20% dispute threshold.
    ///
    /// DESIGN: Thresholds are measured against the *whole verifier set*, not just
    ///         the verifiers who showed up. That makes non-participation behave
    ///         like a soft "no". A production build would likely snapshot this
    ///         value when a round opens so mid-round staking can't move the goal
    ///         posts — noted here as a future change.
    function totalWeight() external view returns (uint256);

    /// @notice Report how one verifier voted relative to the final consensus of a
    ///         finished round. The registry owns the reward/penalty/slash policy:
    ///         +5 if `agreedWithConsensus`, -10 otherwise (both clamped to [0,200]);
    ///         a wrong vote also adds a strike, and the 3rd *consecutive* wrong
    ///         vote slashes 10% of that verifier's stake. Any correct vote resets
    ///         the strike counter to 0.
    /// @param campaignId The campaign whose milestone was under review. Slashed
    ///        ETH is routed to this campaign's balance via
    ///        `ICampaignEscrow.creditSlashed`.
    /// @dev MilestoneVoting calls this once per voter inside `finalizeRound`.
    ///
    /// DESIGN: One function instead of separate `reward()` / `penalize()` / `slash()`
    ///         calls. The voting contract shouldn't know or care about the numbers
    ///         5, 10, 200, or the strike count — that policy lives entirely in the
    ///         registry, next to the stake it guards. Fewer external calls also
    ///         means less gas and fewer partial-failure states. `campaignId` is
    ///         threaded through only so a slash can be attributed to the campaign
    ///         whose vote triggered it.
    function applyVoteResult(
        address verifier,
        bool agreedWithConsensus,
        uint256 campaignId
    ) external;

    /// @notice Mark that `verifier` has an unresolved vote in an open round.
    /// @dev Called by MilestoneVoting from `castVote`. While the resulting count
    ///      is non-zero the verifier cannot `unstake()` — otherwise they could
    ///      vote and pull their stake out before the round (and any slash) lands.
    function incrementPendingVotes(address verifier) external;

    /// @notice Clear one unresolved vote for `verifier`.
    /// @dev Called by MilestoneVoting from `finalizeRound`, once per voter, after
    ///      the matching `applyVoteResult`.
    function decrementPendingVotes(address verifier) external;
}
