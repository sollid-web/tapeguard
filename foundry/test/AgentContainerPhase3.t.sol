// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/AgentContainer.sol";

contract MockPolicyPhase3 is IPolicyCircuit {
    mapping(address => bool) public routers;
    bool public approved = true;
    bool public tokenApproved = true;

    function setRouter(address router, bool allowed) external {
        routers[router] = allowed;
    }

    function setApproved(bool value) external {
        approved = value;
    }

    function setTokenApproved(bool value) external {
        tokenApproved = value;
    }

    function check(address, address, uint256, bytes calldata) external view returns (bool, string memory) {
        return (approved, approved ? "" : "blocked");
    }

    function checkToken(address, address, uint256) external view returns (bool, string memory) {
        return (tokenApproved, tokenApproved ? "" : "token blocked");
    }
    function recordExecution(uint256, uint256, address, uint256) external {}

    function authorizedRouters(address router) external view returns (bool) {
        return routers[router];
    }
}

contract MockTokenPhase3 {
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract AgentContainerPhase3Test is Test {
    AgentContainer agent;
    MockPolicyPhase3 policy;
    MockTokenPhase3 token;
    address owner = address(0xA11CE);
    address recipient = address(0xB0B);
    address router = address(0xCAFE);

    function setUp() public {
        vm.prank(owner);
        agent = new AgentContainer(owner);
        policy = new MockPolicyPhase3();
        token = new MockTokenPhase3();
        vm.prank(owner);
        agent.setPolicy(address(policy));
        vm.deal(address(agent), 10 ether);
        agent.activate{value: 0.02 ether}();
    }

    function testOwnerCanWithdrawOnlyUnreservedFunds() public {
        uint256 before = recipient.balance;
        vm.prank(owner);
        agent.withdraw(recipient, 9 ether);
        assertEq(recipient.balance - before, 9 ether);
        assertEq(agent.availableFunding(), 1 ether);

        vm.prank(owner);
        vm.expectRevert(AgentContainer.InsufficientBalance.selector);
        agent.withdraw(recipient, 1.1 ether);
    }

    function testRelayerCannotWithdrawOrChangePolicy() public {
        address relayer = address(0x1234);
        vm.prank(owner);
        agent.setRelayer(relayer, true);
        vm.prank(relayer);
        vm.expectRevert(AgentContainer.NotOwner.selector);
        agent.withdraw(recipient, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(AgentContainer.NotOwner.selector);
        agent.setPolicy(address(policy));
    }

    function testApprovalRequiresRegisteredRouterAndSupportsZeroReset() public {
        bytes memory approval = abi.encodeWithSignature("approve(address,uint256)", router, 7);
        vm.prank(owner);
        vm.expectRevert(AgentContainer.RouterNotAuthorised.selector);
        agent.execute(address(token), 0, approval);

        policy.setRouter(router, true);
        vm.prank(owner);
        agent.execute(address(token), 0, approval);
        assertEq(token.allowance(address(agent), router), 7);

        bytes memory reset = abi.encodeWithSignature("approve(address,uint256)", router, 0);
        vm.prank(owner);
        agent.execute(address(token), 0, reset);
        assertEq(token.allowance(address(agent), router), 0);
    }

    function testTrailingTokenCalldataCannotBypassTokenLimit() public {
        policy.setTokenApproved(false);
        bytes memory canonical = abi.encodeWithSignature("approve(address,uint256)", router, 7);
        bytes memory padded = bytes.concat(canonical, hex"deadbeef");
        vm.prank(owner);
        vm.expectRevert(AgentContainer.NonCanonicalTokenCalldata.selector);
        agent.execute(address(token), 0, padded);

        vm.prank(owner);
        vm.expectRevert(AgentContainer.NonCanonicalTokenCalldata.selector);
        agent.simulate(address(token), 0, padded);
    }

    function testCanonicalTokenCallStillReachesTokenPolicy() public {
        policy.setTokenApproved(false);
        bytes memory approval = abi.encodeWithSignature("approve(address,uint256)", router, 7);
        policy.setRouter(router, true);
        vm.prank(owner);
        vm.expectRevert();
        agent.execute(address(token), 0, approval);
    }

    function testOwnerHandoverRequiresAcceptance() public {
        address next = address(0xD00D);
        vm.prank(owner);
        agent.transferOwner(next);
        vm.prank(owner);
        agent.withdraw(recipient, 1 ether);
        vm.prank(next);
        agent.acceptOwner();
        vm.prank(owner);
        vm.expectRevert(AgentContainer.NotOwner.selector);
        agent.withdraw(recipient, 1 ether);
        vm.prank(next);
        agent.withdraw(recipient, 1 ether);
    }
}
