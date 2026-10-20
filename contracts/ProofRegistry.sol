// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {ICampaignEscrow} from "./interfaces/ICampaignEscrow.sol";

/// @title ProofRegistry
/// @notice One IPFS CID per (campaignId, milestoneId): the evidence a beneficiary
///         publishes for a milestone. MilestoneVoting refuses to open a voting
///         round until `hasProof()` is true. This contract stores a *pointer*
///         only — it never fetches, hashes, or validates the referenced content.
///
/// RESUBMISSION POLICY
///   The beneficiary may submit or replace the CID while the escrow milestone is
///   still `State.Pending`. Once a round approves the milestone (escrow moves it
///   to Timelocked/Disputed/Released) or the owner Rejects it, the CID is frozen
///   as the historical record.
///
///   This keeps the recovery path alive: a rejected round leaves the milestone
///   Pending, so the beneficiary can attach updated evidence before a re-opened
///   round — without letting anyone rewrite the proof of a milestone that has
///   already moved on.
///
///   Residual gap: `Pending` does not distinguish "no round yet" from "round
///   mid-vote" (an open round does not change escrow state), so the CID can still
///   be swapped while verifiers are voting. Closing that belongs in
///   MilestoneVoting (pin the CID into the Round at open, re-check at finalize).
contract ProofRegistry is IProofRegistry {
    /// @notice Escrow used to resolve each campaign's beneficiary and each
    ///         milestone's state. Set once at construction.
    ICampaignEscrow public immutable escrow;

    struct Proof {
        string cid; // IPFS content identifier (pointer only)
        address submitter; // who wrote the current CID (always the beneficiary)
        uint64 timestamp; // block time of the current submission
        uint32 version; // submission count; 0 == never submitted
    }

    /// @dev key = keccak256(abi.encode(campaignId, milestoneId))
    mapping(bytes32 => Proof) private _proofs;

    constructor(address escrow_) {
        require(escrow_ != address(0), "zero address");
        escrow = ICampaignEscrow(escrow_);
    }

    /// @notice Publish or replace the proof CID for a milestone.
    /// @dev Only the campaign beneficiary, only while the milestone is Pending.
    ///      `escrow.beneficiaryOf` reverts for an unknown campaign and
    ///      `escrow.getMilestone` reverts for an unknown milestone, so the two
    ///      calls double as existence checks.
    function submitProof(
        uint256 campaignId,
        uint256 milestoneId,
        string calldata cid
    ) external {
        require(bytes(cid).length > 0, "empty cid");
        require(
            msg.sender == escrow.beneficiaryOf(campaignId),
            "not beneficiary"
        );

        (, , ICampaignEscrow.State state, ) = escrow.getMilestone(
            campaignId,
            milestoneId
        );
        require(state == ICampaignEscrow.State.Pending, "milestone not pending");

        Proof storage p = _proofs[_key(campaignId, milestoneId)];
        p.cid = cid;
        p.submitter = msg.sender;
        p.timestamp = uint64(block.timestamp);
        p.version += 1;

        emit ProofSubmitted(campaignId, milestoneId, cid, msg.sender);
    }

    /// @inheritdoc IProofRegistry
    function hasProof(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (bool)
    {
        return _proofs[_key(campaignId, milestoneId)].version != 0;
    }

    /// @inheritdoc IProofRegistry
    function getProofCID(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (string memory)
    {
        return _proofs[_key(campaignId, milestoneId)].cid;
    }

    /// @notice Full proof record: CID, submitter, submission time, submission count.
    function getProof(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (
            string memory cid,
            address submitter,
            uint64 timestamp,
            uint32 version
        )
    {
        Proof storage p = _proofs[_key(campaignId, milestoneId)];
        return (p.cid, p.submitter, p.timestamp, p.version);
    }

    function _key(uint256 campaignId, uint256 milestoneId)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(campaignId, milestoneId));
    }
}
