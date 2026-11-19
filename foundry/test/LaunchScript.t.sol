// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../script/LaunchTapeGuard.s.sol";
import "./mocks/TapeOutCircuitsMock.sol";

/// Stand-ins for TapeOut's factory, transistors, opener and circuit account, placed at the
/// real mainnet addresses, with the fee rules documented from the live contracts
/// (exact tapeout fee, mint = amount * price + protocol fee, EXEC_FEE refunds the excess).
contract TransistorsStub {
    uint256 public constant mintPrice = 0.00001 ether;
    uint256 public constant protocolFee = 0.00066 ether;
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    address public circuits;

    function setCircuits(address c) external {
        circuits = c;
    }

    function mint(uint256 id, uint256 amount) external payable {
        require(msg.value == amount * mintPrice + protocolFee, "insufficient");
        balanceOf[msg.sender][id] += amount;
    }

    function burnFrom(address from, uint256 id, uint256 amount) external {
        require(msg.sender == circuits, "only circuits");
        balanceOf[from][id] -= amount;
    }
}

contract CircuitsStub is TapeOutCircuitsMock {
    uint256 public constant TAPEOUT_FEE = 0.0013 ether;
    TransistorsStub public immutable transistorsStub;
    mapping(uint256 => address) public ownerOf;

    constructor(TransistorsStub t) {
        transistorsStub = t;
    }

    function transistors() external view returns (address) {
        return address(transistorsStub);
    }

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable override returns (uint256 id) {
        require(msg.value == TAPEOUT_FEE, "tapeout fee");
        transistorsStub.burnFrom(msg.sender, 0, nl.length / 7);
        id = _store(nl, nIn, nOut);
        ownerOf[id] = msg.sender;
    }
}

contract FactoryStub {
    mapping(address => bool) public isCPU;

    function deployFee() external pure returns (uint256) {
        return 0.0066 ether;
    }

    function createCPU(string calldata, string calldata, string calldata, uint256, uint256)
        external
        payable
        returns (address transistors, address circuits)
    {
        require(msg.value >= 0.0066 ether, "deploy fee");
        TransistorsStub t = new TransistorsStub();
        CircuitsStub c = new CircuitsStub(t);
        t.setCircuits(address(c));
        isCPU[address(c)] = true;
        return (address(t), address(c));
    }
}

contract AccountStub {
    address public immutable circuits;
    uint256 public immutable tokenId;

    constructor(address c, uint256 id) {
        (circuits, tokenId) = (c, id);
    }

    receive() external payable {}

    function execute(address to, uint256 value, bytes calldata data, uint8 op)
        external
        payable
        returns (bytes memory r)
    {
        require(msg.sender == CircuitsStub(circuits).ownerOf(tokenId), "NotOwner");
        require(op == 0 && msg.value >= 0.0013 ether, "fee");
        bool ok;
        (ok, r) = to.call{value: value}(data);
        require(ok, "call");
        payable(msg.sender).transfer(msg.value - 0.0013 ether);
    }
}

contract OpenerStub {
    mapping(bytes32 => address) internal _a;

    function FEE() external pure returns (uint256) {
        return 0.08 ether;
    }

    function open(address c, uint256 id) external payable returns (address a) {
        require(msg.value >= 0.08 ether, "fee");
        a = address(new AccountStub(c, id));
        _a[keccak256(abi.encode(c, id))] = a;
    }

    function accountOf(address c, uint256 id) external view returns (address) {
        return _a[keccak256(abi.encode(c, id))];
    }
}

contract LaunchScriptTest is Test {
    address constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address constant OPENER = 0x536adD8F30f03b69f6fbF29d425A816A0dC50106;
    uint256 constant PK = 0xA11CE;

    function setUp() public {
        vm.chainId(196);
        vm.etch(FACTORY, address(new FactoryStub()).code);
        vm.etch(OPENER, address(new OpenerStub()).code);
        vm.deal(vm.addr(PK), 10 ether);
        vm.setEnv("PRIVATE_KEY", vm.toString(PK));
        vm.setEnv("RELAYER_ADDRESS", vm.toString(address(0x7E1A)));
        vm.setEnv("ACTIVATE", "true");
        vm.setEnv("FUND_WEI", "200000000000000000");
        vm.setEnv("TREASURY", vm.toString(address(0x7EA5)));
        vm.setEnv("ROUTER", vm.toString(address(0x2007E2)));
        vm.setEnv("USDT", vm.toString(address(0x05D7)));
        vm.setEnv("DEPLOY_FACTORY", "true");
    }

    function testFullLaunchWithHandover() public {
        vm.setEnv("HANDOVER_TO_TAPEOUT_CONTAINER", "true");
        address deployer = vm.addr(PK);
        uint256 before = deployer.balance;
        vm.recordLogs();
        new LaunchTapeGuard().run();

        // Find the deployed contracts from the script's own state changes.
        (address circuits, uint256 id, PolicyCircuit policy, AgentContainer agent) = _deployed();
        assertTrue(FactoryStub(FACTORY).isCPU(circuits));
        assertEq(CircuitsStub(circuits).netlist(id), GuardNetlist.NETLIST);
        assertEq(policy.tapeoutCircuits(), circuits);
        assertEq(policy.tapeoutCircuitId(), id);
        assertTrue(agent.isActive());
        assertEq(agent.policy(), address(policy));
        assertTrue(agent.relayers(address(0x7E1A)));
        assertTrue(policy.authorisedAgents(address(agent)));
        assertEq(agent.treasury(), address(0x7EA5));
        assertEq(agent.protocolFeeBps(), 10);
        assertEq(address(0x7EA5).balance, 0.02 ether); // activation went to the treasury
        assertTrue(policy.authorizedRouters(address(0x2007E2)));

        address container = OpenerStub(OPENER).accountOf(circuits, id);
        assertTrue(container != address(0));
        assertEq(agent.owner(), container);
        assertEq(policy.owner(), container);

        // Exact TapeOut fees: deploy + 17 NAND + tapeout + open + 2 exec + activation + funding.
        uint256 spent = before - deployer.balance;
        uint256 expected = 0.0066 ether + (17 * 0.00001 ether + 0.00066 ether) + 0.0013 ether + 0.08 ether + 2
            * 0.0013 ether + 0.02 ether + 0.2 ether;
        assertEq(spent, expected);

        // The launched agent actually works end to end through the TapeOut gate.
        (bool ok, string memory reason) = policy.check(address(agent), address(0xDEAD), 0, "");
        assertFalse(ok);
        assertEq(reason, "TARGET_NOT_ALLOWED");
    }

    function _deployed() internal returns (address circuits, uint256 id, PolicyCircuit policy, AgentContainer agent) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 circuitSet = keccak256("TapeOutCircuitSet(address,uint256)");
        bytes32 policySet = keccak256("PolicySet(address)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == circuitSet) {
                policy = PolicyCircuit(logs[i].emitter);
                circuits = address(uint160(uint256(logs[i].topics[1])));
                id = uint256(logs[i].topics[2]);
            } else if (logs[i].topics[0] == policySet) {
                agent = AgentContainer(payable(logs[i].emitter));
            }
        }
    }
}
