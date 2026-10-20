// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICampaignEscrow
/// @notice The slice of CampaignEscrow that other contracts / keepers call.
///
///         Consumers:
///           - MilestoneVoting  -> startTimelock(), raiseDispute(),
///                                 milestoneCount(), getMilestone()
///           - ProofRegistry    -> beneficiaryOf()   (to check who may submit a proof)
///           - Chainlink keeper / any EOA -> release()
///
/// DESIGN: "Push" model. The escrow never calls back into MilestoneVoting to ask
///         "was this approved?". Instead MilestoneVoting pushes state changes in
///         (startTimelock / raiseDispute), the escrow records them, and release()
///         only ever reads its own storage plus block.timestamp. This keeps the
///         money contract simple and self-contained: it has no external
///         dependency it must trust at release time except the one privileged
///         caller (MilestoneVoting) that it was wired to at deployment.
interface ICampaignEscrow {
    /// @notice Lifecycle state of a single milestone. Declared here (not just on
    ///         the concrete contract) so MilestoneVoting can depend on this
    ///         interface instead of importing CampaignEscrow.
    ///
    ///   Pending    (0) — created; awaiting a passed vote
    ///   Timelocked (1) — approved; 48h release window running
    ///   Released   (2) — paid out (terminal)
    ///   Disputed   (3) — objection raised in-window; frozen for owner review
    ///   Rejected   (4) — owner killed the milestone; funds freed (terminal)
    enum State {
        Pending,
        Timelocked,
        Released,
        Disputed,
        Rejected
    }

    event TimelockStarted(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        uint256 releaseAfter
    );
    event DisputeRaised(uint256 indexed campaignId, uint256 indexed milestoneId);
    event SlashedFundsReceived(
        uint256 indexed campaignId,
        address indexed from,
        uint256 amount
    );
    event MilestoneReleased(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        address indexed beneficiary,
        uint256 amount
    );

    /// @notice Begin the 48-hour release window for an approved milestone.
    /// @dev MUST be callable only by the wired MilestoneVoting contract.
    ///      Called from MilestoneVoting.finalizeRound() once weighted approval
    ///      reaches 66% of total verifier weight.
    function startTimelock(uint256 campaignId, uint256 milestoneId) external;

    /// @notice Flag a milestone as disputed, which permanently blocks release()
    ///         until the dispute is resolved by whatever governance path you add later.
    /// @dev MUST be callable only by the wired MilestoneVoting contract. Called
    ///      from MilestoneVoting.raiseDispute() once dissent reaches 20% of total
    ///      verifier weight, and only while the timelock window is still open.
    function raiseDispute(uint256 campaignId, uint256 milestoneId) external;

    /// @notice Pay the milestone amount to the campaign beneficiary.
    /// @dev Permissionless. Reverts unless: timelock was started, the 48h window
    ///      has elapsed, no dispute is flagged, and the milestone is not already
    ///      released. Meant to be called by anyone, or by a Chainlink Automation
    ///      keeper on a schedule.
    function release(uint256 campaignId, uint256 milestoneId) external;

    /// @notice Address entitled to receive this campaign's milestone payouts.
    /// @dev ProofRegistry reads this so only the beneficiary can attach a proof.
    function beneficiaryOf(uint256 campaignId) external view returns (address);

    /// @notice Receive slashed verifier stake and add it to `campaignId`'s pool.
    /// @dev Called by VerifierRegistry when a verifier hits their 3rd consecutive
    ///      against-consensus strike. `msg.value` is the slashed amount. The
    ///      slashed ETH returns to the donors' campaign rather than being burned
    ///      or paid to the reporter, so bad verification refunds the cause.
    function creditSlashed(uint256 campaignId) external payable;

    /// @notice Number of milestones fixed for `campaignId` at creation time.
    /// @dev MilestoneVoting uses this to bound `milestoneId` before opening a round.
    function milestoneCount(uint256 campaignId) external view returns (uint256);

    /// @notice Campaign funds not yet committed to a Timelocked/Disputed
    ///         milestone, i.e. `balance - reserved`.
    /// @dev MilestoneVoting checks this against a milestone's `amount` before
    ///      opening a round, so a milestone the campaign cannot fund never
    ///      reaches a vote. This is a pre-flight check only — `startTimelock()`
    ///      re-checks at finalize time, since `reserved` can rise in between as
    ///      other milestones of the same campaign enter their timelock.
    function availableBalance(uint256 campaignId) external view returns (uint256);

    /// @notice Full detail of one milestone.
    /// @dev MilestoneVoting reads `state` (must be Pending before a round may
    ///      open) and `amount` (for its event trail). `releaseAfter` is only
    ///      meaningful once the milestone is Timelocked.
    function getMilestone(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (
            string memory description,
            uint256 amount,
            State state,
            uint64 releaseAfter
        );
}
