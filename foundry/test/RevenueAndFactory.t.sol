// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/AgentContainer.sol";
import "../contracts/PolicyCircuit.sol";
import "../contracts/TapeGuardFactory.sol";
import "../contracts/GuardNetlist.sol";
import "./mocks/TapeOutCircuitsMock.sol";
import {MockV2Router} from "./TapeGuardV2.t.sol";

contract RevenueTest is Test {
    address owner = address(0xA11CE);
    address relayer = address(0x7E1A);
    address treasury = address(0x7EA5);
    AgentContainer agent;
    PolicyCircuit policy;
    MockV2Router router;

    function setUp() public {
        agent = new AgentContainer(owner, treasury, 10); // 0.10%
        policy = new PolicyCircuit(owner);
        router = new MockV2Router();
        vm.startPrank(owner);
        agent.setPolicy(address(policy));
        agent.setRelayer(relayer, true);
        policy.setAgent(address(agent), true);
        policy.setTarget(address(router), true, false);
        policy.setFunction(address(router), 0x7ff36ab5, true);
        vm.stopPrank();
        vm.deal(address(agent), 1 ether);
    }

    function _swap() internal view returns (bytes memory) {
        return abi.encodeWithSelector(0x7ff36ab5, uint256(1), new address[](2), address(agent), block.timestamp);
    }

    function testActivationPaysTheTreasuryNotTheOwner() public {
        agent.activate{value: 0.02 ether}();
        assertEq(treasury.balance, 0.02 ether);
        assertEq(agent.accruedFees(), 0);
        assertEq(agent.protocolFeesPaid(), 0.02 ether);
        assertTrue(agent.isActive());
    }

    function testExecutionPaysVolumeFee() public {
        agent.activate{value: 0.02 ether}();
        vm.prank(relayer);
        agent.execute(address(router), 0.05 ether, _swap());
        assertEq(treasury.balance, 0.02 ether + 0.00005 ether);
        assertEq(agent.protocolFeeOf(0.05 ether), 0.00005 ether);
        (address t, uint16 bps, uint256 activation, uint256 paid) = agent.feeTerms();
        assertEq(t, treasury);
        assertEq(bps, 10);
        assertEq(activation, 0.02 ether);
        assertEq(paid, 0.02005 ether);
    }

    function testTokenSideActionsPayNoNativeFee() public {
        assertEq(agent.protocolFeeOf(0), 0);
    }

    function testFeeMustBeCoveredByBalance() public {
        agent.activate{value: 0.02 ether}();
        vm.prank(owner);
        policy.setLimits(2 ether, 2 ether);
        uint256 all = address(agent).balance;
        vm.prank(relayer);
        vm.expectRevert(AgentContainer.InsufficientBalance.selector);
        agent.execute(address(router), all, _swap());
    }

    function testOwnerCannotChangeHostedTerms() public {
        vm.prank(owner);
        vm.expectRevert(AgentContainer.FeeTermsLocked.selector);
        agent.setActivationFee(0);
    }

    function testFeeTermsAreBounded() public {
        vm.expectRevert(AgentContainer.BadFeeTerms.selector);
        new AgentContainer(owner, treasury, 51);
        vm.expectRevert(AgentContainer.BadFeeTerms.selector);
        new AgentContainer(owner, address(0), 10);
    }

    function testSelfHostedKeepsV1Behaviour() public {
        AgentContainer self = new AgentContainer(owner, address(0), 0);
        self.activate{value: 0.02 ether}();
        assertEq(self.accruedFees(), 0.02 ether);
        assertEq(self.protocolFeeOf(1 ether), 0);
        vm.prank(owner);
        self.setActivationFee(0.01 ether);
    }
}

contract FactoryTest is Test {
    TapeGuardFactory factory;
    TapeOutCircuitsMock tapeout;
    MockV2Router router;
    address usdt = address(0x05D7);
    address treasury = address(0x7EA5);
    address hosted = address(0x40575);
    address user = address(0xB0B);
    uint256 circuitId;

    function setUp() public {
        tapeout = new TapeOutCircuitsMock();
        circuitId = tapeout.tapeout(GuardNetlist.NETLIST, GuardNetlist.N_IN, GuardNetlist.N_OUT);
        router = new MockV2Router();
        vm.etch(usdt, hex"00");
        factory = new TapeGuardFactory(
            treasury, 10, address(tapeout), circuitId, address(router), usdt, hosted, new PolicyCircuitDeployer()
        );
        vm.deal(user, 1 ether);
    }

    function testOneClickAgent() public {
        vm.prank(user);
        (AgentContainer agent, PolicyCircuit policy) = factory.createAgent{value: 0.22 ether}(address(0));

        // Activation went to the treasury, the rest funds the agent.
        assertEq(treasury.balance, 0.02 ether);
        assertEq(address(agent).balance, 0.2 ether);
        assertTrue(agent.isActive());
        // Wired: hosted keeper, guard circuit, venue, terms.
        assertTrue(agent.relayers(hosted));
        assertEq(agent.policy(), address(policy));
        assertEq(policy.tapeoutCircuits(), address(tapeout));
        assertEq(policy.tapeoutCircuitId(), circuitId);
        assertTrue(policy.authorizedRouters(address(router)));
        assertEq(agent.treasury(), treasury);
        assertEq(agent.protocolFeeBps(), 10);
        assertEq(factory.agentsCreated(), 1);

        // Handover is two-step: the factory keeps nothing once the user accepts.
        assertEq(agent.pendingOwner(), user);
        assertEq(policy.pendingOwner(), user);
        vm.startPrank(user);
        agent.acceptOwner();
        policy.acceptOwner();
        vm.stopPrank();
        assertEq(agent.owner(), user);
        assertEq(policy.owner(), user);

        // The hosted keeper trades through the TapeOut gate and the fee is paid.
        vm.prank(hosted);
        agent.execute(
            address(router),
            0.05 ether,
            abi.encodeWithSelector(0x7ff36ab5, uint256(1), new address[](2), address(agent), block.timestamp)
        );
        assertEq(treasury.balance, 0.02 ether + 0.00005 ether);

        // And it cannot take the output.
        vm.prank(hosted);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "RECIPIENT_NOT_AGENT"));
        agent.execute(
            address(router),
            0.01 ether,
            abi.encodeWithSelector(0x7ff36ab5, uint256(1), new address[](2), hosted, block.timestamp)
        );
    }

    function testUserCanBringOwnKeeper() public {
        address mine = address(0x111);
        vm.prank(user);
        (AgentContainer agent,) = factory.createAgent{value: 0.02 ether}(mine);
        assertTrue(agent.relayers(mine));
        assertFalse(agent.relayers(hosted));
    }

    function testActivationFeeRequired() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TapeGuardFactory.FeeTooLow.selector, 0.02 ether, 0.01 ether));
        factory.createAgent{value: 0.01 ether}(address(0));
    }
}
