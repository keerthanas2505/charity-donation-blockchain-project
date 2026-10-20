// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IProofRegistry
/// @notice The slice of ProofRegistry that other contracts call.
///         Only MilestoneVoting consumes this: a voting round for a milestone
///         must not open until the beneficiary has published an IPFS proof for
///         that milestone.
///
/// DESIGN: The registry stores the CID (content identifier) string, not the file.
///         On-chain we only ever need "does a proof exist?" plus "what is the CID
///         so we can show/emit it?". Everything else about the proof lives on IPFS.
interface IProofRegistry {
    /// @notice Emitted when a beneficiary submits (or replaces) a milestone proof.
    event ProofSubmitted(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        string cid,
        address indexed submittedBy
    );

    /// @notice True once a non-empty proof CID has been recorded for the milestone.
    /// @dev MilestoneVoting.openVotingRound() reverts unless this returns true.
    function hasProof(uint256 campaignId, uint256 milestoneId) external view returns (bool);

    /// @notice The IPFS CID recorded for the milestone (empty string if none).
    /// @dev Returned so MilestoneVoting can bind a round to the exact CID that was
    ///      under review and emit it in its "round opened" event.
    function getProofCID(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (string memory);
}
