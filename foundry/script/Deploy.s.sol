// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/PolicyCircuit.sol";
import "../contracts/AgentContainer.sol";

contract DeployPolicyCircuit is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("OWNER_ADDRESS", vm.addr(deployerPrivateKey));
        vm.startBroadcast(deployerPrivateKey);

        PolicyCircuit circuit = new PolicyCircuit(owner);
        console.log("PolicyCircuit deployed at:", address(circuit));

        vm.stopBroadcast();
    }
}

contract DeployAgentContainer is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("OWNER_ADDRESS", vm.addr(deployerPrivateKey));
        vm.startBroadcast(deployerPrivateKey);

        AgentContainer container = new AgentContainer(owner);
        console.log("AgentContainer deployed at:", address(container));

        vm.stopBroadcast();
    }
}
