// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICampaignEscrow} from "./interfaces/ICampaignEscrow.sol";
import {IAutomationCompatible} from "./interfaces/IAutomationCompatible.sol";

/// @title CampaignEscrow
/// @notice Holds donated ETH per campaign, split into creator-defined milestones,
///         and releases each milestone only after MilestoneVoting has approved it
///         (>= 66% weighted verifier reputation) and a 48-hour dispute window has
///         elapsed unchallenged. Disputes freeze a milestone until the owner
///         resolves it manually (no on-chain appeals DAO in this version).
///
/// MILESTONE STATE MACHINE:
///
///   Pending ──startTimelock()──► Timelocked ──release() / performUpkeep()──► Released
///   (created)  onlyMilestoneVoting  (48h clock)  now >= releaseAfter          (terminal)
///
///   release() is a manual call; performUpkeep() is the Chainlink Automation
///   path (checkUpkeep off-chain finds ready milestones, performUpkeep releases
///   them on-chain). Both gate on the same `_isReleasable` predicate.
///                                        │
///                                        ├─raiseDispute()──► Disputed ─resolveDispute(true)─► Released
///                                        │ onlyMilestoneVoting          onlyOwner
///                                        │ now < releaseAfter           └resolveDispute(false)─► Rejected
///                                        │                                                      (terminal)
///
///   "Approved" from the design doc is folded into the Pending -> Timelocked edge:
///   MilestoneVoting only calls startTimelock() once approval is reached, so
///   approval and clock-start are one atomic step. A standalone Approved state
///   would behave identically to Timelocked, so it is not persisted.
///
/// FUND ACCOUNTING:
///   campaign.balance  = donations + slashed stake - released payouts
///   campaign.reserved = sum of amounts for milestones in Timelocked / Disputed
///   Invariant: reserved <= balance   (so `balance - reserved` never underflows)
///
/// DEPLOYMENT / WIRING ORDER (addresses are circular, so escrow goes first):
///   1. escrow    = new CampaignEscrow()
///   2. registry  = new VerifierRegistry(minStake, escrow)
///   3. proofs    = new ProofRegistry(escrow)
///   4. voting    = new MilestoneVoting(registry, proofs, escrow)
///   5. escrow.setMilestoneVoting(voting)
///   6. escrow.setVerifierRegistry(registry)
///   7. registry.setMilestoneVoting(voting)
///   Until steps 5-7 run the system is not live: e.g. a slash routed to
///   escrow.creditSlashed() reverts while `verifierRegistry` is unset.
contract CampaignEscrow is ICampaignEscrow, IAutomationCompatible {
    // ─────────────────────────────────────────────────────────────────────────
    // Roles / wiring
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deployer; resolves disputes and performs one-shot wiring.
    address public immutable owner;

    /// @notice Only address allowed to call startTimelock() / raiseDispute().
    ///         Zero until wired; settable once.
    address public milestoneVoting;

    /// @notice Only address allowed to call creditSlashed(). Zero until wired;
    ///         settable once. (Phase 2 TODO #1.)
    address public verifierRegistry;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant TIMELOCK = 48 hours;
    uint256 private constant MAX_MILESTONES = 50;

    /// @notice Hard cap on how many milestones a single `performUpkeep` call
    ///         releases. Bounds on-chain gas the same way MilestoneVoting caps
    ///         its per-round voter loop. `checkUpkeep` never returns more pairs
    ///         than this.
    uint256 public constant MAX_UPKEEP_BATCH = 20;

    /// @notice Default number of campaigns `checkUpkeep` scans when it is given
    ///         empty `checkData`, and the ceiling on a `checkData`-supplied
    ///         window. Keeps the off-chain simulation bounded; sharded upkeeps
    ///         (one per slice, via `checkData`) cover a larger campaign set.
    uint256 public constant MAX_CAMPAIGN_SCAN = 100;

    // ─────────────────────────────────────────────────────────────────────────
    // Data model
    // ─────────────────────────────────────────────────────────────────────────

    // `State` (Pending / Timelocked / Released / Disputed / Rejected) is declared
    // on ICampaignEscrow and inherited here, so MilestoneVoting can depend on the
    // interface rather than this concrete contract.

    struct Milestone {
        string description;
        uint256 amount; // target payout for this milestone
        State state;
        uint64 releaseAfter; // unix time; meaningful once Timelocked
    }

    struct Campaign {
        address creator;
        address beneficiary;
        uint256 balance; // ETH held for this campaign
        uint256 reserved; // part of balance committed to Timelocked/Disputed milestones
        Milestone[] milestones;
    }

    Campaign[] private campaigns;

    /// @notice Slashed ETH credited for a campaignId that does not exist. Parked
    ///         here rather than reverting, so a slash can never brick
    ///         MilestoneVoting.finalizeRound(). Recoverable via sweepUnallocated().
    ///         (Phase 2 TODO #2.)
    uint256 public unallocatedSlashed;

    // ─────────────────────────────────────────────────────────────────────────
    // Reentrancy guard (minimal; equivalent to OpenZeppelin's ReentrancyGuard)
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private _lock = 1; // 1 = unlocked, 2 = locked

    modifier nonReentrant() {
        require(_lock == 1, "reentrant call");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events (TimelockStarted / DisputeRaised / SlashedFundsReceived /
    // MilestoneReleased are declared on ICampaignEscrow)
    // ─────────────────────────────────────────────────────────────────────────

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed beneficiary,
        uint256 milestoneCount
    );
    event Donated(
        uint256 indexed campaignId,
        address indexed donor,
        uint256 amount,
        uint256 newBalance
    );
    event DisputeResolved(
        uint256 indexed campaignId,
        uint256 indexed milestoneId,
        bool upheld
    );
    event MilestoneVotingSet(address indexed milestoneVoting);
    event VerifierRegistrySet(address indexed verifierRegistry);
    event UnallocatedSwept(address indexed to, uint256 amount);
    event UpkeepPerformed(address indexed caller, uint256 releasedCount);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyMilestoneVoting() {
        require(msg.sender == milestoneVoting, "only MilestoneVoting");
        _;
    }

    modifier onlyVerifierRegistry() {
        require(msg.sender == verifierRegistry, "only VerifierRegistry");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // One-shot wiring (see DEPLOYMENT / WIRING ORDER above)
    // ─────────────────────────────────────────────────────────────────────────

    function setMilestoneVoting(address _milestoneVoting) external onlyOwner {
        require(milestoneVoting == address(0), "already set");
        require(_milestoneVoting != address(0), "zero address");
        milestoneVoting = _milestoneVoting;
        emit MilestoneVotingSet(_milestoneVoting);
    }

    function setVerifierRegistry(address _verifierRegistry) external onlyOwner {
        require(verifierRegistry == address(0), "already set");
        require(_verifierRegistry != address(0), "zero address");
        verifierRegistry = _verifierRegistry;
        emit VerifierRegistrySet(_verifierRegistry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Campaign lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create a campaign with its milestones fixed upfront.
    /// @param beneficiary  Address that receives every milestone payout.
    /// @param descriptions Human-readable milestone descriptions.
    /// @param amounts      Target ETH payout per milestone (each > 0).
    /// @return campaignId  Index of the new campaign.
    function createCampaign(
        address beneficiary,
        string[] calldata descriptions,
        uint256[] calldata amounts
    ) external returns (uint256 campaignId) {
        require(beneficiary != address(0), "zero beneficiary");
        require(descriptions.length == amounts.length, "length mismatch");
        require(descriptions.length > 0, "no milestones");
        require(descriptions.length <= MAX_MILESTONES, "too many milestones");

        campaignId = campaigns.length;
        Campaign storage c = campaigns.push();
        c.creator = msg.sender;
        c.beneficiary = beneficiary;

        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "zero amount");
            c.milestones.push(
                Milestone({
                    description: descriptions[i],
                    amount: amounts[i],
                    state: State.Pending,
                    releaseAfter: 0
                })
            );
        }

        emit CampaignCreated(campaignId, msg.sender, beneficiary, amounts.length);
    }

    /// @notice Donate ETH to a campaign. Allowed at any time; funds join the
    ///         campaign's balance and back its milestones.
    function donate(uint256 campaignId) external payable {
        require(campaignId < campaigns.length, "no campaign");
        require(msg.value > 0, "no ETH sent");

        Campaign storage c = campaigns[campaignId];
        c.balance += msg.value;

        emit Donated(campaignId, msg.sender, msg.value, c.balance);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MilestoneVoting-driven transitions
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICampaignEscrow
    function startTimelock(uint256 campaignId, uint256 milestoneId)
        external
        onlyMilestoneVoting
    {
        _requireMilestone(campaignId, milestoneId);
        Campaign storage c = campaigns[campaignId];
        Milestone storage m = c.milestones[milestoneId];

        require(m.state == State.Pending, "milestone not pending");
        require(c.balance - c.reserved >= m.amount, "campaign underfunded");

        c.reserved += m.amount;
        m.state = State.Timelocked;
        m.releaseAfter = uint64(block.timestamp + TIMELOCK);

        emit TimelockStarted(campaignId, milestoneId, m.releaseAfter);
    }

    /// @inheritdoc ICampaignEscrow
    function raiseDispute(uint256 campaignId, uint256 milestoneId)
        external
        onlyMilestoneVoting
    {
        _requireMilestone(campaignId, milestoneId);
        Milestone storage m = campaigns[campaignId].milestones[milestoneId];

        require(m.state == State.Timelocked, "milestone not timelocked");
        require(block.timestamp < m.releaseAfter, "timelock window closed");

        m.state = State.Disputed;
        emit DisputeRaised(campaignId, milestoneId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Permissionless release
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICampaignEscrow
    /// @dev The single releasability rule lives in `_isReleasable` — a milestone
    ///      is releasable iff it is Timelocked and its window has elapsed.
    ///      "Timelocked" also rules out an active dispute, because raiseDispute()
    ///      moves the milestone to Disputed. `release()` and `performUpkeep()`
    ///      both gate on `_isReleasable` then call `_payout`; neither re-checks
    ///      state or time independently.
    function release(uint256 campaignId, uint256 milestoneId)
        external
        nonReentrant
    {
        require(
            _isReleasable(campaignId, milestoneId),
            "milestone not releasable"
        );
        _payout(campaignId, milestoneId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Chainlink Automation (IAutomationCompatible)
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IAutomationCompatible
    /// @notice Off-chain scan for milestones whose timelock has elapsed.
    /// @param checkData Empty, or abi.encode(uint256 startCampaignId,
    ///        uint256 campaignsToScan). Empty means scan campaigns
    ///        [0, MAX_CAMPAIGN_SCAN). `campaignsToScan` is clamped to
    ///        MAX_CAMPAIGN_SCAN so a caller cannot force an unbounded loop.
    /// @return upkeepNeeded True if at least one milestone is ready.
    /// @return performData abi.encode(uint256[] campaignIds, uint256[] milestoneIds),
    ///         at most MAX_UPKEEP_BATCH entries, each satisfying `_isReleasable`.
    /// @dev `view` here (Chainlink's interface leaves it non-view; more
    ///      restrictive is allowed). It is executed as an `eth_call`, so the
    ///      loop bound matters for the node's simulation gas cap, not for L1 gas.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 startCampaignId = 0;
        uint256 campaignsToScan = MAX_CAMPAIGN_SCAN;
        if (checkData.length > 0) {
            (startCampaignId, campaignsToScan) = abi.decode(
                checkData,
                (uint256, uint256)
            );
            if (campaignsToScan > MAX_CAMPAIGN_SCAN) {
                campaignsToScan = MAX_CAMPAIGN_SCAN;
            }
        }

        uint256 endCampaignId = startCampaignId + campaignsToScan;
        if (endCampaignId > campaigns.length) {
            endCampaignId = campaigns.length;
        }

        uint256[] memory cids = new uint256[](MAX_UPKEEP_BATCH);
        uint256[] memory mids = new uint256[](MAX_UPKEEP_BATCH);
        uint256 found;

        for (
            uint256 ci = startCampaignId;
            ci < endCampaignId && found < MAX_UPKEEP_BATCH;
            ci++
        ) {
            uint256 mCount = campaigns[ci].milestones.length;
            for (
                uint256 mi = 0;
                mi < mCount && found < MAX_UPKEEP_BATCH;
                mi++
            ) {
                if (_isReleasable(ci, mi)) {
                    cids[found] = ci;
                    mids[found] = mi;
                    found++;
                }
            }
        }

        if (found == 0) {
            return (false, "");
        }

        // Trim to the exact count before encoding.
        uint256[] memory outCids = new uint256[](found);
        uint256[] memory outMids = new uint256[](found);
        for (uint256 i = 0; i < found; i++) {
            outCids[i] = cids[i];
            outMids[i] = mids[i];
        }
        return (true, abi.encode(outCids, outMids));
    }

    /// @inheritdoc IAutomationCompatible
    /// @notice Release every still-ready milestone named in `performData`.
    /// @param performData abi.encode(uint256[] campaignIds, uint256[] milestoneIds)
    ///        — normally the output of `checkUpkeep`, but treated as untrusted:
    ///        anyone may call this. Entries that no longer pass `_isReleasable`
    ///        (raced with a manual release, a dispute, etc.) are skipped, not
    ///        reverted. Processes at most MAX_UPKEEP_BATCH entries.
    /// @dev Same path as `release()`: `_isReleasable` gate then `_payout`. No
    ///      independent state/time checks here.
    function performUpkeep(bytes calldata performData)
        external
        override
        nonReentrant
    {
        (uint256[] memory campaignIds, uint256[] memory milestoneIds) = abi
            .decode(performData, (uint256[], uint256[]));
        require(campaignIds.length == milestoneIds.length, "length mismatch");

        uint256 n = campaignIds.length;
        if (n > MAX_UPKEEP_BATCH) {
            n = MAX_UPKEEP_BATCH;
        }

        uint256 releasedCount;
        for (uint256 i = 0; i < n; i++) {
            if (_isReleasable(campaignIds[i], milestoneIds[i])) {
                _payout(campaignIds[i], milestoneIds[i]);
                releasedCount++;
            }
        }

        require(releasedCount > 0, "no milestones released");
        emit UpkeepPerformed(msg.sender, releasedCount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner dispute resolution (manual; no appeals DAO)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Resolve a disputed milestone.
    /// @param uphold true  -> the milestone is legitimate: pay the beneficiary
    ///                        now and move to Released.
    ///               false -> the milestone is rejected: free its reserved funds
    ///                        for the campaign's other milestones, move to Rejected.
    function resolveDispute(
        uint256 campaignId,
        uint256 milestoneId,
        bool uphold
    ) external onlyOwner nonReentrant {
        _requireMilestone(campaignId, milestoneId);
        Campaign storage c = campaigns[campaignId];
        Milestone storage m = c.milestones[milestoneId];

        require(m.state == State.Disputed, "milestone not disputed");

        if (uphold) {
            _payout(campaignId, milestoneId); // -> Released, ETH sent
            emit DisputeResolved(campaignId, milestoneId, true);
        } else {
            c.reserved -= m.amount; // un-earmark; funds stay in balance
            m.state = State.Rejected;
            m.releaseAfter = 0;
            emit DisputeResolved(campaignId, milestoneId, false);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Slashed-stake sink (Phase 2 TODOs #1 + #2)
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICampaignEscrow
    /// @dev onlyVerifierRegistry (TODO #1). Deliberately minimal and revert-safe
    ///      (TODO #2): no campaign/milestone-state checks that could throw for a
    ///      legitimate registry call and brick MilestoneVoting.finalizeRound().
    ///      An unknown campaignId is parked in `unallocatedSlashed`.
    function creditSlashed(uint256 campaignId)
        external
        payable
        onlyVerifierRegistry
    {
        if (campaignId < campaigns.length) {
            campaigns[campaignId].balance += msg.value;
        } else {
            unallocatedSlashed += msg.value;
        }
        emit SlashedFundsReceived(campaignId, msg.sender, msg.value);
    }

    /// @notice Recover slashed ETH that was credited for a non-existent campaign.
    function sweepUnallocated(address to) external onlyOwner nonReentrant {
        require(to != address(0), "zero address");
        uint256 amount = unallocatedSlashed;
        require(amount > 0, "nothing to sweep");

        unallocatedSlashed = 0;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "sweep failed");

        emit UnallocatedSwept(to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICampaignEscrow
    function beneficiaryOf(uint256 campaignId) external view returns (address) {
        require(campaignId < campaigns.length, "no campaign");
        return campaigns[campaignId].beneficiary;
    }

    function campaignCount() external view returns (uint256) {
        return campaigns.length;
    }

    function milestoneCount(uint256 campaignId) external view returns (uint256) {
        require(campaignId < campaigns.length, "no campaign");
        return campaigns[campaignId].milestones.length;
    }

    /// @inheritdoc ICampaignEscrow
    /// @dev `reserved <= balance` is an invariant (see startTimelock / _payout),
    ///      so this subtraction never underflows.
    function availableBalance(uint256 campaignId)
        external
        view
        returns (uint256)
    {
        require(campaignId < campaigns.length, "no campaign");
        Campaign storage c = campaigns[campaignId];
        return c.balance - c.reserved;
    }

    function getCampaign(uint256 campaignId)
        external
        view
        returns (
            address creator,
            address beneficiary,
            uint256 balance,
            uint256 reserved,
            uint256 milestones
        )
    {
        require(campaignId < campaigns.length, "no campaign");
        Campaign storage c = campaigns[campaignId];
        return (c.creator, c.beneficiary, c.balance, c.reserved, c.milestones.length);
    }

    function getMilestone(uint256 campaignId, uint256 milestoneId)
        external
        view
        returns (
            string memory description,
            uint256 amount,
            State state,
            uint64 releaseAfter
        )
    {
        _requireMilestone(campaignId, milestoneId);
        Milestone storage m = campaigns[campaignId].milestones[milestoneId];
        return (m.description, m.amount, m.state, m.releaseAfter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _requireMilestone(uint256 campaignId, uint256 milestoneId)
        internal
        view
    {
        require(campaignId < campaigns.length, "no campaign");
        require(
            milestoneId < campaigns[campaignId].milestones.length,
            "no milestone"
        );
    }

    /// @dev THE releasability rule — the one place "can this milestone be paid
    ///      out now" is defined. Used by `release()`, `checkUpkeep()`, and
    ///      `performUpkeep()`. Returns false (never reverts) for out-of-range
    ///      ids so it is safe to call with untrusted `performData`.
    function _isReleasable(uint256 campaignId, uint256 milestoneId)
        internal
        view
        returns (bool)
    {
        if (campaignId >= campaigns.length) {
            return false;
        }
        Campaign storage c = campaigns[campaignId];
        if (milestoneId >= c.milestones.length) {
            return false;
        }
        Milestone storage m = c.milestones[milestoneId];
        return
            m.state == State.Timelocked && block.timestamp >= m.releaseAfter;
    }

    /// @dev Pay a milestone to its beneficiary. Callers guard the source state
    ///      (Timelocked for release(), Disputed for resolveDispute(true)) and are
    ///      `nonReentrant`. Checks-effects-interactions: all storage settled
    ///      before the external call, which is the last statement.
    function _payout(uint256 campaignId, uint256 milestoneId) internal {
        Campaign storage c = campaigns[campaignId];
        Milestone storage m = c.milestones[milestoneId];
        uint256 amount = m.amount;

        // ---- Effects ----
        m.state = State.Released;
        c.balance -= amount;
        c.reserved -= amount;
        emit MilestoneReleased(campaignId, milestoneId, c.beneficiary, amount);

        // ---- Interaction (last) ----
        (bool ok, ) = c.beneficiary.call{value: amount}("");
        require(ok, "payout failed");
    }
}
