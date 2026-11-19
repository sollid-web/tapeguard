// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/PolicyCircuit.sol";
import "../contracts/GuardNetlist.sol";

interface ITapeOutRead {
    function netlist(uint256 id) external view returns (bytes memory);
}

/// Checks the REAL taped-out guard circuit on X Layer mainnet. Skipped unless
/// TAPEOUT_CIRCUITS and TAPEOUT_CIRCUIT_ID are set. Run:
///   TAPEOUT_CIRCUITS=0x... TAPEOUT_CIRCUIT_ID=n \
///   forge test --match-contract TapeOutForkTest --fork-url https://rpc.xlayer.tech -vv
contract TapeOutForkTest is Test {
    address circuits;
    uint256 id;

    function setUp() public {
        circuits = vm.envOr("TAPEOUT_CIRCUITS", address(0));
        id = vm.envOr("TAPEOUT_CIRCUIT_ID", uint256(0));
    }

    function testLiveCircuitIsTheGuardNetlist() public {
        if (circuits == address(0)) return;
        assertEq(block.chainid, 196, "fork X Layer mainnet");
        assertEq(keccak256(ITapeOutRead(circuits).netlist(id)), keccak256(GuardNetlist.NETLIST), "netlist differs");
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gates) = ITapeOutCircuits(circuits).circuitInfo(id);
        assertEq(nIn, GuardNetlist.N_IN);
        assertEq(nOut, GuardNetlist.N_OUT);
        assertEq(nState, 0);
        assertEq(gates, GuardNetlist.GATES);
    }

    function testLiveEvalMatchesSpecOnAllFactVectors() public {
        if (circuits == address(0)) return;
        PolicyCircuit policy = new PolicyCircuit(address(this));
        policy.setTapeOutCircuit(circuits, id);
        for (uint256 bits; bits < 1024; bits++) {
            (bool ok, bool approves) = policy.evalCircuit(bits);
            assertTrue(ok, "eval failed");
            bool expected = bits & 0xff == 0xff && (bits >> 8) & 3 != 3;
            assertEq(approves, expected, vm.toString(bits));
        }
        emit log_named_uint("eval verified on fact vectors", 1024);
    }
}
