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

    function increaseAllowance(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] += amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
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

    function testRevokedRelayerCannotExecute() public {
        address relayer = address(0x1234);
        vm.prank(owner);
        agent.setRelayer(relayer, true);
        vm.prank(owner);
        agent.setRelayer(relayer, false);

        vm.prank(relayer);
        vm.expectRevert(AgentContainer.NotAuthorised.selector);
        agent.execute(address(token), 0, bytes(""));
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

    function testSensitiveTokenSelectorsRejectTruncatedAndTrailingCalldata() public {
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeWithSignature("approve(address,uint256)", router, 7);
        calls[1] = abi.encodeWithSignature("increaseAllowance(address,uint256)", router, 7);
        calls[2] = abi.encodeWithSignature("transfer(address,uint256)", recipient, 7);
        calls[3] = abi.encodeWithSignature("transferFrom(address,address,uint256)", owner, recipient, 7);

        for (uint256 i; i < calls.length; ++i) {
            bytes memory padded = bytes.concat(calls[i], hex"deadbeef");
            bytes memory truncated = new bytes(calls[i].length - 1);
            for (uint256 j; j < truncated.length; ++j) {
                truncated[j] = calls[i][j];
            }
            _assertMalformedTokenCall(padded);
            _assertMalformedTokenCall(truncated);
        }
    }

    function testCanonicalSensitiveTokenCallsRemainAccepted() public {
        policy.setRouter(router, true);
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeWithSignature("approve(address,uint256)", router, 7);
        calls[1] = abi.encodeWithSignature("increaseAllowance(address,uint256)", router, 7);
        calls[2] = abi.encodeWithSignature("transfer(address,uint256)", recipient, 7);
        calls[3] = abi.encodeWithSignature("transferFrom(address,address,uint256)", owner, recipient, 7);

        for (uint256 i; i < calls.length; ++i) {
            vm.prank(owner);
            agent.execute(address(token), 0, calls[i]);
            (bool approved,) = agent.simulate(address(token), 0, calls[i]);
            assertTrue(approved);
        }
    }

    function _assertMalformedTokenCall(bytes memory data) private {
        vm.prank(owner);
        vm.expectRevert(AgentContainer.NonCanonicalTokenCalldata.selector);
        agent.execute(address(token), 0, data);

        vm.prank(owner);
        vm.expectRevert(AgentContainer.NonCanonicalTokenCalldata.selector);
        agent.simulate(address(token), 0, data);
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
