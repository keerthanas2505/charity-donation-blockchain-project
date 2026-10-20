// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IReleasable {
    function release(uint256 campaignId, uint256 milestoneId) external;
}

/// @notice Test-only. When this contract receives its milestone payout it
///         re-enters `release()` for the same milestone and records whether the
///         re-entry reverted and with what reason. Used to prove CampaignEscrow's
///         `nonReentrant` guard + checks-effects-interactions on `_payout`.
contract ReentrantBeneficiary {
    IReleasable public immutable escrow;
    uint256 public campaignId;
    uint256 public milestoneId;
    bool public armed;
    bool public reentered;
    bool public reentryReverted;
    string public reentryRevertReason;

    constructor(address escrow_) {
        escrow = IReleasable(escrow_);
    }

    function arm(uint256 campaignId_, uint256 milestoneId_) external {
        campaignId = campaignId_;
        milestoneId = milestoneId_;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one-shot: stops infinite recursion
        reentered = true;
        try escrow.release(campaignId, milestoneId) {
            reentryReverted = false;
        } catch Error(string memory reason) {
            reentryReverted = true;
            reentryRevertReason = reason;
        } catch {
            reentryReverted = true;
            reentryRevertReason = "<non-string revert>";
        }
    }
}
