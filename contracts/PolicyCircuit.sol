// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PolicyCircuit
/// @notice On-chain rule engine ("processor contract") for an autonomous TapeGuardian agent.
///         It mirrors the taped-out policy circuit: per-action and daily native limits,
///         per-token limits, target / function whitelists, a plain-transfer switch, a
///         pause flag and a per-agent execution nonce.
/// @dev    The circuit identity is `CIRCUIT_ID`. `commitment` is a fingerprint of the
///         current parameter revision *including* the whitelists and the token rules,
///         so anybody can recompute it and check that nothing was swapped.
///
///         Token rule: the native limit alone cannot bound a token position, because a
///         swap or an `approve` carries `value = 0`. The container therefore asks
///         {checkToken} before any ERC-20 outflow and records it with
///         {recordExecution}, so a leaked keeper key can move at most `dailyLimit` of
///         each whitelisted token per day.
contract PolicyCircuit {
    // ----------------------------------------------------------- custom errors
    error NotOwner();
    error ZeroAddress();
    error InvalidLimits();
    error AgentNotAuthorised();
    error NonceMismatch();
    error SpendAboveLimit();
    error ActionsAboveLimit();

    // ----------------------------------------------------------------- events
    event CircuitLinked(bytes32 indexed circuitId, string version);
    event CommitmentUpdated(bytes32 indexed commitment, uint256 revision, bytes32 whitelistHash, bytes32 tokenHash);
    event LimitsSet(uint256 maxPerAction, uint256 dailyLimit);
    event MaxActionsPerDaySet(uint256 maxActionsPerDay);
    event PausedSet(bool paused);
    event TargetSet(address indexed target, bool allowed, bool anyFunction);
    event RouterSet(address indexed router, bool allowed);
    event FunctionSet(address indexed target, bytes4 indexed selector, bool allowed);
    event PlainTransferSet(address indexed target, bool allowed);
    event AgentSet(address indexed agent, bool authorised);
    event TokenLimitSet(address indexed token, bool enabled, uint256 maxPerAction, uint256 dailyLimit);
    event SpendRecorded(address indexed agent, uint256 value, uint256 dayTotal);
    event TokenSpendRecorded(address indexed agent, address indexed token, uint256 amount, uint256 dayTotal);
    event ExecutionRecorded(address indexed agent, uint256 nonce, uint256 value, address token, uint256 tokenAmount);

    struct TokenRule {
        bool enabled;
        uint256 maxPerAction;
        uint256 dailyLimit;
    }

    /// Identity of the policy circuit implemented by this processor.
    bytes32 public constant CIRCUIT_ID = keccak256("tapeout.policy.circuit.v1");
    string public constant VERSION = "1.0.0";

    /// Owner of the policy: the user's TapeOut circuit container.
    address public immutable owner;

    bool public paused;
    uint256 public maxPerAction;
    uint256 public dailyLimit;
    uint256 public maxActionsPerDay;
    mapping(address => uint256) public actionDay;
    mapping(address => uint256) public actionsToday;

    /// Revision of the configuration, bumped on every parameter change.
    uint256 public revision;
    /// Fingerprint of the current configuration revision (parameters + whitelists).
    bytes32 public commitment;
    /// Rolling hash of targets, selectors, plain-transfer switches and agents.
    bytes32 public whitelistHash;
    /// Rolling hash of the token rules.
    bytes32 public tokenHash;

    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public authorizedRouters;
    /// target => every function of that target is allowed
    mapping(address => bool) public anyFunction;
    /// target => selector => allowed
    mapping(address => mapping(bytes4 => bool)) public allowedFunctions;
    /// target => a call with empty calldata (a plain transfer) is allowed
    mapping(address => bool) public allowPlainTransfer;
    /// container address => allowed to ask for a spend to be recorded
    mapping(address => bool) public authorisedAgents;

    mapping(address => uint256) public spentToday;
    mapping(address => uint256) public spendDay;

    /// token => limits. A token without an enabled rule cannot leave the container.
    mapping(address => TokenRule) private _tokenRules;
    mapping(address => mapping(address => uint256)) private _tokenSpent;
    mapping(address => mapping(address => uint256)) private _tokenSpendDay;

    /// agent => last execution nonce the circuit recorded for it.
    mapping(address => uint256) public lastNonce;

    // -------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!authorisedAgents[msg.sender]) revert AgentNotAuthorised();
        _;
    }

    // ------------------------------------------------------------ constructor
    /// @param owner_ the TapeOut circuit container that controls this policy.
    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;

        // Sensible MVP defaults: 0.05 native token per action, 0.25 per day.
        // Tokens stay closed until the owner whitelists one with setTokenLimit.
        maxPerAction = 0.05 ether;
        dailyLimit = 0.25 ether;
        maxActionsPerDay = 6;
        paused = false;

        whitelistHash = keccak256("tapeout.policy.whitelist.v1");
        tokenHash = keccak256("tapeout.policy.tokens.v1");

        _bumpCommitment();
        emit CircuitLinked(CIRCUIT_ID, VERSION);
    }

    // ----------------------------------------------------------- rule engine
    /// @notice Evaluates a proposed action against the policy. Pure view: no state
    ///         is touched, so the daemon can dry-run actions before submitting them.
    /// @return approved true when the action may be executed
    /// @return reason short machine readable reason code
    function check(address agent, address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool approved, string memory reason)
    {
        if (paused) return (false, "PAUSED");
        if (!authorisedAgents[agent]) return (false, "AGENT_NOT_AUTHORISED");
        if (target == address(0)) return (false, "TARGET_ZERO");
        if (!allowedTargets[target]) return (false, "TARGET_NOT_ALLOWED");

        if (data.length == 0) {
            // A plain transfer has no selector: it needs its own explicit opt-in.
            if (!allowPlainTransfer[target]) return (false, "PLAIN_TRANSFER_NOT_ALLOWED");
        } else if (data.length < 4) {
            return (false, "BAD_CALLDATA");
        } else {
            bytes4 sel = _selector(data);
            if (!anyFunction[target] && !allowedFunctions[target][sel]) {
                return (false, "FUNCTION_NOT_ALLOWED");
            }
        }

        if (value > maxPerAction) return (false, "PER_ACTION_LIMIT");

        uint256 alreadySpent = _spentToday(agent);
        if (alreadySpent + value > dailyLimit) return (false, "DAILY_LIMIT");
        if (_actionsToday(agent) >= maxActionsPerDay) return (false, "ACTION_LIMIT");

        return (true, "OK");
    }

    /// @notice Evaluates an ERC-20 outflow against the per-token limits. The agent
    ///         container asks this before it lets a token leave (directly or through
    ///         an allowance), so the daily budget also bounds token positions.
    ///         An amount of zero - an allowance reset - is always allowed.
    function checkToken(address agent, address token, uint256 amount)
        external
        view
        returns (bool approved, string memory reason)
    {
        if (paused) return (false, "PAUSED");
        if (!authorisedAgents[agent]) return (false, "AGENT_NOT_AUTHORISED");
        if (amount == 0) return (true, "OK_ZERO");
        TokenRule storage rule = _tokenRules[token];
        if (!rule.enabled) return (false, "TOKEN_NOT_ALLOWED");
        if (amount > rule.maxPerAction) return (false, "TOKEN_PER_ACTION_LIMIT");
        uint256 alreadySpent = _tokenSpentToday(agent, token);
        if (alreadySpent + amount > rule.dailyLimit) return (false, "TOKEN_DAILY_LIMIT");
        return (true, "OK");
    }

    /// @notice Records one execution. Called by the agent container in the same
    ///         transaction as the action itself, bound to the container's execution
    ///         nonce so a single approval cannot be replayed or inflated offline.
    function recordExecution(uint256 agentNonce, uint256 value, address token, uint256 tokenAmount) external onlyAgent {
        if (agentNonce != lastNonce[msg.sender] + 1) revert NonceMismatch();
        lastNonce[msg.sender] = agentNonce;

        if (value > maxPerAction) revert SpendAboveLimit();
        uint256 today = _day();
        if (spendDay[msg.sender] != today) {
            spendDay[msg.sender] = today;
            spentToday[msg.sender] = 0;
        }
        spentToday[msg.sender] += value;
        if (spentToday[msg.sender] > dailyLimit) revert SpendAboveLimit();
        if (actionDay[msg.sender] != today) {
            actionDay[msg.sender] = today;
            actionsToday[msg.sender] = 0;
        }
        actionsToday[msg.sender] += 1;
        if (actionsToday[msg.sender] > maxActionsPerDay) revert ActionsAboveLimit();
        emit SpendRecorded(msg.sender, value, spentToday[msg.sender]);

        if (token != address(0) && tokenAmount > 0) {
            if (_tokenSpendDay[msg.sender][token] != today) {
                _tokenSpendDay[msg.sender][token] = today;
                _tokenSpent[msg.sender][token] = 0;
            }
            _tokenSpent[msg.sender][token] += tokenAmount;
            emit TokenSpendRecorded(msg.sender, token, tokenAmount, _tokenSpent[msg.sender][token]);
        }

        emit ExecutionRecorded(msg.sender, agentNonce, value, token, tokenAmount);
    }

    // ------------------------------------------------------------------ views
    function remainingToday(address agent) external view returns (uint256) {
        uint256 alreadySpent = _spentToday(agent);
        return alreadySpent >= dailyLimit ? 0 : dailyLimit - alreadySpent;
    }

    /// @notice Per-token limits plus what this agent already spent today.
    function tokenView(address agent, address token)
        external
        view
        returns (bool enabled, uint256 maxPerAction_, uint256 dailyLimit_, uint256 spentToday_, uint256 remainingToday_)
    {
        TokenRule storage rule = _tokenRules[token];
        uint256 alreadySpent = _tokenSpentToday(agent, token);
        uint256 remaining = alreadySpent >= rule.dailyLimit ? 0 : rule.dailyLimit - alreadySpent;
        return (rule.enabled, rule.maxPerAction, rule.dailyLimit, alreadySpent, remaining);
    }

    /// @notice One call that returns everything a dashboard needs to display.
    function policyView(address agent)
        external
        view
        returns (
            bytes32 circuitId,
            bytes32 commitment_,
            bool paused_,
            uint256 maxPerAction_,
            uint256 dailyLimit_,
            uint256 spentToday_,
            uint256 remainingToday_
        )
    {
        uint256 alreadySpent = _spentToday(agent);
        uint256 remaining = alreadySpent >= dailyLimit ? 0 : dailyLimit - alreadySpent;
        return (CIRCUIT_ID, commitment, paused, maxPerAction, dailyLimit, alreadySpent, remaining);
    }

    /// @notice Recomputable fingerprint of the current policy: parameters, pause flag
    ///         and the rolling hashes of the whitelist and the token rules. A verifier
    ///         replays TargetSet / FunctionSet / PlainTransferSet / AgentSet /
    ///         TokenLimitSet events from `whitelistHash`'s seed to rebuild both hashes.
    function computeCommitment() external view returns (bytes32) {
        return keccak256(
            abi.encode(
                CIRCUIT_ID,
                VERSION,
                revision,
                paused,
                maxPerAction,
                dailyLimit,
                maxActionsPerDay,
                whitelistHash,
                tokenHash
            )
        );
    }

    /// @notice Everything that pins the policy in one call.
    function policyDigest()
        external
        view
        returns (
            bytes32 circuitId,
            bytes32 commitment_,
            bytes32 whitelistHash_,
            bytes32 tokenHash_,
            uint256 revision_,
            string memory version_
        )
    {
        return (CIRCUIT_ID, commitment, whitelistHash, tokenHash, revision, VERSION);
    }

    // ------------------------------------------------------- owner-only setup
    function setMaxActionsPerDay(uint256 maxActionsPerDay_) external onlyOwner {
        if (maxActionsPerDay_ == 0) revert InvalidLimits();
        maxActionsPerDay = maxActionsPerDay_;
        _bumpCommitment();
        emit MaxActionsPerDaySet(maxActionsPerDay_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        _bumpCommitment();
        emit PausedSet(paused_);
    }

    function setLimits(uint256 maxPerAction_, uint256 dailyLimit_) external onlyOwner {
        if (maxPerAction_ == 0 || dailyLimit_ < maxPerAction_) revert InvalidLimits();
        maxPerAction = maxPerAction_;
        dailyLimit = dailyLimit_;
        _bumpCommitment();
        emit LimitsSet(maxPerAction_, dailyLimit_);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        authorizedRouters[router] = allowed;
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(5), router, allowed));
        _bumpCommitment();
        emit RouterSet(router, allowed);
    }

    function setTarget(address target, bool allowed, bool anyFn) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTargets[target] = allowed;
        bool effectiveAny = allowed && anyFn;
        anyFunction[target] = effectiveAny;
        _rollTarget(target, allowed, effectiveAny);
        _bumpCommitment();
        emit TargetSet(target, allowed, effectiveAny);
    }

    function setFunction(address target, bytes4 selector, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedFunctions[target][selector] = allowed;
        _rollFunction(target, selector, allowed);
        _bumpCommitment();
        emit FunctionSet(target, selector, allowed);
    }

    /// @notice Allows (or blocks) a call with empty calldata to `target`, i.e. a plain
    ///         native transfer to a whitelisted address. Off by default.
    function setPlainTransfer(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowPlainTransfer[target] = allowed;
        _rollPlain(target, allowed);
        _bumpCommitment();
        emit PlainTransferSet(target, allowed);
    }

    function setAgent(address agent, bool authorised) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        authorisedAgents[agent] = authorised;
        _rollAgent(agent, authorised);
        _bumpCommitment();
        emit AgentSet(agent, authorised);
    }

    /// @notice Sets the per-action and daily limit of one ERC-20 token. Disabling a
    ///         token (or never enabling it) makes the container refuse to move it.
    function setTokenLimit(address token, bool enabled, uint256 maxPerAction_, uint256 dailyLimit_) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (enabled && (maxPerAction_ == 0 || dailyLimit_ < maxPerAction_)) revert InvalidLimits();
        _tokenRules[token] = TokenRule({enabled: enabled, maxPerAction: maxPerAction_, dailyLimit: dailyLimit_});
        _rollToken(token, enabled, maxPerAction_, dailyLimit_);
        _bumpCommitment();
        emit TokenLimitSet(token, enabled, maxPerAction_, dailyLimit_);
    }

    // -------------------------------------------------------------- internals
    function _bumpCommitment() private {
        revision += 1;
        commitment = keccak256(
            abi.encode(
                CIRCUIT_ID,
                VERSION,
                revision,
                paused,
                maxPerAction,
                dailyLimit,
                maxActionsPerDay,
                whitelistHash,
                tokenHash
            )
        );
        emit CommitmentUpdated(commitment, revision, whitelistHash, tokenHash);
    }

    function _rollTarget(address target, bool allowed, bool anyFn) private {
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(1), target, allowed, anyFn));
    }

    function _rollFunction(address target, bytes4 sel, bool allowed) private {
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(2), target, sel, allowed));
    }

    function _rollPlain(address target, bool allowed) private {
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(3), target, allowed));
    }

    function _rollAgent(address agent, bool allowed) private {
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(4), agent, allowed));
    }

    function _rollToken(address token, bool enabled, uint256 per, uint256 daily) private {
        tokenHash = keccak256(abi.encode(tokenHash, token, enabled, per, daily));
    }

    function _day() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _spentToday(address agent) private view returns (uint256) {
        return spendDay[agent] == _day() ? spentToday[agent] : 0;
    }

    function _tokenSpentToday(address agent, address token) private view returns (uint256) {
        return _tokenSpendDay[agent][token] == _day() ? _tokenSpent[agent][token] : 0;
    }

    function _actionsToday(address agent) private view returns (uint256) {
        return actionDay[agent] == _day() ? actionsToday[agent] : 0;
    }

    function _selector(bytes calldata data) private pure returns (bytes4 s) {
        if (data.length < 4) return bytes4(0);
        assembly {
            s := calldataload(data.offset)
        }
    }
}
