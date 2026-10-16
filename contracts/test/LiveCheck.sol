// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RatUsdFeed} from "../RatUsdFeed.sol";

/// Never deployed: scripts/check-live.mjs runs this constructor with eth_call (no transaction, no
/// gas spent) on the real HyperEVM, to prove the feed against the real HyperCore precompile. It
/// builds a throwaway feed with itself as owner and reporter, then returns what happened.
contract LiveCheck {
  constructor(uint32 coreAsset, uint8 corePxDecimals) {
    address[] memory reporters = new address[](1);
    reporters[0] = address(this);

    RatUsdFeed feed = new RatUsdFeed(address(this), reporters, coreAsset, corePxDecimals, 1000, 300);
    uint256 mid = feed.coreMid();
    feed.transmit(int256(mid), uint32(block.timestamp));
    (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, ) = feed.latestRoundData();

    // twice the market must bounce off the guard with OffMarket
    RatUsdFeed other = new RatUsdFeed(address(this), reporters, coreAsset, corePxDecimals, 1000, 300);
    bool offMarket;
    try other.transmit(int256(mid * 2), uint32(block.timestamp)) {} catch (bytes memory reason) {
      offMarket = reason.length >= 4 && bytes4(reason) == RatUsdFeed.OffMarket.selector;
    }

    bytes memory out = abi.encode(mid, roundId, answer, startedAt, updatedAt, offMarket, block.number);
    assembly {
      return(add(out, 32), mload(out))
    }
  }
}
