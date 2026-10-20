// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAutomationCompatible
/// @notice Local mirror of Chainlink's AutomationCompatibleInterface (from the
///         chainlink contracts npm package, path
///         src/v0.8/automation/AutomationCompatible.sol). Kept local so the
///         project does not depend on that whole package. What the Automation
///         registry actually invokes are the two function selectors
///         checkUpkeep(bytes) and performUpkeep(bytes); those match exactly, so
///         a contract implementing this interface is registrable as a real
///         upkeep. Swap this import for the official one if you add the dependency.
interface IAutomationCompatible {
    /// @notice Off-chain simulation entrypoint. The Automation network calls this
    ///         with `eth_call` (no transaction, no gas paid) on a schedule.
    /// @param checkData Arbitrary bytes fixed when the upkeep is registered.
    /// @return upkeepNeeded True if `performUpkeep` should be sent on-chain now.
    /// @return performData Opaque bytes forwarded verbatim to `performUpkeep`.
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);

    /// @notice On-chain execution entrypoint, sent by the Automation registry
    ///         after a `checkUpkeep` returned `upkeepNeeded == true`.
    /// @param performData The bytes that `checkUpkeep` returned.
    function performUpkeep(bytes calldata performData) external;
}
