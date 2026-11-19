// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/AgentContainer.sol";
import "../contracts/PolicyCircuit.sol";
import "../contracts/GuardNetlist.sol";
import "./mocks/TapeOutCircuitsMock.sol";

interface IV2Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
}

interface IV2Factory {
    function getPair(address a, address b) external view returns (address);
}

interface IV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
}

/// Proves the trading path on REAL X Layer liquidity: router sanity, pool depth for USDT
/// and USDT0, then a full TapeGuard round trip (OKB -> USDT -> OKB) through the policy and
/// the guard circuit. Skipped unless DEX_FORK=1. Run:
///   DEX_FORK=1 forge test --match-contract DexForkTest --fork-url https://rpc.xlayer.tech -vv
/// Optional: ROUTER=0x... (default: Uniswap V2 Router02 on X Layer),
///           TAPEOUT_CIRCUITS / TAPEOUT_CIRCUIT_ID to use the live guard circuit.
contract DexForkTest is Test {
    // Uniswap V2 on X Layer (developers.uniswap.org/docs/protocols/v2/deployments)
    address constant UNI_V2_ROUTER = 0x182a927119D56008d921126764bF884221b10f59;
    address constant UNI_V2_FACTORY = 0xDf38F24fE153761634Be942F9d859f3DBA857E95;
    // WOKB (Uniswap v3 X Layer deployments page)
    address constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;
    // USDT (bridged) and USDT0 on X Layer (BitGo / OKX)
    address constant USDT = 0x1E4a5963aBFD975d8c9021ce480b42188849D41d;
    address constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;

    address router;
    bool enabled;

    function setUp() public {
        enabled = vm.envOr("DEX_FORK", false);
        router = vm.envOr("ROUTER", UNI_V2_ROUTER);
    }

    function _depth(address factory, address usdt) internal view returns (address pair, uint256 usdtReserve) {
        pair = IV2Factory(factory).getPair(WOKB, usdt);
        if (pair == address(0)) return (pair, 0);
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        usdtReserve = IV2Pair(pair).token0() == usdt ? r0 : r1;
    }

    function testRouterAndPoolDepth() public {
        if (!enabled) return;
        assertEq(block.chainid, 196, "fork X Layer mainnet");
        address factory = IV2Router(router).factory();
        assertEq(IV2Router(router).WETH(), WOKB, "router's wrapped native is not WOKB");
        emit log_named_address("router", router);
        emit log_named_address("factory", factory);
        (address p1, uint256 d1) = _depth(factory, USDT);
        (address p2, uint256 d2) = _depth(factory, USDT0);
        emit log_named_address("WOKB/USDT pair", p1);
        emit log_named_decimal_uint("  USDT reserve", d1, 6);
        emit log_named_address("WOKB/USDT0 pair", p2);
        emit log_named_decimal_uint("  USDT0 reserve", d2, 6);
        assertTrue(d1 > 0 || d2 > 0, "no WOKB/USDT pool on this router");
    }

    AgentContainer agent;
    PolicyCircuit policy;
    address usdt;
    address constant OWNER = address(0xA11CE);
    address constant RELAYER = address(0x7E1A);

    function testFullRoundTripThroughTapeGuard() public {
        if (!enabled) return;
        _pickPool();
        _deployAndWire();
        uint256 got = _sell();
        _keeperTheftRefused();
        _buyBack(got);
    }

    function _pickPool() internal {
        address factory = IV2Router(router).factory();
        (, uint256 d1) = _depth(factory, USDT);
        (, uint256 d2) = _depth(factory, USDT0);
        usdt = d1 >= d2 ? USDT : USDT0;
        require((d1 >= d2 ? d1 : d2) >= 1_000e6, "pool too thin for a demo (< 1,000 USDT): use another router");
        emit log_named_address("trading against", usdt);
    }

    function _deployAndWire() internal {
        agent = new AgentContainer(OWNER, address(0), 0);
        policy = new PolicyCircuit(OWNER);
        address circuits = vm.envOr("TAPEOUT_CIRCUITS", address(0));
        uint256 circuitId = vm.envOr("TAPEOUT_CIRCUIT_ID", uint256(0));
        if (circuits == address(0)) {
            TapeOutCircuitsMock m = new TapeOutCircuitsMock();
            circuitId = m.tapeout(GuardNetlist.NETLIST, GuardNetlist.N_IN, GuardNetlist.N_OUT);
            circuits = address(m);
        }
        vm.startPrank(OWNER);
        agent.setPolicy(address(policy));
        agent.setRelayer(RELAYER, true);
        policy.setAgent(address(agent), true);
        policy.setLimits(0.05 ether, 0.25 ether);
        policy.setTarget(router, true, false);
        policy.setRouter(router, true);
        policy.setFunction(router, 0x7ff36ab5, true);
        policy.setFunction(router, 0x18cbafe5, true);
        policy.setTarget(usdt, true, false);
        policy.setFunction(usdt, 0x095ea7b3, true);
        policy.setTokenLimit(usdt, true, 1_000e6, 5_000e6);
        policy.setTapeOutCircuit(circuits, circuitId);
        vm.stopPrank();
        vm.deal(address(agent), 1 ether);
        agent.activate{value: agent.activationFee()}();
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
    }

    /// Sell 0.02 OKB for USDT, 2% slippage bound, output to the container.
    function _sell() internal returns (uint256 got) {
        uint256 quote = IV2Router(router).getAmountsOut(0.02 ether, _path(WOKB, usdt))[1];
        vm.prank(RELAYER);
        agent.execute(
            router,
            0.02 ether,
            abi.encodeWithSelector(
                0x7ff36ab5, quote * 98 / 100, _path(WOKB, usdt), address(agent), block.timestamp + 600
            )
        );
        got = IERC20View(usdt).balanceOf(address(agent));
        assertGe(got, quote * 98 / 100);
        emit log_named_decimal_uint("USDT received for 0.02 OKB", got, 6);
    }

    /// A keeper trying to take the output is refused on real liquidity too.
    function _keeperTheftRefused() internal {
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(AgentContainer.PolicyRejected.selector, "RECIPIENT_NOT_AGENT"));
        agent.execute(
            router,
            0.02 ether,
            abi.encodeWithSelector(0x7ff36ab5, uint256(1), _path(WOKB, usdt), RELAYER, block.timestamp + 600)
        );
    }

    /// Buy back: approve the router, swap USDT -> OKB.
    function _buyBack(uint256 got) internal {
        uint256 okbBefore = address(agent).balance;
        vm.prank(RELAYER);
        agent.execute(usdt, 0, abi.encodeWithSelector(0x095ea7b3, router, got));
        uint256 back = IV2Router(router).getAmountsOut(got, _path(usdt, WOKB))[1];
        vm.prank(RELAYER);
        agent.execute(
            router,
            0,
            abi.encodeWithSelector(
                0x18cbafe5, got, back * 98 / 100, _path(usdt, WOKB), address(agent), block.timestamp + 600
            )
        );
        assertGe(address(agent).balance - okbBefore, back * 98 / 100);
        emit log_named_decimal_uint("OKB back after round trip", address(agent).balance - okbBefore, 18);
    }
}
