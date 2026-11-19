// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test stand-in for a TapeOut circuits (processor) contract. It stores NAND-only
/// netlists and evaluates them with TapeOut's semantics: constants on signals 0/1,
/// inputs from signal 2, LSB-first packing, the last nOut signals are the outputs.
/// `mode` lets a test simulate an outage or a hostile upgrade.
contract TapeOutCircuitsMock {
    enum Mode {
        Honest,
        Reverts,
        AlwaysApprove,
        Garbage
    }

    struct Info {
        uint32 nIn;
        uint32 nOut;
    }

    Mode public mode;
    uint256 public nextId;
    mapping(uint256 => bytes) internal _netlists;
    mapping(uint256 => Info) internal _info;

    function setMode(Mode m) external {
        mode = m;
    }

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable virtual returns (uint256 id) {
        id = _store(nl, nIn, nOut);
    }

    function _store(bytes calldata nl, uint32 nIn, uint32 nOut) internal returns (uint256 id) {
        require(nl.length % 7 == 0, "nand only");
        id = ++nextId;
        _netlists[id] = nl;
        _info[id] = Info(nIn, nOut);
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        return _netlists[id];
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Info memory i = _info[id];
        require(i.nOut != 0, "no circuit");
        return (i.nIn, i.nOut, 0, uint32(_netlists[id].length / 7));
    }

    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory out) {
        if (mode == Mode.Reverts) revert("tapeout down");
        if (mode == Mode.AlwaysApprove) return hex"01";
        if (mode == Mode.Garbage) {
            assembly {
                mstore(0, 0xdead)
                return(0, 32)
            }
        }
        Info memory info = _info[id];
        require(info.nOut != 0, "no circuit");
        bytes memory nl = _netlists[id];
        uint256 gates = nl.length / 7;
        uint8[] memory sig = new uint8[](2 + info.nIn + gates);
        sig[1] = 1;
        for (uint256 i; i < info.nIn; i++) {
            sig[2 + i] = (i >> 3) < inputs.length ? (uint8(inputs[i >> 3]) >> (i & 7)) & 1 : 0;
        }
        uint256 s = 2 + info.nIn;
        for (uint256 g; g < gates; g++) {
            uint256 off = g * 7;
            uint256 a = (uint256(uint8(nl[off + 1])) << 16) | (uint256(uint8(nl[off + 2])) << 8) | uint8(nl[off + 3]);
            uint256 b = (uint256(uint8(nl[off + 4])) << 16) | (uint256(uint8(nl[off + 5])) << 8) | uint8(nl[off + 6]);
            require(a < s && b < s, "NAND: future signal");
            sig[s++] = 1 - (sig[a] & sig[b]);
        }
        out = new bytes((info.nOut + 7) >> 3);
        for (uint256 i; i < info.nOut; i++) {
            if (sig[s - info.nOut + i] == 1) out[i >> 3] = bytes1(uint8(out[i >> 3]) | uint8(1 << (i & 7)));
        }
    }
}
