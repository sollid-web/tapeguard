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
///
///         Swap rule (v2): a router call must pay its output to the agent itself and must
///         carry a non-zero minimum output. The standard UniswapV2-style swap selectors
///         are checked on every target and cannot be switched off; other routers need an
///         explicit {setSwapShape}. A leaked keeper key therefore cannot route swap
///         proceeds to itself, nor sell into a sandwich with `amountOutMin = 0`.
///
///         TapeOut gate (v2): every action is reduced to a vector of fact bits (see
///         `FACT_*`). Solidity enforces the safety facts as a floor; when a TapeOut
///         circuit is linked, the circuit's `eval()` over the full fact vector is the
///         final verdict. A TapeOut outage or a hostile upgrade can only make the gate
///         fail closed (CIRCUIT_UNAVAILABLE / CIRCUIT_REJECTED) - it can never approve an
///         action the floor rejected, because the floor is checked first.
interface ITapeOutCircuits {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}

contract PolicyCircuit {
    // ----------------------------------------------------------- custom errors
    error NotOwner();
    error ZeroAddress();
    error InvalidLimits();
    error AgentNotAuthorised();
    error NonceMismatch();
    error SpendAboveLimit();
    error ActionsAboveLimit();
    error TokenAboveLimit();
    error NotAContract();
    error BadCircuit();
    error BadSwapShape();

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
    event SwapShapeSet(
        address indexed target, bytes4 indexed selector, bool known, uint8 recipientArg, uint8 minOutArg
    );
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerChanged(address indexed from, address indexed to);
    event TapeOutCircuitSet(address indexed circuits, uint256 indexed circuitId);
    event ExecutionRecorded(address indexed agent, uint256 nonce, uint256 value, address token, uint256 tokenAmount);

    struct TokenRule {
        bool enabled;
        uint256 maxPerAction;
        uint256 dailyLimit;
    }

    /// Where a router function keeps its recipient and minimum-output arguments
    /// (0-based ABI head word index after the selector). `minOutArg = NO_MIN_OUT_ARG`
    /// means the function has no minimum-output argument.
    struct SwapShape {
        bool known;
        uint8 recipientArg;
        uint8 minOutArg;
    }

    uint8 public constant NO_MIN_OUT_ARG = type(uint8).max;

    // Fact bits handed to the TapeOut circuit, LSB first (TapeOut packs pins LSB-first).
    uint256 public constant FACT_NOT_PAUSED = 0;
    uint256 public constant FACT_AGENT_AUTHORISED = 1;
    uint256 public constant FACT_TARGET_ALLOWED = 2;
    uint256 public constant FACT_FUNCTION_ALLOWED = 3;
    uint256 public constant FACT_RECIPIENT_SAFE = 4;
    uint256 public constant FACT_WITHIN_PER_ACTION = 5;
    uint256 public constant FACT_WITHIN_DAILY = 6;
    uint256 public constant FACT_WITHIN_ACTION_COUNT = 7;
    uint256 public constant FACT_LARGE_ACTION = 8;
    uint256 public constant FACT_BUDGET_HALF_USED = 9;
    uint32 public constant FACT_COUNT = 10;
    /// Gas cap for one TapeOut eval (the guard circuit is 17 NAND gates).
    uint256 public constant EVAL_GAS = 1_500_000;

    /// TapeOut circuits contract (a processor registered in the TapeOut factory) and
    /// the id of the taped-out guard circuit. Zero address = no circuit linked.
    address public tapeoutCircuits;
    uint256 public tapeoutCircuitId;

    /// Identity of the policy circuit implemented by this processor.
    bytes32 public constant CIRCUIT_ID = keccak256("tapeout.policy.circuit.v1");
    string public constant VERSION = "2.0.0";

    /// Owner of the policy: ideally the user's TapeOut circuit container (the circuit
    /// NFT's ERC-6551 account). Handed over in two steps, see {transferOwner}.
    address public owner;
    address public pendingOwner;

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
    /// target => selector => custom recipient / min-out layout
    mapping(address => mapping(bytes4 => SwapShape)) private _swapShapes;

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
    ///         The Solidity floor runs first; if it passes and a TapeOut circuit is
    ///         linked, the circuit's verdict over the fact vector decides.
    /// @return approved true when the action may be executed
    /// @return reason short machine readable reason code
    function check(address agent, address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool approved, string memory reason)
    {
        uint256 bits;
        (bits, reason) = _facts(agent, target, value, data);
        if (bytes(reason).length != 0) return (false, reason);
        if (tapeoutCircuits != address(0)) {
            (bool ok, bool verdict) = _circuitVerdict(bits);
            if (!ok) return (false, "CIRCUIT_UNAVAILABLE");
            if (!verdict) return (false, "CIRCUIT_REJECTED");
        }
        return (true, "OK");
    }

    /// @notice The full decision trace for one proposed action: every fact bit, the
    ///         Solidity floor's result and the linked TapeOut circuit's verdict on the
    ///         very same bits. The dashboard shows this; anybody can call it.
    /// @dev    The circuit is evaluated even when the floor fails, so the trace shows
    ///         what the circuit itself says about a bad action.
    function trace(address agent, address target, uint256 value, bytes calldata data)
        external
        view
        returns (
            uint256 facts_,
            bool floorOk,
            string memory floorReason,
            bool circuitLinked,
            bool circuitOk,
            bool circuitApproves
        )
    {
        (facts_, floorReason) = _facts(agent, target, value, data);
        floorOk = bytes(floorReason).length == 0;
        circuitLinked = tapeoutCircuits != address(0);
        if (circuitLinked) (circuitOk, circuitApproves) = _circuitVerdict(facts_);
    }

    /// @notice Runs the linked TapeOut circuit on an arbitrary fact vector.
    function evalCircuit(uint256 facts_) external view returns (bool ok, bool approves) {
        if (tapeoutCircuits == address(0)) return (false, false);
        return _circuitVerdict(facts_);
    }

    /// @notice The recipient / min-out layout enforced for `selector` on `target`.
    function swapShape(address target, bytes4 selector)
        external
        view
        returns (bool known, uint8 recipientArg, uint8 minOutArg)
    {
        SwapShape memory sh = _shape(target, selector);
        return (sh.known, sh.recipientArg, sh.minOutArg);
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
            // Defense in depth: the container already asked checkToken, but the record
            // must hold on its own, exactly like the native budget above.
            TokenRule storage rule = _tokenRules[token];
            if (paused || !rule.enabled || tokenAmount > rule.maxPerAction) revert TokenAboveLimit();
            if (_tokenSpendDay[msg.sender][token] != today) {
                _tokenSpendDay[msg.sender][token] = today;
                _tokenSpent[msg.sender][token] = 0;
            }
            _tokenSpent[msg.sender][token] += tokenAmount;
            if (_tokenSpent[msg.sender][token] > rule.dailyLimit) revert TokenAboveLimit();
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
        return _computeCommitment();
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
    /// @notice Starts handing the policy to `next` (e.g. a TapeOut circuit container).
    ///         Nothing changes until `next` calls {acceptOwner}.
    function transferOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnerTransferStarted(owner, next);
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

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

    /// @notice Declares where a router function keeps its recipient and minimum
    ///         output, so {check} can require `recipient == agent` and `minOut > 0`.
    ///         Needed for any router function that is not a standard UniswapV2 swap;
    ///         the V2 layouts are built in and cannot be weakened by this call.
    /// @param  minOutArg head word index of the minimum output, or NO_MIN_OUT_ARG
    function setSwapShape(address target, bytes4 selector, bool known, uint8 recipientArg, uint8 minOutArg)
        external
        onlyOwner
    {
        if (target == address(0)) revert ZeroAddress();
        if (known && (recipientArg >= 32 || (minOutArg != NO_MIN_OUT_ARG && minOutArg >= 32))) {
            revert BadSwapShape();
        }
        _swapShapes[target][selector] = known ? SwapShape(true, recipientArg, minOutArg) : SwapShape(false, 0, 0);
        whitelistHash = keccak256(abi.encode(whitelistHash, uint8(6), target, selector, known, recipientArg, minOutArg));
        _bumpCommitment();
        emit SwapShapeSet(target, selector, known, recipientArg, minOutArg);
    }

    /// @notice Links the taped-out TapeOut guard circuit. `circuits` must be a TapeOut
    ///         circuits (processor) contract and `circuitId` a combinational circuit
    ///         with FACT_COUNT inputs and at least one output. Pass address(0) to unlink
    ///         (the escape hatch if TapeOut itself becomes unavailable).
    function setTapeOutCircuit(address circuits, uint256 circuitId) external onlyOwner {
        if (circuits != address(0)) {
            if (circuits.code.length == 0) revert NotAContract();
            (uint32 nIn, uint32 nOut, uint32 nState,) = ITapeOutCircuits(circuits).circuitInfo(circuitId);
            if (nIn != FACT_COUNT || nOut == 0 || nState != 0) revert BadCircuit();
        } else {
            circuitId = 0;
        }
        tapeoutCircuits = circuits;
        tapeoutCircuitId = circuitId;
        _bumpCommitment();
        emit TapeOutCircuitSet(circuits, circuitId);
    }

    // -------------------------------------------------------------- internals
    /// Builds the fact vector and the first failing floor reason ("" when the floor passes).
    /// Reasons keep v1's order so existing callers see the same codes.
    function _facts(address agent, address target, uint256 value, bytes calldata data)
        private
        view
        returns (uint256 bits, string memory reason)
    {
        bool fnOk;
        string memory fnReason;
        if (data.length == 0) {
            fnOk = allowPlainTransfer[target];
            fnReason = "PLAIN_TRANSFER_NOT_ALLOWED";
        } else if (data.length < 4) {
            fnReason = "BAD_CALLDATA";
        } else {
            fnOk = anyFunction[target] || allowedFunctions[target][_selector(data)];
            fnReason = "FUNCTION_NOT_ALLOWED";
        }
        string memory recipientReason = _recipientReason(agent, target, data);
        uint256 alreadySpent = _spentToday(agent);
        bool withinDaily = alreadySpent + value <= dailyLimit;
        bool withinCount = _actionsToday(agent) < maxActionsPerDay;

        if (!paused) bits |= 1 << FACT_NOT_PAUSED;
        if (authorisedAgents[agent]) bits |= 1 << FACT_AGENT_AUTHORISED;
        if (target != address(0) && allowedTargets[target]) bits |= 1 << FACT_TARGET_ALLOWED;
        if (fnOk) bits |= 1 << FACT_FUNCTION_ALLOWED;
        if (bytes(recipientReason).length == 0) bits |= 1 << FACT_RECIPIENT_SAFE;
        if (value <= maxPerAction) bits |= 1 << FACT_WITHIN_PER_ACTION;
        if (withinDaily) bits |= 1 << FACT_WITHIN_DAILY;
        if (withinCount) bits |= 1 << FACT_WITHIN_ACTION_COUNT;
        if (value * 2 > maxPerAction) bits |= 1 << FACT_LARGE_ACTION;
        if (alreadySpent * 2 >= dailyLimit) bits |= 1 << FACT_BUDGET_HALF_USED;

        if (paused) return (bits, "PAUSED");
        if (!authorisedAgents[agent]) return (bits, "AGENT_NOT_AUTHORISED");
        if (target == address(0)) return (bits, "TARGET_ZERO");
        if (!allowedTargets[target]) return (bits, "TARGET_NOT_ALLOWED");
        if (!fnOk) return (bits, fnReason);
        if (bytes(recipientReason).length != 0) return (bits, recipientReason);
        if (value > maxPerAction) return (bits, "PER_ACTION_LIMIT");
        if (!withinDaily) return (bits, "DAILY_LIMIT");
        if (!withinCount) return (bits, "ACTION_LIMIT");
        return (bits, "");
    }

    /// "" when the call cannot redirect value away from the agent.
    function _recipientReason(address agent, address target, bytes calldata data) private view returns (string memory) {
        if (data.length < 4) return "";
        SwapShape memory sh = _shape(target, _selector(data));
        if (!sh.known) {
            // Every function of an authorised router must have a declared layout.
            return authorizedRouters[target] ? "RECIPIENT_UNCHECKED" : "";
        }
        uint256 last = sh.recipientArg;
        if (sh.minOutArg != NO_MIN_OUT_ARG && sh.minOutArg > last) last = sh.minOutArg;
        if (data.length < 4 + 32 * (last + 1)) return "BAD_CALLDATA";
        if (_word(data, sh.recipientArg) != uint256(uint160(agent))) return "RECIPIENT_NOT_AGENT";
        if (sh.minOutArg != NO_MIN_OUT_ARG && _word(data, sh.minOutArg) == 0) return "NO_MIN_OUT";
        return "";
    }

    /// Custom layout first, then the built-in UniswapV2 router layouts (on any target).
    function _shape(address target, bytes4 sel) private view returns (SwapShape memory sh) {
        sh = _swapShapes[target][sel];
        if (sh.known) return sh;
        // (amountOutMin|amountOut, path, to, deadline)
        if (sel == 0x7ff36ab5 || sel == 0xfb3bdb41 || sel == 0xb6f9de95) return SwapShape(true, 2, 0);
        // (amountIn, amountOutMin, path, to, deadline)
        if (sel == 0x18cbafe5 || sel == 0x38ed1739 || sel == 0x791ac947 || sel == 0x5c11d795) {
            return SwapShape(true, 3, 1);
        }
        // (amountOut, amountInMax, path, to, deadline)
        if (sel == 0x4a25d94a || sel == 0x8803dbee) return SwapShape(true, 3, 0);
        return SwapShape(false, 0, 0);
    }

    /// Calls TapeOut `eval(id, facts)`; ok = false on any failure (fail closed).
    function _circuitVerdict(uint256 bits) private view returns (bool ok, bool approves) {
        bytes memory input = new bytes(2);
        input[0] = bytes1(uint8(bits));
        input[1] = bytes1(uint8(bits >> 8));
        (bool success, bytes memory ret) = tapeoutCircuits.staticcall{gas: EVAL_GAS}(
            abi.encodeWithSelector(ITapeOutCircuits.eval.selector, tapeoutCircuitId, input)
        );
        if (!success || ret.length < 96) return (false, false);
        uint256 off;
        uint256 len;
        assembly {
            off := mload(add(ret, 32))
            len := mload(add(ret, 64))
        }
        if (off != 32 || len == 0 || len > ret.length - 64) return (false, false);
        return (true, uint8(ret[64]) & 1 == 1);
    }

    function _word(bytes calldata data, uint256 index) private pure returns (uint256 w) {
        uint256 offset = 4 + 32 * index;
        assembly {
            w := calldataload(add(data.offset, offset))
        }
    }

    function _bumpCommitment() private {
        revision += 1;
        commitment = _computeCommitment();
        emit CommitmentUpdated(commitment, revision, whitelistHash, tokenHash);
    }

    function _computeCommitment() private view returns (bytes32) {
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
                tokenHash,
                tapeoutCircuits,
                tapeoutCircuitId
            )
        );
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

    // The strict equality (==) here is intentional. `_day()` returns
    // block.timestamp / 1 days — a discrete integer that increments once per UTC
    // day. Comparing the stored day bucket against the current bucket is the
    // correct lazy-reset pattern: if the stored value is any value other than
    // today's bucket (including an older day or the zero default), the accumulator
    // is treated as zero and will be overwritten on the next recordExecution call.
    // A miner can only skew block.timestamp by ~15 seconds, which cannot cross a
    // day boundary (86 400 seconds), so the boundary cannot be manipulated to
    // reset the daily limit prematurely or to prevent it from resetting.
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
