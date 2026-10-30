// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VRFV2PlusWrapperConsumerBase} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFV2PlusWrapperConsumerBase.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RSGP CASINO — apostas PvP 1x1 em $RSGP
 * @notice
 *  - Jogador A cria uma aposta: escolhe o valor e um lado (0 ou 1) e deposita os RSGP.
 *  - Jogador B entra no lado oposto depositando o mesmo valor e paga a taxa do Chainlink VRF em ETH.
 *  - O Chainlink VRF v2.5 sorteia o lado vencedor. Quem ganhar leva 100% (2x o valor).
 *
 *  Custos:
 *  - Sem dono, sem taxa da casa, sem assinatura de VRF pra manter.
 *  - O VRF usa "direct funding": quem entra na aposta paga a taxa do sorteio em ETH na própria transação.
 *    O dono do site não paga nada além do deploy.
 *  - O callback do VRF só grava o resultado (gás mínimo = taxa de VRF mínima).
 *    O pagamento do prêmio é feito em `settle`, que qualquer um pode chamar.
 *  - Se o VRF não responder em 24h, qualquer um pode chamar `refundStuck` e os dois recebem de volta.
 */
contract RSGPCasino is VRFV2PlusWrapperConsumerBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open, // esperando adversário
        Rolling, // adversário entrou, esperando o VRF
        Decided, // VRF respondeu, prêmio pronto pra ser pago
        Paid, // prêmio pago
        Cancelled // cancelada / reembolsada
    }

    struct Game {
        // slot 0
        address creator;
        uint96 amount; // valor de CADA lado (prêmio = 2x)
        // slot 1
        address joiner;
        uint8 creatorSide; // 0 ou 1
        Status status;
        uint8 winningSide; // 0 ou 1 (válido a partir de Decided)
        uint40 updatedAt;
    }

    uint16 public constant REQUEST_CONFIRMATIONS = 1;
    uint32 public constant NUM_WORDS = 1;
    uint256 public constant STUCK_TIMEOUT = 1 days;

    IERC20 public immutable token;
    uint32 public immutable callbackGasLimit;
    uint256 public immutable minBet;

    Game[] private _games;
    /// @dev requestId do VRF => gameId + 1 (0 = inexistente)
    mapping(uint256 => uint256) public requestToGame;

    event GameCreated(uint256 indexed id, address indexed creator, uint256 amount, uint8 side);
    event GameCancelled(uint256 indexed id);
    event GameJoined(uint256 indexed id, address indexed joiner, uint256 requestId, uint256 vrfFee);
    event GameDecided(uint256 indexed id, uint8 winningSide, address indexed winner);
    event GamePaid(uint256 indexed id, address indexed winner, uint256 payout);
    event GameRefunded(uint256 indexed id);

    error BadSide();
    error BadAmount();
    error NotFound();
    error WrongStatus();
    error NotCreator();
    error SelfPlay();
    error VrfFeeTooLow(uint256 required);
    error TooEarly();
    error RefundFailed();

    constructor(address wrapper, address token_, uint32 callbackGasLimit_, uint256 minBet_)
        VRFV2PlusWrapperConsumerBase(wrapper)
    {
        token = IERC20(token_);
        callbackGasLimit = callbackGasLimit_;
        minBet = minBet_;
    }

    // ───────────────────────────── ações ─────────────────────────────

    function createGame(uint256 amount, uint8 side) external nonReentrant returns (uint256 id) {
        if (side > 1) revert BadSide();
        if (amount < minBet || amount > type(uint96).max) revert BadAmount();

        id = _games.length;
        _games.push(
            Game({
                creator: msg.sender,
                amount: uint96(amount),
                joiner: address(0),
                creatorSide: side,
                status: Status.Open,
                winningSide: 0,
                updatedAt: uint40(block.timestamp)
            })
        );
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit GameCreated(id, msg.sender, amount, side);
    }

    function cancelGame(uint256 id) external nonReentrant {
        Game storage g = _get(id);
        if (g.status != Status.Open) revert WrongStatus();
        if (msg.sender != g.creator) revert NotCreator();
        g.status = Status.Cancelled;
        g.updatedAt = uint40(block.timestamp);
        token.safeTransfer(g.creator, g.amount);
        emit GameCancelled(id);
    }

    /// @notice Entra no lado oposto. Envie em msg.value pelo menos a taxa do VRF; o excesso é devolvido.
    function joinGame(uint256 id) external payable nonReentrant {
        Game storage g = _get(id);
        if (g.status != Status.Open) revert WrongStatus();
        if (msg.sender == g.creator) revert SelfPlay();

        uint256 fee = i_vrfV2PlusWrapper.calculateRequestPriceNative(callbackGasLimit, NUM_WORDS);
        if (msg.value < fee) revert VrfFeeTooLow(fee);

        g.joiner = msg.sender;
        g.status = Status.Rolling;
        g.updatedAt = uint40(block.timestamp);

        token.safeTransferFrom(msg.sender, address(this), g.amount);

        (uint256 requestId, uint256 paid) = requestRandomnessPayInNative(
            callbackGasLimit,
            REQUEST_CONFIRMATIONS,
            NUM_WORDS,
            VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
        );
        requestToGame[requestId] = id + 1;
        emit GameJoined(id, msg.sender, requestId, paid);

        uint256 change = msg.value - paid;
        if (change > 0) {
            (bool ok,) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Paga o prêmio ao vencedor. Qualquer um pode chamar.
    function settle(uint256 id) external nonReentrant {
        Game storage g = _get(id);
        if (g.status != Status.Decided) revert WrongStatus();
        g.status = Status.Paid;
        g.updatedAt = uint40(block.timestamp);
        address winner = g.winningSide == g.creatorSide ? g.creator : g.joiner;
        uint256 payout = uint256(g.amount) * 2;
        token.safeTransfer(winner, payout);
        emit GamePaid(id, winner, payout);
    }

    /// @notice Se o VRF não responder em 24h, devolve os RSGP dos dois jogadores. Qualquer um pode chamar.
    function refundStuck(uint256 id) external nonReentrant {
        Game storage g = _get(id);
        if (g.status != Status.Rolling) revert WrongStatus();
        if (block.timestamp < uint256(g.updatedAt) + STUCK_TIMEOUT) revert TooEarly();
        g.status = Status.Cancelled;
        g.updatedAt = uint40(block.timestamp);
        token.safeTransfer(g.creator, g.amount);
        token.safeTransfer(g.joiner, g.amount);
        emit GameRefunded(id);
    }

    /// @dev Callback do VRF: só grava o resultado (barato de propósito).
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        uint256 idPlusOne = requestToGame[requestId];
        if (idPlusOne == 0) return;
        delete requestToGame[requestId];

        Game storage g = _games[idPlusOne - 1];
        if (g.status != Status.Rolling) return; // já reembolsada

        uint8 side = uint8(randomWords[0] & 1);
        g.winningSide = side;
        g.status = Status.Decided;
        g.updatedAt = uint40(block.timestamp);
        emit GameDecided(idPlusOne - 1, side, side == g.creatorSide ? g.creator : g.joiner);
    }

    // ───────────────────────────── leitura ─────────────────────────────

    function gamesCount() external view returns (uint256) {
        return _games.length;
    }

    function getGame(uint256 id) external view returns (Game memory) {
        return _get(id);
    }

    /// @notice Retorna até `count` apostas a partir de `start` (para a lista do site).
    function getGames(uint256 start, uint256 count) external view returns (Game[] memory out) {
        uint256 len = _games.length;
        if (start >= len) return new Game[](0);
        uint256 end = start + count > len ? len : start + count;
        out = new Game[](end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = _games[i];
        }
    }

    /// @notice Estimativa da taxa do VRF (em wei) para um preço de gás.
    function quoteVrfFee(uint256 gasPriceWei) external view returns (uint256) {
        return i_vrfV2PlusWrapper.estimateRequestPriceNative(callbackGasLimit, NUM_WORDS, gasPriceWei);
    }

    function _get(uint256 id) private view returns (Game storage g) {
        if (id >= _games.length) revert NotFound();
        g = _games[id];
    }
}
