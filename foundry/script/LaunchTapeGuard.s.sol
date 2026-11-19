// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/PolicyCircuit.sol";
import "../contracts/AgentContainer.sol";
import "../contracts/GuardNetlist.sol";
import "../contracts/TapeGuardFactory.sol";

interface ITapeOutFactory {
    function createCPU(string calldata, string calldata, string calldata, uint256, uint256)
        external
        payable
        returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
    function isCPU(address circuits) external view returns (bool);
}

interface ITapeOutTransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

interface ITapeOutCircuitsFull {
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
}

interface ITapeOutOpener {
    function FEE() external view returns (uint256);
    function open(address circuits, uint256 tokenId) external payable returns (address);
    function accountOf(address circuits, uint256 tokenId) external view returns (address);
}

interface ITapeOutAccount {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

/// One-shot TapeGuard launch on X Layer mainnet (chain 196):
///   1. TapeOut: create the TapeGuard processor, mint 17 NAND, tape out the guard circuit
///      (skipped when TAPEOUT_CIRCUITS / TAPEOUT_CIRCUIT_ID point at an existing one)
///   2. deploy PolicyCircuit v2 + AgentContainer, wire relayer / router / USDT, link the circuit
///   3. optional: activate, fund, and hand both contracts to the circuit's own TapeOut container
///
/// Rehearse on a fork first (no OKB spent):
///   anvil --fork-url https://rpc.xlayer.tech &
///   forge script script/LaunchTapeGuard.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// Then for real:
///   forge script script/LaunchTapeGuard.s.sol --rpc-url https://rpc.xlayer.tech --broadcast --slow
///
/// TapeOut fee rules (read live, never hard-coded): createCPU keeps any excess, mint traps
/// any excess, tapeout reverts unless the fee is exact, open and execute refund the excess.
contract LaunchTapeGuard is Script {
    address constant FACTORY = 0x1f09DAeFA827f02CBb40967cc91b259763760761;
    address constant OPENER = 0x536adD8F30f03b69f6fbF29d425A816A0dC50106;
    uint256 constant NAND = 0;
    uint256 constant EXEC_FEE_CAP = 0.002 ether; // execute refunds the excess over EXEC_FEE

    // Launch state, shared by the steps below (keeps every step small).
    address deployer;
    address relayer;
    address circuits;
    uint256 circuitId;
    address treasury;
    uint16 feeBps;
    address router;
    address usdt;
    PolicyCircuit policy;
    AgentContainer agent;
    address factory;
    address container;

    function run() external {
        require(block.chainid == 196, "X Layer mainnet (or a fork of it) only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(pk);
        relayer = vm.envAddress("RELAYER_ADDRESS");
        // TREASURY set: hosted terms (activation + PROTOCOL_FEE_BPS go to the treasury).
        treasury = vm.envOr("TREASURY", address(0));
        feeBps = treasury == address(0) ? 0 : uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(10)));
        router = vm.envOr("ROUTER", address(0));
        usdt = vm.envOr("USDT", address(0));

        vm.startBroadcast(pk);
        (circuits, circuitId) = _guardCircuit(deployer);
        _deployAndWire();
        _activateAndFund();
        if (vm.envOr("DEPLOY_FACTORY", false)) _deployFactory();
        if (vm.envOr("HANDOVER_TO_TAPEOUT_CONTAINER", false)) {
            container = _handover(circuits, circuitId, policy, agent);
        }
        vm.stopBroadcast();
        _report();
    }

    function _deployAndWire() internal {
        policy = new PolicyCircuit(deployer);
        agent = new AgentContainer(deployer, treasury, feeBps);
        agent.setPolicy(address(policy));
        agent.setRelayer(relayer, true);
        policy.setAgent(address(agent), true);
        policy.setLimits(
            vm.envOr("MAX_PER_ACTION_WEI", uint256(0.05 ether)), vm.envOr("DAILY_LIMIT_WEI", uint256(0.25 ether))
        );
        policy.setMaxActionsPerDay(vm.envOr("MAX_ACTIONS_PER_DAY", uint256(6)));
        if (router != address(0)) {
            policy.setTarget(router, true, false);
            policy.setRouter(router, true);
            policy.setFunction(router, 0x7ff36ab5, true); // swapExactETHForTokens
            policy.setFunction(router, 0x18cbafe5, true); // swapExactTokensForETH
        }
        if (usdt != address(0)) {
            policy.setTarget(usdt, true, false);
            policy.setFunction(usdt, 0x095ea7b3, true); // approve (spender must be a registered router)
            policy.setTokenLimit(
                usdt, true, vm.envOr("USDT_MAX_PER_ACTION", uint256(25e6)), vm.envOr("USDT_DAILY_LIMIT", uint256(100e6))
            );
        }
        policy.setTapeOutCircuit(circuits, circuitId);
    }

    function _activateAndFund() internal {
        if (vm.envOr("ACTIVATE", false)) agent.activate{value: agent.activationFee()}();
        uint256 fund = vm.envOr("FUND_WEI", uint256(0));
        if (fund > 0) {
            (bool ok,) = address(agent).call{value: fund}("");
            require(ok, "fund");
        }
    }

    /// One-click agents for everyone else, on the same circuit, venue and terms.
    function _deployFactory() internal {
        require(
            treasury != address(0) && router != address(0) && usdt != address(0), "factory needs TREASURY, ROUTER, USDT"
        );
        factory = address(
            new TapeGuardFactory(
                treasury, feeBps, circuits, circuitId, router, usdt, relayer, new PolicyCircuitDeployer()
            )
        );
    }

    function _report() internal view {
        console.log("TapeOut circuits (processor):", circuits);
        console.log("Guard circuit id:", circuitId);
        console.log("PolicyCircuit:", address(policy));
        console.log("AgentContainer:", address(agent));
        console.log("Owner:", container == address(0) ? deployer : container);
        console.log("Treasury (0 = self-hosted):", treasury);
        console.log("Protocol fee bps:", feeBps);
        if (factory != address(0)) console.log("TapeGuardFactory:", factory);
        console.log("Policy commitment:");
        console.logBytes32(policy.commitment());
    }

    /// Reuses TAPEOUT_CIRCUITS / TAPEOUT_CIRCUIT_ID, or creates processor + circuit.
    function _guardCircuit(address deployer) internal returns (address circuits, uint256 id) {
        circuits = vm.envOr("TAPEOUT_CIRCUITS", address(0));
        id = vm.envOr("TAPEOUT_CIRCUIT_ID", uint256(0));
        if (circuits != address(0)) {
            require(ITapeOutFactory(FACTORY).isCPU(circuits), "TAPEOUT_CIRCUITS is not a TapeOut processor");
            return (circuits, id);
        }

        // TAPEOUT_PROCESSOR: tape out on an existing processor instead of creating one.
        circuits = vm.envOr("TAPEOUT_PROCESSOR", address(0));
        address transistors;
        if (circuits == address(0)) {
            ITapeOutFactory factory = ITapeOutFactory(FACTORY);
            (transistors, circuits) = factory.createCPU{value: factory.deployFee()}(
                "TapeGuard",
                "TGRD",
                "Guard circuits for autonomous agent wallets: every trade an X Layer agent makes is judged by a taped-out circuit.",
                vm.envOr("CPU_SUPPLY", uint256(100_000)),
                vm.envOr("CPU_MINT_PRICE_WEI", uint256(0.00001 ether))
            );
        } else {
            transistors = ITapeOutCircuitsFull(circuits).transistors();
        }

        ITapeOutTransistors t = ITapeOutTransistors(transistors);
        uint256 have = t.balanceOf(deployer, NAND);
        if (have < GuardNetlist.GATES) {
            uint256 n = GuardNetlist.GATES - have;
            t.mint{value: n * t.mintPrice() + t.protocolFee()}(NAND, n);
        }
        ITapeOutCircuitsFull c = ITapeOutCircuitsFull(circuits);
        id = c.tapeout{value: c.TAPEOUT_FEE()}(GuardNetlist.NETLIST, GuardNetlist.N_IN, GuardNetlist.N_OUT);
    }

    /// Opens the guard circuit's own TapeOut container (ERC-6551 account) and makes it
    /// the owner of both contracts. Afterwards every owner call goes through
    /// container.execute(...) and costs TapeOut's EXEC_FEE.
    function _handover(address circuits, uint256 id, PolicyCircuit policy, AgentContainer agent)
        internal
        returns (address container)
    {
        ITapeOutOpener opener = ITapeOutOpener(OPENER);
        container = opener.accountOf(circuits, id);
        if (container == address(0)) container = opener.open{value: opener.FEE()}(circuits, id);
        agent.transferOwner(container);
        policy.transferOwner(container);
        ITapeOutAccount(container).execute{value: EXEC_FEE_CAP}(
            address(agent), 0, abi.encodeCall(AgentContainer.acceptOwner, ()), 0
        );
        ITapeOutAccount(container).execute{value: EXEC_FEE_CAP}(
            address(policy), 0, abi.encodeCall(PolicyCircuit.acceptOwner, ()), 0
        );
        require(agent.owner() == container && policy.owner() == container, "handover");
    }
}
