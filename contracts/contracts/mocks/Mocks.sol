// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Apenas para testes locais.
contract MockRSGP is ERC20 {
    constructor() ERC20("Mock RSGP", "RSGP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IWrapperConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

/// @dev Imita o VRFV2PlusWrapper da Chainlink (direct funding em ETH). Apenas para testes locais.
contract MockVRFWrapper {
    uint256 public fee = 0.00002 ether;
    address public link = address(0xdead);
    uint256 public lastRequestId;
    mapping(uint256 => address) public consumerOf;

    function setFee(uint256 f) external {
        fee = f;
    }

    function calculateRequestPriceNative(uint32, uint32) external view returns (uint256) {
        return fee;
    }

    function estimateRequestPriceNative(uint32, uint32, uint256) external view returns (uint256) {
        return fee;
    }

    function requestRandomWordsInNative(uint32, uint16, uint32, bytes calldata)
        external
        payable
        returns (uint256 requestId)
    {
        require(msg.value == fee, "fee");
        requestId = ++lastRequestId;
        consumerOf[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word, uint256 gasLimit) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IWrapperConsumer(consumerOf[requestId]).rawFulfillRandomWords{gas: gasLimit}(requestId, words);
    }
}
