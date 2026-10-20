// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMilestoneVoting} from "./interfaces/IMilestoneVoting.sol";
import {IVerifierRegistry} from "./interfaces/IVerifierRegistry.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {ICampaignEscrow} from "./interfaces/ICampaignEscrow.sol";

/// @title MilestoneVoting
/// @notice Reputation-weighted approval of campaign milestones. This is the only
///         contract that talks to all three others, and every arrow points
///         outward from it:
///
///           proofs   : gate — a round cannot open with no IPFS proof on file
///           escrow   : read milestone state; push startTimelock / raiseDispute
///           verifiers: read weight; push applyVoteResult + the unstake lock
///
/// FLOW
///   openVotingRound  proof exists AND escrow milestone == Pending AND
///                    totalWeight > 0  ->  snapshot totalWeight, open a round
///   castVote         staked verifiers only, one vote each; weight =
///                    reputationOf(voter); incrementPendingVotes(voter)
///   finalizeRound    approved  <=>  approveWeight*100 >= snapshot*66
///                    approved -> escrow.startTimelock()
///                    then per voter: applyVoteResult(voter, aligned, campaignId)
///                                    -> decrementPendingVotes(voter)
///   raiseDispute     during escrow timelock; disputeWeight*100 >= snapshot*20
///                    -> escrow.raiseDispute() once
///
/// SCOPE NOTES
///   - Thresholds use the weight snapshot taken at open, so post-open staking /
///     reputation drift cannot move the 66% or 20% bar.
///   - Dispute raisers are NOT put through applyVoteResult and do NOT take the
///     unstake lock: the dispute is a fund-safety brake, not a reputation event.
///   - finalizeRound loops all voters with 2 external calls each; a very large
///     turnout could exceed the block gas limit. A production build would
///     paginate this or move reputation settlement to a pull model.
contract MilestoneVoting is IMilestoneVoting {
    // ─────────────────────────────────────────────────────────────────────────
    // Dependencies (wired once at construction)
    // ─────────────────────────────────────────────────────────────────────────

    IVerifierRegistry public immutable verifiers;
    IProofRegistry public immutable proofs;
    ICampaignEscrow public immutable escrow;

    // ─────────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant APPROVAL_PERCENT = 66; // of snapshot weight
    uint256 public constant DISPUTE_PERCENT = 20; // of snapshot weight

    // ─────────────────────────────────────────────────────────────────────────
    // Round model
    // ─────────────────────────────────────────────────────────────────────────

    enum RoundStatus {
        None, // 0 — no round at this index
        Open, // 1 — accepting votes
        Finalized // 2 — tallied; reputation settled
    }

    struct Round {
        RoundStatus status;
        bool approved; // meaningful once Finalized
        bool disputeForwarded; // escrow.raiseDispute() already sent
        uint64 openedAt;
        uint64 deadline; // openedAt + VOTING_PERIOD
        uint256 weightSnapshot; // verifiers.totalWeight() at open
        string proofCID; // ProofRegistry CID pinned at open; never re-read live
        uint256 approveWeight;
        uint256 rejectWeight;
        uint256 disputeWeight;
        address[] voters;
        mapping(address => bool) hasVoted;
        mapping(address => bool) votedApprove;
        mapping(address => bool) hasDisputed;
    }

    /// @notice Current round index per milestone; 0 means no round opened yet.
    ///         Key = keccak256(abi.encode(campaignId, milestoneId)).
    mapping(bytes32 => uint256) public roundIndexOf;

    /// @dev Round storage. Key = keccak256(abi.encode(campaignId, milestoneId, index)).
    ///      A fresh key per index means a re-opened round starts with clean
    ///      hasVoted / votedApprove / hasDisputed maps (which `delete` would not
    ///      clear inside a struct).
    mapping(bytes32 => Round) private rounds;

    // ─────────────────────────────────────────────────────────────────────────
    // Reentrancy guard
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "reentrant call");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events (RoundOpened / VoteCast / RoundFinalized / DisputeThresholdReached
    // are declared on IMilestoneVoting)
    // ─────────────────────────────────────────────────────────────────────────

    event DisputeJoined(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        address indexed verifier,
        uint256 weight,
        uint256 cumulativeDisputeWeight
    );
    event VoterSettled(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        address indexed verifier,
        bool alignedWithOutcome
    );

    constructor(address verifiers_, address proofs_, address escrow_) {
        require(
            verifiers_ != address(0) &&
                proofs_ != address(0) &&
                escrow_ != address(0),
            "zero address"
        );
        verifiers = IVerifierRegistry(verifiers_);
        proofs = IProofRegistry(proofs_);
        escrow = ICampaignEscrow(escrow_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Open a round
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMilestoneVoting
    function openVotingRound(uint256 campaignId, uint256 milestoneId) external {
        require(proofs.hasProof(campaignId, milestoneId), "no proof submitted");

        // getMilestone() reverts if the (campaignId, milestoneId) pair does not
        // exist, so this call doubles as the existence check.
        (, uint256 amount, ICampaignEscrow.State state, ) = escrow.getMilestone(
            campaignId,
            milestoneId
        );
        require(state == ICampaignEscrow.State.Pending, "milestone not pending");

        // Pre-flight funding check: don't open a round for a milestone the
        // campaign cannot pay. startTimelock() re-checks at finalize time, since
        // `reserved` can rise while this round is open.
        require(
            escrow.availableBalance(campaignId) >= amount,
            "campaign underfunded"
        );

        bytes32 mk = _mkey(campaignId, milestoneId);
        uint256 idx = roundIndexOf[mk];
        if (idx != 0) {
            // A prior round exists: it must be closed. (It can only be a rejected
            // round — an approved one would have moved the milestone out of
            // Pending and failed the check above.)
            require(
                rounds[_rkey(campaignId, milestoneId, idx)].status ==
                    RoundStatus.Finalized,
                "round already open"
            );
        }

        uint256 snapshot = verifiers.totalWeight();
        require(snapshot > 0, "no verifier weight");

        idx += 1;
        roundIndexOf[mk] = idx;

        // Pin the proof CID as it stands right now. Everything downstream
        // (finalize, dispute, front ends) reads r.proofCID, never ProofRegistry
        // live, so a later resubmission cannot change what this round covers.
        string memory pinnedCID = proofs.getProofCID(campaignId, milestoneId);

        Round storage r = rounds[_rkey(campaignId, milestoneId, idx)];
        r.status = RoundStatus.Open;
        r.openedAt = uint64(block.timestamp);
        r.deadline = uint64(block.timestamp + VOTING_PERIOD);
        r.weightSnapshot = snapshot;
        r.proofCID = pinnedCID;

        emit RoundOpened(campaignId, milestoneId, pinnedCID, snapshot);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cast a vote
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMilestoneVoting
    function castVote(
        uint256 campaignId,
        uint256 milestoneId,
        bool approve
    ) external nonReentrant {
        Round storage r = _currentRound(campaignId, milestoneId);
        require(r.status == RoundStatus.Open, "round not open");
        require(block.timestamp < r.deadline, "voting closed");
        require(verifiers.isVerifier(msg.sender), "not a verifier");
        require(!r.hasVoted[msg.sender], "already voted");

        uint256 weight = verifiers.reputationOf(msg.sender);

        // ---- Effects ----
        r.hasVoted[msg.sender] = true;
        r.votedApprove[msg.sender] = approve;
        r.voters.push(msg.sender);
        if (approve) {
            r.approveWeight += weight;
        } else {
            r.rejectWeight += weight;
        }

        // ---- Interaction: lock this verifier's stake until finalizeRound ----
        verifiers.incrementPendingVotes(msg.sender);

        emit VoteCast(campaignId, milestoneId, msg.sender, approve, weight);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Finalize
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMilestoneVoting
    /// @dev Callable by anyone once approval is decisive OR the deadline passes.
    ///      If escrow.startTimelock() reverts (e.g. campaign underfunded) the
    ///      whole call reverts and the round stays Open — fund the campaign and
    ///      call again.
    function finalizeRound(uint256 campaignId, uint256 milestoneId)
        external
        nonReentrant
    {
        Round storage r = _currentRound(campaignId, milestoneId);
        require(r.status == RoundStatus.Open, "round not open");

        bool approved = _approvalReached(r);
        require(
            approved || block.timestamp >= r.deadline,
            "round still active"
        );

        // ---- Effects ----
        r.status = RoundStatus.Finalized;
        r.approved = approved;
        emit RoundFinalized(campaignId, milestoneId, approved);

        // ---- Interaction 1: open the escrow timelock on approval ----
        if (approved) {
            escrow.startTimelock(campaignId, milestoneId);
        }

        // ---- Interaction 2: settle each voter, then release their stake lock ----
        uint256 n = r.voters.length;
        for (uint256 i = 0; i < n; i++) {
            address v = r.voters[i];
            bool aligned = (r.votedApprove[v] == approved);
            verifiers.applyVoteResult(v, aligned, campaignId);
            verifiers.decrementPendingVotes(v);
            emit VoterSettled(campaignId, milestoneId, v, aligned);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dispute (during the escrow timelock window)
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMilestoneVoting
    function raiseDispute(uint256 campaignId, uint256 milestoneId)
        external
        nonReentrant
    {
        Round storage r = _currentRound(campaignId, milestoneId);
        require(
            r.status == RoundStatus.Finalized && r.approved,
            "no approved round"
        );
        require(!r.disputeForwarded, "dispute already forwarded");
        require(verifiers.isVerifier(msg.sender), "not a verifier");
        require(!r.hasDisputed[msg.sender], "already disputed");

        (, , ICampaignEscrow.State state, uint64 releaseAfter) = escrow
            .getMilestone(campaignId, milestoneId);
        require(state == ICampaignEscrow.State.Timelocked, "not in timelock");
        require(block.timestamp < releaseAfter, "timelock window closed");

        uint256 weight = verifiers.reputationOf(msg.sender);

        // ---- Effects ----
        r.hasDisputed[msg.sender] = true;
        r.disputeWeight += weight;
        emit DisputeJoined(
            campaignId,
            milestoneId,
            msg.sender,
            weight,
            r.disputeWeight
        );

        // ---- Threshold check + single forward ----
        if (r.disputeWeight * 100 >= r.weightSnapshot * DISPUTE_PERCENT) {
            r.disputeForwarded = true;
            emit DisputeThresholdReached(campaignId, milestoneId);
            escrow.raiseDispute(campaignId, milestoneId);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function currentRoundIndex(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (uint256)
    {
        return roundIndexOf[_mkey(campaignId, milestoneId)];
    }

    /// @notice Whether the current round's tally already clears the 66% bar.
    function approvalReached(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (bool)
    {
        return _approvalReached(_currentRound(campaignId, milestoneId));
    }

    function getRound(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (
            RoundStatus status,
            bool approved,
            bool disputeForwarded,
            uint64 openedAt,
            uint64 deadline,
            uint256 weightSnapshot,
            string memory proofCID,
            uint256 approveWeight,
            uint256 rejectWeight,
            uint256 disputeWeight,
            uint256 voterCount
        )
    {
        Round storage r = _currentRound(campaignId, milestoneId);
        return (
            r.status,
            r.approved,
            r.disputeForwarded,
            r.openedAt,
            r.deadline,
            r.weightSnapshot,
            r.proofCID,
            r.approveWeight,
            r.rejectWeight,
            r.disputeWeight,
            r.voters.length
        );
    }

    function voteOf(
        uint256 campaignId,
        uint256 milestoneId,
        address account
    ) external view returns (bool voted, bool approve) {
        Round storage r = _currentRound(campaignId, milestoneId);
        return (r.hasVoted[account], r.votedApprove[account]);
    }

    function hasDisputed(
        uint256 campaignId,
        uint256 milestoneId,
        address account
    ) external view returns (bool) {
        return _currentRound(campaignId, milestoneId).hasDisputed[account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _currentRound(uint256 campaignId, uint256 milestoneId)
        internal
        view
        returns (Round storage r)
    {
        uint256 idx = roundIndexOf[_mkey(campaignId, milestoneId)];
        require(idx != 0, "no round");
        r = rounds[_rkey(campaignId, milestoneId, idx)];
    }

    function _approvalReached(Round storage r) internal view returns (bool) {
        return r.approveWeight * 100 >= r.weightSnapshot * APPROVAL_PERCENT;
    }

    function _mkey(uint256 campaignId, uint256 milestoneId)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(campaignId, milestoneId));
    }

    function _rkey(
        uint256 campaignId,
        uint256 milestoneId,
        uint256 index
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(campaignId, milestoneId, index));
    }
}
