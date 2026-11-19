// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/AgentContainer.sol";
import "../contracts/PolicyCircuit.sol";
import "./mocks/TapeOutCircuitsMock.sol";
import "../contracts/GuardNetlist.sol";

/// UniswapV2-style router: credits the output to `to` (pretend 1 OKB = 50 USDT).
contract MockV2Router {
    mapping(address => uint256) public usdt;

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata, address to, uint256)
        external
        payable
        returns (uint256[] memory a)
    {
        require(msg.value * 50 >= amountOutMin, "slippage");
        usdt[to] += msg.value * 50;
        a = new uint256[](2);
    }

    /// Not a standard V2 layout: recipient is the first argument.
    function sweep(address to, uint256 minOut) external payable {
        usdt[to] += minOut;
    }
}

contract MockUSDT {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    // USDT-style: returns nothing
    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

contract TapeGuardV2Test is Test {
    AgentContainer agent;
    PolicyCircuit policy;
    MockV2Router router;
    TapeOutCircuitsMock tapeout;
    uint256 circuitId;

    address owner = address(0xA11CE);
    address relayer = address(0x7E1A);
    address attacker = address(0xBAD);

    bytes4 constant SWAP = MockV2Router.swapExactETHForTokens.selector;

    function setUp() public {
        agent = new AgentContainer(owner);
        policy = new PolicyCircuit(owner);
        router = new MockV2Router();
        tapeout = new TapeOutCircuitsMock();
        circuitId = tapeout.tapeout(GuardNetlist.NETLIST, GuardNetlist.N_IN, GuardNetlist.N_OUT);

        vm.startPrank(owner);
        agent.setPolicy(address(policy));
        agent.setRelayer(relayer, true);
        policy.setAgent(address(agent), true);
        policy.setTarget(address(router), true, false);
        policy.setRouter(address(router), true);
        policy.setFunction(address(router), SWAP, true);
        vm.stopPrank();
        vm.deal(address(agent), 10 ether);
        agent.activate{value: 0.02 ether}();
    }

    function _swap(address to, uint256 minOut) internal view returns (bytes memory) {
        address[] memory path = new address[](2);
        return abi.encodeWithSelector(SWAP, minOut, path, to, block.timestamp);
    }

    function _linkCircuit() internal {
        vm.prank(owner);
        policy.setTapeOutCircuit(address(tapeout), circuitId);
    }

    // ------------------------------------------------ keeper-theft regression
    /// The audit's proof of concept: a leaked keeper names itself as swap recipient.
    function testKeeperCannotRedirectSwapOutput() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "RECIPIENT_NOT_AGENT"));
        agent.execute(address(router), 0.05 ether, _swap(attacker, 1));
        assertEq(router.usdt(attacker), 0);
    }

    function testRedirectBlockedEvenWhenRouterNotRegistered() public {
        vm.prank(owner);
        policy.setRouter(address(router), false);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "RECIPIENT_NOT_AGENT"));
        agent.execute(address(router), 0.05 ether, _swap(attacker, 1));
    }

    function testZeroMinOutRejected() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "NO_MIN_OUT"));
        agent.execute(address(router), 0.05 ether, _swap(address(agent), 0));
    }

    function testTruncatedSwapCalldataRejected() public {
        (bool ok, string memory reason) =
            policy.check(address(agent), address(router), 0, abi.encodeWithSelector(SWAP, 1));
        assertFalse(ok);
        assertEq(reason, "BAD_CALLDATA");
    }

    function testLegitSwapToAgentExecutes() public {
        vm.prank(relayer);
        agent.execute(address(router), 0.05 ether, _swap(address(agent), 2 ether));
        assertEq(router.usdt(address(agent)), 2.5 ether);
    }

    function testCustomShapeRequiredForNonStandardRouterFunction() public {
        bytes4 sweep = MockV2Router.sweep.selector;
        vm.prank(owner);
        policy.setFunction(address(router), sweep, true);
        bytes memory toAttacker = abi.encodeWithSelector(sweep, attacker, 1);
        (bool ok, string memory reason) = policy.check(address(agent), address(router), 0, toAttacker);
        assertFalse(ok);
        assertEq(reason, "RECIPIENT_UNCHECKED");

        vm.prank(owner);
        policy.setSwapShape(address(router), sweep, true, 0, 1);
        (ok, reason) = policy.check(address(agent), address(router), 0, toAttacker);
        assertEq(reason, "RECIPIENT_NOT_AGENT");
        (ok, reason) =
            policy.check(address(agent), address(router), 0, abi.encodeWithSelector(sweep, address(agent), 1));
        assertTrue(ok, reason);
    }

    function testOwnerCannotSwitchOffBuiltInShape() public {
        vm.prank(owner);
        policy.setSwapShape(address(router), SWAP, false, 0, 0);
        (bool known, uint8 to,) = policy.swapShape(address(router), SWAP);
        assertTrue(known);
        assertEq(to, 2);
        (bool ok,) = policy.check(address(agent), address(router), 0, _swap(attacker, 1));
        assertFalse(ok);
    }

    // ------------------------------------------------------------ token caps
    function testRecordExecutionEnforcesTokenCapsOnItsOwn() public {
        address token = address(0x70CE);
        vm.prank(owner);
        policy.setTokenLimit(token, true, 10, 15);
        vm.startPrank(address(agent));
        vm.expectRevert(PolicyCircuit.TokenAboveLimit.selector);
        policy.recordExecution(1, 0, token, 11); // above per-action
        policy.recordExecution(1, 0, token, 10);
        vm.expectRevert(PolicyCircuit.TokenAboveLimit.selector);
        policy.recordExecution(2, 0, token, 6); // above daily
        vm.expectRevert(PolicyCircuit.TokenAboveLimit.selector);
        policy.recordExecution(2, 0, address(0xD15AB1ED), 1); // token never enabled
        vm.stopPrank();
    }

    // ---------------------------------------------------------- token rescue
    function testOwnerCanWithdrawTokensRelayerCannot() public {
        MockUSDT usdt = new MockUSDT();
        usdt.mint(address(agent), 100);
        vm.prank(relayer);
        vm.expectRevert(AgentContainer.NotOwner.selector);
        agent.withdrawToken(address(usdt), relayer, 100);
        vm.prank(owner);
        agent.withdrawToken(address(usdt), owner, 100);
        assertEq(usdt.balanceOf(owner), 100);
    }

    // ------------------------------------------------------------ TapeOut gate
    function testMockEvaluatorMatchesSpecOnAllFactVectors() public {
        _linkCircuit();
        for (uint256 bits; bits < 1024; bits++) {
            (bool ok, bool approves) = policy.evalCircuit(bits);
            assertTrue(ok);
            bool safe = bits & 0xff == 0xff;
            bool stretched = (bits >> 8) & 3 == 3;
            assertEq(approves, safe && !stretched, vm.toString(bits));
        }
    }

    function testCircuitBlocksLargeTradeOnceHalfBudgetSpent() public {
        _linkCircuit();
        // 0.25 OKB/day, 0.05 per action. Spend 0.15 (>= half) in small steps.
        vm.startPrank(relayer);
        for (uint256 i; i < 6; i++) {
            agent.execute(address(router), 0.025 ether, _swap(address(agent), 1));
            if (policy.spentToday(address(agent)) >= 0.125 ether) break;
        }
        vm.stopPrank();
        // A large step: the Solidity floor alone would allow it ...
        (uint256 facts, bool floorOk,,, bool circuitOk, bool circuitApproves) =
            policy.trace(address(agent), address(router), 0.04 ether, _swap(address(agent), 1));
        assertTrue(floorOk);
        assertTrue(circuitOk);
        assertFalse(circuitApproves);
        assertEq(facts & 0x300, 0x300);
        // ... but the TapeOut circuit says no.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "CIRCUIT_REJECTED"));
        agent.execute(address(router), 0.04 ether, _swap(address(agent), 1));
        // A small step is still fine.
        vm.prank(relayer);
        agent.execute(address(router), 0.02 ether, _swap(address(agent), 1));
    }

    function testTapeOutOutageFailsClosed() public {
        _linkCircuit();
        tapeout.setMode(TapeOutCircuitsMock.Mode.Reverts);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "CIRCUIT_UNAVAILABLE"));
        agent.execute(address(router), 0.01 ether, _swap(address(agent), 1));
        tapeout.setMode(TapeOutCircuitsMock.Mode.Garbage);
        (bool ok, string memory reason) =
            policy.check(address(agent), address(router), 0.01 ether, _swap(address(agent), 1));
        assertFalse(ok);
        assertEq(reason, "CIRCUIT_UNAVAILABLE");
    }

    function testHostileCircuitCannotApproveWhatTheFloorRejects() public {
        _linkCircuit();
        tapeout.setMode(TapeOutCircuitsMock.Mode.AlwaysApprove);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "RECIPIENT_NOT_AGENT"));
        agent.execute(address(router), 0.05 ether, _swap(attacker, 1));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "PER_ACTION_LIMIT"));
        agent.execute(address(router), 1 ether, _swap(address(agent), 1));
    }

    function testOwnerCanUnlinkCircuitAsEscapeHatch() public {
        _linkCircuit();
        tapeout.setMode(TapeOutCircuitsMock.Mode.Reverts);
        vm.prank(owner);
        policy.setTapeOutCircuit(address(0), 0);
        vm.prank(relayer);
        agent.execute(address(router), 0.01 ether, _swap(address(agent), 1));
    }

    function testSetCircuitValidatesPinsAndUpdatesCommitment() public {
        uint256 wrong = tapeout.tapeout(GuardNetlist.NETLIST, 9, 1);
        vm.prank(owner);
        vm.expectRevert(PolicyCircuit.BadCircuit.selector);
        policy.setTapeOutCircuit(address(tapeout), wrong);

        vm.prank(owner);
        vm.expectRevert(PolicyCircuit.NotAContract.selector);
        policy.setTapeOutCircuit(address(0xC0FFEE), 1);

        bytes32 before = policy.commitment();
        _linkCircuit();
        assertTrue(policy.commitment() != before);
        assertEq(policy.commitment(), policy.computeCommitment());
        assertEq(policy.tapeoutCircuits(), address(tapeout));
        assertEq(policy.tapeoutCircuitId(), circuitId);
    }

    function testOnlyOwnerConfiguresCircuitAndShapes() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyCircuit.NotOwner.selector);
        policy.setTapeOutCircuit(address(tapeout), circuitId);
        vm.prank(attacker);
        vm.expectRevert(PolicyCircuit.NotOwner.selector);
        policy.setSwapShape(address(router), SWAP, true, 0, 1);
    }
}

contract PolicyOwnershipTest is Test {
    function testPolicyOwnershipHandoverIsTwoStep() public {
        address owner = address(0xA11CE);
        address next = address(0xC0DE);
        PolicyCircuit policy = new PolicyCircuit(owner);
        vm.prank(next);
        vm.expectRevert(PolicyCircuit.NotOwner.selector);
        policy.transferOwner(next);
        vm.prank(owner);
        policy.transferOwner(next);
        assertEq(policy.owner(), owner);
        vm.prank(address(0xBAD));
        vm.expectRevert(PolicyCircuit.NotOwner.selector);
        policy.acceptOwner();
        vm.prank(next);
        policy.acceptOwner();
        assertEq(policy.owner(), next);
        vm.prank(owner);
        vm.expectRevert(PolicyCircuit.NotOwner.selector);
        policy.setPaused(true);
    }
}
