// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMilestoneVoting
/// @notice The externally-triggered entrypoints of MilestoneVoting.
///
/// NOTE: No sibling contract in this system calls MilestoneVoting — the arrows
///       all point *outward* from it (to VerifierRegistry, ProofRegistry,
///       CampaignEscrow). This interface therefore exists for verifier EOAs,
///       front ends, tests, a future automation keeper, and any governance
///       module you bolt on later. It documents the public surface; it is not a
///       contract-to-contract dependency the way the other three interfaces are.
interface IMilestoneVoting {
    event RoundOpened(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        string proofCID,
        uint256 totalWeightSnapshot
    );
    event VoteCast(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        address indexed verifier,
        bool approve,
        uint256 weight
    );
    event RoundFinalized(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        bool approved
    );
    event DisputeThresholdReached(uint256 indexed campaignId, uint256 indexed milestoneId);

    /// @notice Open the voting round for a milestone. Reverts unless
    ///         ProofRegistry.hasProof(campaignId, milestoneId) is true.
    function openVotingRound(uint256 campaignId, uint256 milestoneId) external;

    /// @notice Cast a reputation-weighted approve/reject vote. Reverts for
    ///         non-verifiers and for double votes.
    function castVote(uint256 campaignId, uint256 milestoneId, bool approve) external;

    /// @notice Close the round, tally weighted votes, push reward/penalty results
    ///         to VerifierRegistry, and — if approval >= 66% of total weight —
    ///         call CampaignEscrow.startTimelock().
    function finalizeRound(uint256 campaignId, uint256 milestoneId) external;

    /// @notice Register a verifier's objection during the 48h timelock window.
    ///         Once objections reach 20% of total verifier weight, this calls
    ///         CampaignEscrow.raiseDispute() and release is blocked.
    function raiseDispute(uint256 campaignId, uint256 milestoneId) external;
}
