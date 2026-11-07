// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal interface of the policy processor contract.
interface IPolicyCircuit {
    function check(address agent, address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool approved, string memory reason);

    function checkToken(address agent, address token, uint256 amount)
        external
        view
        returns (bool approved, string memory reason);

    function recordExecution(uint256 agentNonce, uint256 value, address token, uint256 tokenAmount) external;

    function authorizedRouters(address router) external view returns (bool);
}

/// @title AgentContainer
/// @notice The on-chain body of an autonomous TapeGuardian agent: a keyless account that
///         holds the funds and is the address that actually executes approved
///         transactions. It never holds a private key - every action passes through
///         the policy circuit first, and only the owner (the user's TapeOut circuit
///         container) or a relayer the owner authorised can ask it to execute.
/// @dev    The relayer (the always-on daemon) is a keeper, not a wallet: it can only
///         push an action the policy circuit approves at that moment, inside the
///         per-action, per-token and daily limits, and only while the agent is active.
///         It cannot withdraw, cannot change the policy, cannot unpause or re-authorise
///         anything, and holding its key is not holding the funds. Losing it stops the
///         agent; it never loses the money.
contract AgentContainer {
    // ----------------------------------------------------------- custom errors
    error NotOwner();
    error NotAuthorised();
    error ZeroAddress();
    error NotAContract();
    error AgentPaused();
    error NotActive();
    error PolicyNotSet();
    error PolicyRejected(string reason);
    error ExecutionFailed(bytes returndata);
    error FeeTooLow(uint256 required, uint256 sent);
    error InsufficientFees();
    error InsufficientBalance();
    error Reentrancy();
    error TransferFailed();
    error RouterNotAuthorised();
    error NonCanonicalTokenCalldata();

    // ----------------------------------------------------------------- events
    event Funded(address indexed from, uint256 amount);
    event RelayerSet(address indexed relayer, bool allowed);
    event PolicySet(address indexed policy);
    event PausedSet(bool paused);
    event ActivationFeeSet(uint256 amount);
    event Activated(address indexed payer, uint256 amount, uint256 activeUntil);
    event PolicyChecked(address indexed target, uint256 value, bytes4 selector, string reason);
    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes4 selector, bytes result);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerChanged(address indexed from, address indexed to);

    /// ERC-20 selectors that move tokens out of the container.
    bytes4 private constant SEL_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant SEL_INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 private constant SEL_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant SEL_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    /// Owner of the agent: the user's TapeOut circuit container. Mutable through a
    /// two-step handover, so control can follow the circuit container (or a new one)
    /// instead of being locked forever in an immutable address.
    address public owner;
    address public pendingOwner;

    /// Relayers the owner authorised to submit policy-approved actions while the
    /// owner is offline. A relayer is a keeper: no custody, no configuration rights.
    mapping(address => bool) public relayers;

    /// Policy processor contract that must approve every action.
    address public policy;
    bool public paused;

    /// Service fee that unlocks 30 days of daemon operation. Fees are collected
    /// inside the container and swept to the owner with {withdrawFees}.
    uint256 public activationFee;
    uint256 public constant ACTIVATION_PERIOD = 30 days;
    uint256 public activeUntil;
    uint256 public accruedFees;

    uint256 public executions;
    uint256 public nonce;
    uint256 public lastExecutionAt;

    uint256 private lock;

    // -------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev The owner and every authorised relayer may push an action. Both go
    ///      through the same policy check inside {execute}, so a relayer has no
    ///      more power than the circuit grants an execution.
    modifier onlyExecutor() {
        if (msg.sender != owner && !relayers[msg.sender]) revert NotAuthorised();
        _;
    }

    modifier nonReentrant() {
        if (lock == 1) revert Reentrancy();
        lock = 1;
        _;
        lock = 0;
    }

    // ------------------------------------------------------------ constructor
    /// @param owner_ the user's TapeOut circuit container that controls this agent.
    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        // 0.02 native token (OKB on X Layer) per 30 day activation period.
        activationFee = 0.02 ether;
        paused = false;
    }

    /// @notice Funding the container is a plain transfer - no signature, no key.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // -------------------------------------------------------------- execution
    /// @notice Executes an action on behalf of the agent. Reverts unless the agent is
    ///         active and the policy circuit approves the action, so a daemon bug - or
    ///         a leaked relayer key - can never spend more than the policy allows.
    /// @dev    Callable by the owner and by an authorised relayer (the always-on
    ///         daemon), which is what makes the agent autonomous: nobody has to be
    ///         around to press the button. The policy check, the token check, the spend
    ///         record and the call happen in one transaction: if the call fails, the
    ///         spend record is rolled back with it.
    ///         ERC-20 outflows (approve / increaseAllowance / transfer / transferFrom)
    ///         are additionally checked against the per-token limits, because those
    ///         calls carry `value = 0` and would otherwise escape the native budget.
    ///         Service fees are reserved: an execution can never spend `accruedFees`.
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyExecutor
        nonReentrant
        returns (bytes memory)
    {
        if (paused) revert AgentPaused();
        if (!isActive()) revert NotActive();

        address policyContract = policy;
        if (policyContract == address(0)) revert PolicyNotSet();

        // Native funds: the fee revenue stays reserved for withdrawFees().
        if (value > 0 && value > _available()) revert InsufficientBalance();

        _validateTokenCalldata(data);
        (address token, uint256 tokenAmount) = _tokenOutflow(target, data);
        if (_isApproval(data)) {
            address router = address(uint160(_word(data, 4)));
            if (!IPolicyCircuit(policyContract).authorizedRouters(router)) revert RouterNotAuthorised();
        }
        if (tokenAmount > 0) {
            (bool tokenOk, string memory tokenReason) =
                IPolicyCircuit(policyContract).checkToken(address(this), token, tokenAmount);
            if (!tokenOk) revert PolicyRejected(tokenReason);
        }

        (bool approved, string memory reason) = IPolicyCircuit(policyContract).check(address(this), target, value, data);
        if (!approved) revert PolicyRejected(reason);

        uint256 execNonce = nonce + 1;
        IPolicyCircuit(policyContract).recordExecution(execNonce, value, token, tokenAmount);

        nonce = execNonce;
        executions += 1;
        lastExecutionAt = block.timestamp;

        emit PolicyChecked(target, value, _selector(data), reason);

        (bool ok, bytes memory returndata) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed(returndata);

        emit Executed(execNonce, target, value, _selector(data), returndata);
        return returndata;
    }

    /// @notice Dry-run of exactly the check {execute} performs. Anyone can call it,
    ///         which is how the daemon and the dashboard preview a decision.
    function simulate(address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool approved, string memory reason)
    {
        if (paused) return (false, "AGENT_PAUSED");
        if (!isActive()) return (false, "NOT_ACTIVE");
        address policyContract = policy;
        if (policyContract == address(0)) return (false, "POLICY_NOT_SET");

        _validateTokenCalldata(data);
        (address token, uint256 tokenAmount) = _tokenOutflow(target, data);
        if (_isApproval(data)) {
            address router = address(uint160(_word(data, 4)));
            if (!IPolicyCircuit(policyContract).authorizedRouters(router)) return (false, "ROUTER_NOT_AUTHORISED");
        }
        if (tokenAmount > 0) {
            (bool tokenOk, string memory tokenReason) =
                IPolicyCircuit(policyContract).checkToken(address(this), token, tokenAmount);
            if (!tokenOk) return (false, tokenReason);
        }
        return IPolicyCircuit(policyContract).check(address(this), target, value, data);
    }

    // ------------------------------------------------------- owner-only setup
    /// @notice Starts a handover of control to `next` (usually a new circuit
    ///         container). Nothing changes until `next` calls {acceptOwner}, so a
    ///         typo cannot orphan the agent.
    function transferOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnerTransferStarted(owner, next);
    }

    /// @notice Completes a handover. Callable only by the address the previous owner
    ///         named - routed through your circuit container, like every other call.
    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(previous, owner);
    }

    function setPolicy(address policy_) external onlyOwner {
        if (policy_ == address(0)) revert ZeroAddress();
        if (policy_.code.length == 0) revert NotAContract();
        policy = policy_;
        emit PolicySet(policy_);
    }

    /// @notice Authorises (or removes) a relayer - the always-on daemon that keeps
    ///         the agent running while the owner is offline. A relayer can only push
    ///         policy-approved executions: it cannot withdraw funds, change the
    ///         policy, pause/unpause, move the activation fee or add other relayers.
    ///         Revoking it stops the agent instantly and costs nothing.
    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setActivationFee(uint256 fee) external onlyOwner {
        activationFee = fee;
        emit ActivationFeeSet(fee);
    }

    // ------------------------------------------------------------- commercial
    /// @notice Pays the service fee and unlocks (or extends) 30 days of operation.
    ///         Open to everyone; executions revert once the period has lapsed.
    function activate() external payable {
        uint256 required = activationFee;
        if (msg.value < required) revert FeeTooLow(required, msg.value);

        accruedFees += msg.value;
        uint256 base = activeUntil > block.timestamp ? activeUntil : block.timestamp;
        activeUntil = base + ACTIVATION_PERIOD;

        emit Activated(msg.sender, msg.value, activeUntil);
    }

    /// @notice Sweeps collected service fees to the owner (the TapeOut container).
    function withdrawFees(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > accruedFees) revert InsufficientFees();
        accruedFees -= amount;
        _send(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    /// @notice Withdraws the agent's own funds (revenue the strategies generated).
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > _available()) revert InsufficientBalance();
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------ views
    function isActive() public view returns (bool) {
        return block.timestamp < activeUntil;
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Funds not reserved for the service fee.
    function availableFunding() public view returns (uint256) {
        return _available();
    }

    /// @notice Everything the dashboard shows about the container in one call.
    function info()
        external
        view
        returns (
            address policy_,
            bool paused_,
            bool active_,
            uint256 activationFee_,
            uint256 activeUntil_,
            uint256 accruedFees_,
            uint256 executions_,
            uint256 nonce_
        )
    {
        return (
            policy, paused, block.timestamp < activeUntil, activationFee, activeUntil, accruedFees, executions, nonce
        );
    }

    // -------------------------------------------------------------- internals
    function _available() private view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > accruedFees ? bal - accruedFees : 0;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _isApproval(bytes calldata data) private pure returns (bool) {
        if (data.length < 4) return false;
        bytes4 sel = _selector(data);
        return sel == SEL_APPROVE || sel == SEL_INCREASE_ALLOWANCE;
    }

    /// @dev Sensitive ERC-20 calls must use canonical ABI calldata. Solidity token
    /// dispatchers commonly ignore trailing bytes, so accepting them here would let
    /// an otherwise valid token transfer evade the outflow accounting below.
    function _validateTokenCalldata(bytes calldata data) private pure {
        if (data.length < 4) return;
        bytes4 sel = _selector(data);
        uint256 expected = 0;
        if (sel == SEL_APPROVE || sel == SEL_INCREASE_ALLOWANCE || sel == SEL_TRANSFER) expected = 68;
        else if (sel == SEL_TRANSFER_FROM) expected = 100;
        if (expected != 0 && data.length != expected) revert NonCanonicalTokenCalldata();
    }

    /// @dev Detects an ERC-20 outflow hidden in the calldata: the token is the call
    ///      target itself, and the amount is the last argument of the call.
    ///      Returns (address(0), 0) when the call moves no tokens.
    function _tokenOutflow(address target, bytes calldata data) private pure returns (address token, uint256 amount) {
        if (data.length < 4) return (address(0), 0);
        bytes4 sel = _selector(data);
        if ((sel == SEL_APPROVE || sel == SEL_INCREASE_ALLOWANCE || sel == SEL_TRANSFER) && data.length == 68) {
            return (target, _word(data, 36));
        }
        if (sel == SEL_TRANSFER_FROM && data.length == 100) {
            return (target, _word(data, 68));
        }
        return (address(0), 0);
    }

    function _word(bytes calldata data, uint256 offset) private pure returns (uint256 w) {
        // data.length is always >= offset + 32 where this is used
        assembly {
            w := calldataload(add(data.offset, offset))
        }
    }

    function _selector(bytes calldata data) private pure returns (bytes4 s) {
        if (data.length < 4) return bytes4(0);
        s = bytes4(data[0]) | (bytes4(data[1]) >> 8) | (bytes4(data[2]) >> 16) | (bytes4(data[3]) >> 24);
    }
}
