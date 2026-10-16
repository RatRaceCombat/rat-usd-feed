// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV2V3Interface} from "./interfaces/AggregatorV2V3Interface.sol";

/**
 * @title RAT / USD price feed on HyperEVM
 * @notice Chainlink compatible (AggregatorV2V3Interface, 8 decimals): read it with latestRoundData()
 *   like any Chainlink feed, and check updatedAt.
 *
 *   Reporters push the RAT price they read off chain from the two RAT markets, HyperCore spot pair 157
 *   (RAT/USDC) and the HyperSwap V3 RAT/WHYPE pool, weighted by depth (see the README). The contract
 *   keeps them honest: an answer is accepted only
 *     - within `maxDeviationBps` of the HyperCore RAT/USDC mid that this very block reads through
 *       HyperCore's best-bid-offer precompile (a book an EVM transaction cannot move),
 *     - for an observation at most `maxObservationAge` seconds old and newer than the last round's.
 *   A stolen reporter key can therefore neither move the feed away from the market nor replay an
 *   old price.
 * @dev No upgrade, no pause, no fee, holds no token. The owner (the team's Safe) only names the
 *   reporters and sets the band, within fixed limits. Rounds start at 1 and never go back.
 */
contract RatUsdFeed is AggregatorV2V3Interface, Ownable2Step {
  /// HyperCore precompile: abi.encode(uint32 asset) -> (uint64 bid, uint64 ask), asset = 10000 + spot index
  address public constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;
  uint8 private constant DECIMALS = 8;
  uint16 public constant MIN_DEVIATION_BPS = 100; // the band can be set from 1%
  uint16 public constant MAX_DEVIATION_BPS = 3000; // to 30% of the HyperCore mid

  struct Round {
    int192 answer;
    uint32 startedAt; // when the reporter read the markets
    uint32 updatedAt; // the block that recorded it
  }

  /// HyperCore spot asset given to the precompile: 10000 + 157 for RAT/USDC
  uint32 public immutable coreAsset;
  /// decimals of HyperCore spot prices for that pair: 8 - szDecimals of the base token (RAT: 8 - 2 = 6)
  uint8 public immutable corePxDecimals;
  /// an observation older than this many seconds when it reaches the chain is refused
  uint32 public immutable maxObservationAge;

  /// the band around the HyperCore mid, in basis points
  uint16 public maxDeviationBps;
  mapping(address => bool) public isReporter;

  uint80 private latestRoundId;
  mapping(uint256 => Round) private rounds;

  event ReporterSet(address indexed reporter, bool allowed);
  event MaxDeviationSet(uint16 bps);

  error NotReporter();
  error BadAnswer();
  error StaleObservation();
  error NoCorePrice();
  error OffMarket(int256 answer, uint256 coreMid);
  error BadConfig();
  error RenounceDisabled();

  constructor(
    address owner_,
    address[] memory reporters,
    uint32 coreAsset_,
    uint8 corePxDecimals_,
    uint16 maxDeviationBps_,
    uint32 maxObservationAge_
  ) Ownable(owner_) {
    if (coreAsset_ < 10000 || corePxDecimals_ > DECIMALS || maxObservationAge_ == 0 || maxObservationAge_ > 3600) revert BadConfig();
    coreAsset = coreAsset_;
    corePxDecimals = corePxDecimals_;
    maxObservationAge = maxObservationAge_;
    _setMaxDeviation(maxDeviationBps_);
    for (uint256 i; i < reporters.length; ++i) _setReporter(reporters[i], true);
  }

  // ------------------------------------------------------------------ reporters

  /**
   * @notice Records a new round.
   * @param answer RAT in USD with 8 decimals
   * @param observedAt when the markets were read (Unix seconds)
   */
  function transmit(int256 answer, uint32 observedAt) external returns (uint80 roundId) {
    if (!isReporter[msg.sender]) revert NotReporter();
    if (answer <= 0 || answer > type(int192).max) revert BadAnswer();
    if (observedAt > block.timestamp || block.timestamp - observedAt > maxObservationAge) revert StaleObservation();
    uint80 last = latestRoundId;
    if (last != 0 && observedAt <= rounds[last].startedAt) revert StaleObservation();

    uint256 mid = coreMid();
    uint256 a = uint256(answer);
    uint256 gap = a > mid ? a - mid : mid - a;
    if (gap * 10_000 > mid * maxDeviationBps) revert OffMarket(answer, mid);

    roundId = last + 1;
    latestRoundId = roundId;
    rounds[roundId] = Round(int192(answer), observedAt, uint32(block.timestamp));
    emit NewRound(roundId, msg.sender, observedAt);
    emit AnswerUpdated(answer, roundId, block.timestamp);
  }

  /// @notice The HyperCore RAT/USDC mid read by this block, 8 decimals. Reverts without a two-sided book.
  function coreMid() public view returns (uint256) {
    (bool ok, bytes memory out) = BBO_PRECOMPILE.staticcall(abi.encode(coreAsset));
    if (!ok || out.length != 64) revert NoCorePrice();
    (uint64 bid, uint64 ask) = abi.decode(out, (uint64, uint64));
    if (bid == 0 || ask < bid) revert NoCorePrice();
    return ((uint256(bid) + uint256(ask)) * 10 ** (DECIMALS - corePxDecimals)) / 2;
  }

  // ------------------------------------------------------------------ AggregatorV3Interface

  function decimals() external pure returns (uint8) {
    return DECIMALS;
  }

  function description() external pure returns (string memory) {
    return "RAT / USD";
  }

  function version() external pure returns (uint256) {
    return 1;
  }

  function getRoundData(
    uint80 roundId_
  ) public view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
    Round memory r = rounds[roundId_];
    require(r.updatedAt != 0, "No data present");
    return (roundId_, r.answer, r.startedAt, r.updatedAt, roundId_);
  }

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    return getRoundData(latestRoundId);
  }

  // ------------------------------------------------------------------ AggregatorInterface (v2): zeros when unknown

  function latestAnswer() external view returns (int256) {
    return rounds[latestRoundId].answer;
  }

  function latestTimestamp() external view returns (uint256) {
    return rounds[latestRoundId].updatedAt;
  }

  function latestRound() external view returns (uint256) {
    return latestRoundId;
  }

  function getAnswer(uint256 roundId_) external view returns (int256) {
    return rounds[roundId_].answer;
  }

  function getTimestamp(uint256 roundId_) external view returns (uint256) {
    return rounds[roundId_].updatedAt;
  }

  // ------------------------------------------------------------------ owner

  function setReporter(address reporter, bool allowed) external onlyOwner {
    _setReporter(reporter, allowed);
  }

  function setMaxDeviationBps(uint16 bps) external onlyOwner {
    _setMaxDeviation(bps);
  }

  /// @dev A feed without an owner could never change its reporters again: renouncing is closed.
  function renounceOwnership() public pure override {
    revert RenounceDisabled();
  }

  function _setReporter(address reporter, bool allowed) private {
    if (reporter == address(0)) revert BadConfig();
    isReporter[reporter] = allowed;
    emit ReporterSet(reporter, allowed);
  }

  function _setMaxDeviation(uint16 bps) private {
    if (bps < MIN_DEVIATION_BPS || bps > MAX_DEVIATION_BPS) revert BadConfig();
    maxDeviationBps = bps;
    emit MaxDeviationSet(bps);
  }
}
