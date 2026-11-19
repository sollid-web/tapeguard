// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentContainer.sol";
import "./PolicyCircuit.sol";

/// @notice Deploys PolicyCircuits for the factory. A separate contract only because
///         the factory cannot embed both contracts' bytecode within the EIP-170 limit.
///         Anyone may call it: a PolicyCircuit owned by the caller grants nothing.
contract PolicyCircuitDeployer {
    function deploy(address owner_) external returns (PolicyCircuit) {
        return new PolicyCircuit(owner_);
    }
}

/// @title  TapeGuardFactory
/// @notice One transaction gives a user a guarded trading agent on X Layer:
///         a PolicyCircuit and an AgentContainer, wired to the TapeGuard guard circuit
///         on TapeOut, the trading venue and the keeper, activated and funded, then
///         handed to the user (two-step: the user calls acceptOwner on both).
/// @dev    No admin, no upgrade: every parameter is immutable and public, so a user
///         can read exactly what they sign up for. The factory keeps no funds.
contract TapeGuardFactory {
    error ZeroAddress();
    error FeeTooLow(uint256 required, uint256 sent);
    error TransferFailed();

    event AgentCreated(address indexed user, address indexed agent, address indexed policy, address relayer);

    address public immutable treasury;
    uint16 public immutable protocolFeeBps;
    address public immutable tapeoutCircuits;
    uint256 public immutable guardCircuitId;
    address public immutable router;
    address public immutable usdt;
    /// TapeGuard's hosted keeper, used when the user does not bring their own.
    address public immutable hostedRelayer;
    PolicyCircuitDeployer public immutable policyDeployer;

    uint256 public agentsCreated;

    constructor(
        address treasury_,
        uint16 protocolFeeBps_,
        address tapeoutCircuits_,
        uint256 guardCircuitId_,
        address router_,
        address usdt_,
        address hostedRelayer_,
        PolicyCircuitDeployer policyDeployer_
    ) {
        if (
            treasury_ == address(0) || router_ == address(0) || usdt_ == address(0) || hostedRelayer_ == address(0)
                || address(policyDeployer_) == address(0)
        ) {
            revert ZeroAddress();
        }
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
        tapeoutCircuits = tapeoutCircuits_;
        guardCircuitId = guardCircuitId_;
        router = router_;
        usdt = usdt_;
        hostedRelayer = hostedRelayer_;
        policyDeployer = policyDeployer_;
    }

    /// @param relayer the keeper allowed to push actions; address(0) = TapeGuard's hosted keeper
    /// @dev   msg.value pays the first 30-day activation; anything above funds the agent.
    function createAgent(address relayer) external payable returns (AgentContainer agent, PolicyCircuit policy) {
        if (relayer == address(0)) relayer = hostedRelayer;
        policy = policyDeployer.deploy(address(this));
        agent = new AgentContainer(address(this), treasury, protocolFeeBps);

        agent.setPolicy(address(policy));
        agent.setRelayer(relayer, true);
        policy.setAgent(address(agent), true);
        // Conservative defaults; the user tunes them after accepting ownership.
        policy.setLimits(0.05 ether, 0.25 ether);
        policy.setMaxActionsPerDay(6);
        policy.setTarget(router, true, false);
        policy.setRouter(router, true);
        policy.setFunction(router, 0x7ff36ab5, true); // swapExactETHForTokens
        policy.setFunction(router, 0x18cbafe5, true); // swapExactTokensForETH
        policy.setTarget(usdt, true, false);
        policy.setFunction(usdt, 0x095ea7b3, true); // approve (router-only, enforced by the container)
        policy.setTokenLimit(usdt, true, 25e6, 100e6);
        if (tapeoutCircuits != address(0)) policy.setTapeOutCircuit(tapeoutCircuits, guardCircuitId);

        uint256 fee = agent.activationFee();
        if (msg.value < fee) revert FeeTooLow(fee, msg.value);
        agent.activate{value: fee}();
        if (msg.value > fee) {
            (bool ok,) = address(agent).call{value: msg.value - fee}("");
            if (!ok) revert TransferFailed();
        }

        agent.transferOwner(msg.sender);
        policy.transferOwner(msg.sender);
        agentsCreated += 1;
        emit AgentCreated(msg.sender, address(agent), address(policy), relayer);
    }
}
