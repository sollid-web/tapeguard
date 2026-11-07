// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/PolicyCircuit.sol";

contract PolicyCircuitBypassTest is Test {
    PolicyCircuit policy;
    address owner = address(0xA11CE);
    address agent = address(0xB0B);
    address stranger = address(0xBAD);
    address target = address(0xDE);
    address router = address(0xA11CE1);

    function setUp() public {
        vm.prank(owner);
        policy = new PolicyCircuit(owner);
        vm.prank(owner);
        policy.setAgent(agent, true);
        vm.prank(owner);
        policy.setTarget(target, true, false);
        vm.prank(owner);
        policy.setFunction(target, bytes4(0x12345678), true);
        vm.prank(owner);
        policy.setRouter(router, true);
    }

    function testStoredCommitmentMatchesComputedCommitment() public {
        assertEq(policy.commitment(), policy.computeCommitment());
        vm.prank(owner);
        policy.setMaxActionsPerDay(11);
        assertEq(policy.commitment(), policy.computeCommitment());
        vm.prank(owner);
        policy.setLimits(2 ether, 4 ether);
        assertEq(policy.commitment(), policy.computeCommitment());
    }

    function testRejectsUnauthorizedTargetAndSelector() public {
        (bool ok,) = policy.check(agent, stranger, 0, hex"12345678");
        assertFalse(ok);
        (ok,) = policy.check(agent, target, 0, hex"87654321");
        assertFalse(ok);
    }

    function testRejectsUnauthorizedAgent() public {
        (bool ok,) = policy.check(stranger, target, 0, hex"12345678");
        assertFalse(ok);
    }

    function testEnforcesPerActionAndDailyVolumeLimits() public {
        vm.prank(owner);
        policy.setLimits(1 ether, 2 ether);
        vm.prank(agent);
        policy.recordExecution(1, 1 ether, address(0), 0);
        vm.prank(agent);
        vm.expectRevert(PolicyCircuit.SpendAboveLimit.selector);
        policy.recordExecution(2, 2 ether, address(0), 0);
    }

    function testCheckRejectsWhenDailyActionLimitReached() public {
        vm.prank(owner);
        policy.setMaxActionsPerDay(1);
        (bool ok, string memory reason) = policy.check(agent, target, 0, hex"12345678");
        assertTrue(ok);
        vm.prank(agent);
        policy.recordExecution(1, 0, address(0), 0);
        (ok, reason) = policy.check(agent, target, 0, hex"12345678");
        assertFalse(ok);
        assertEq(reason, "ACTION_LIMIT");
    }

    function testEnforcesDailyActionLimitAndNonceReplay() public {
        vm.prank(owner);
        policy.setMaxActionsPerDay(1);
        vm.prank(agent);
        policy.recordExecution(1, 0, address(0), 0);
        vm.prank(agent);
        vm.expectRevert(PolicyCircuit.ActionsAboveLimit.selector);
        policy.recordExecution(2, 0, address(0), 0);
        vm.prank(agent);
        vm.expectRevert(PolicyCircuit.NonceMismatch.selector);
        policy.recordExecution(1, 0, address(0), 0);
    }

    function testRejectsRouterApprovalUnlessRegistered() public {
        (bool ok,) = policy.check(agent, router, 0, hex"095ea7b3");
        assertFalse(ok); // router target still requires normal target/selector policy
        vm.prank(owner);
        policy.setTarget(router, true, true);
        (ok,) = policy.check(agent, router, 0, hex"095ea7b3");
        assertTrue(ok);
    }

    function testUtcDayBoundaryResetsActionCounter() public {
        vm.prank(owner);
        policy.setMaxActionsPerDay(1);
        vm.prank(agent);
        policy.recordExecution(1, 0, address(0), 0);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        policy.recordExecution(2, 0, address(0), 0);
        assertEq(policy.actionsToday(agent), 1);
    }
}
