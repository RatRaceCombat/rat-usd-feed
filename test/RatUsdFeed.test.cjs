const { expect } = require('chai');
const { ethers, network } = require('hardhat');
// moves the local chain's clock forward (the next block is mined later)
const time = { increase: async (sec) => { await network.provider.send('evm_increaseTime', [sec]); await network.provider.send('evm_mine'); } };

const BBO = '0x000000000000000000000000000000000000080e';
const ASSET = 10157; // 10000 + spot index 157 (RAT/USDC)
const PX_DECIMALS = 6;
const BAND = 1000; // 10%
const MAX_AGE = 300;

// HyperCore prices for RAT have 6 decimals: 4298 = $0.004298
const BID = 4298n;
const ASK = 4311n;
const MID8 = ((BID + ASK) * 100n) / 2n; // 430450 = $0.0043045 with 8 decimals

async function setup() {
  const [owner, reporter, other, newOwner] = await ethers.getSigners();
  // HyperCore's precompile does not exist on a local chain: the mock's code goes to its address
  const mock = await (await ethers.getContractFactory('MockBbo')).deploy();
  await network.provider.send('hardhat_setCode', [BBO, await ethers.provider.getCode(await mock.getAddress())]);
  const bbo = await ethers.getContractAt('MockBbo', BBO);
  await bbo.set(ASSET, BID, ASK);
  const Feed = await ethers.getContractFactory('RatUsdFeed');
  const feed = await Feed.deploy(owner.address, [reporter.address], ASSET, PX_DECIMALS, BAND, MAX_AGE);
  const now = async () => Number((await ethers.provider.getBlock('latest')).timestamp);
  return { feed, bbo, Feed, owner, reporter, other, newOwner, now };
}

describe('RatUsdFeed', () => {
  it('reads like a Chainlink feed: 8 decimals, its description, no data before the first round', async () => {
    const { feed } = await setup();
    expect(await feed.decimals()).to.equal(8);
    expect(await feed.description()).to.equal('RAT / USD');
    expect(await feed.version()).to.equal(1);
    await expect(feed.latestRoundData()).to.be.revertedWith('No data present');
    await expect(feed.getRoundData(1)).to.be.revertedWith('No data present');
    expect(await feed.latestAnswer()).to.equal(0);
    expect(await feed.latestRound()).to.equal(0);
    expect(await feed.latestTimestamp()).to.equal(0);
  });

  it('reads the HyperCore mid through the precompile, in 8 decimals', async () => {
    const { feed, bbo } = await setup();
    expect(await feed.coreMid()).to.equal(MID8);
    await bbo.set(ASSET, 0, ASK);
    await expect(feed.coreMid()).to.be.revertedWithCustomError(feed, 'NoCorePrice');
    await bbo.set(ASSET, ASK, BID);
    await expect(feed.coreMid()).to.be.revertedWithCustomError(feed, 'NoCorePrice'); // crossed
  });

  it('a reporter records rounds: ids from 1, both events, v2 and v3 getters agree', async () => {
    const { feed, reporter, now } = await setup();
    const t1 = await now();
    await expect(feed.connect(reporter).transmit(427777n, t1))
      .to.emit(feed, 'NewRound').withArgs(1, reporter.address, t1)
      .and.to.emit(feed, 'AnswerUpdated');
    const r1 = await feed.latestRoundData();
    expect(r1.roundId).to.equal(1);
    expect(r1.answer).to.equal(427777n);
    expect(r1.startedAt).to.equal(t1);
    expect(r1.updatedAt).to.equal(await now());
    expect(r1.answeredInRound).to.equal(1);

    await time.increase(60);
    const t2 = await now();
    await feed.connect(reporter).transmit(440000n, t2);
    expect((await feed.latestRoundData()).roundId).to.equal(2);
    expect((await feed.getRoundData(1)).answer).to.equal(427777n);
    expect(await feed.latestAnswer()).to.equal(440000n);
    expect(await feed.latestRound()).to.equal(2);
    expect(await feed.getAnswer(1)).to.equal(427777n);
    expect(await feed.getTimestamp(2)).to.equal(await feed.latestTimestamp());
    expect(await feed.getAnswer(99)).to.equal(0);
  });

  it('the guard: an answer outside the band around the HyperCore mid is refused', async () => {
    const { feed, reporter, now } = await setup();
    const t = await now();
    const edgeUp = (MID8 * 11000n) / 10000n; // exactly +10%
    const edgeDown = (MID8 * 9000n) / 10000n;
    await expect(feed.connect(reporter).transmit(edgeUp + 1n, t))
      .to.be.revertedWithCustomError(feed, 'OffMarket').withArgs(edgeUp + 1n, MID8);
    await expect(feed.connect(reporter).transmit(edgeDown - 1n, t)).to.be.revertedWithCustomError(feed, 'OffMarket');
    await feed.connect(reporter).transmit(edgeUp, t);
    await time.increase(1);
    await feed.connect(reporter).transmit(edgeDown, await now());
    expect(await feed.latestRound()).to.equal(2);
  });

  it('no HyperCore book, no round', async () => {
    const { feed, bbo, reporter, now } = await setup();
    await bbo.set(ASSET, 0, 0);
    await expect(feed.connect(reporter).transmit(MID8, await now())).to.be.revertedWithCustomError(feed, 'NoCorePrice');
    await network.provider.send('hardhat_setCode', [BBO, '0x']); // the precompile missing altogether
    await expect(feed.connect(reporter).transmit(MID8, await now())).to.be.revertedWithCustomError(feed, 'NoCorePrice');
  });

  it('observations: never from the future, never older than the limit, always newer than the last round', async () => {
    const { feed, reporter, now } = await setup();
    const t = await now();
    await expect(feed.connect(reporter).transmit(MID8, t + 60)).to.be.revertedWithCustomError(feed, 'StaleObservation');
    await expect(feed.connect(reporter).transmit(MID8, t - MAX_AGE - 5)).to.be.revertedWithCustomError(feed, 'StaleObservation');
    await feed.connect(reporter).transmit(MID8, t);
    await expect(feed.connect(reporter).transmit(MID8, t)).to.be.revertedWithCustomError(feed, 'StaleObservation');
    await expect(feed.connect(reporter).transmit(MID8, t - 1)).to.be.revertedWithCustomError(feed, 'StaleObservation');
  });

  it('only reporters transmit, and only positive answers', async () => {
    const { feed, reporter, other, now } = await setup();
    const t = await now();
    await expect(feed.connect(other).transmit(MID8, t)).to.be.revertedWithCustomError(feed, 'NotReporter');
    await expect(feed.connect(reporter).transmit(0, t)).to.be.revertedWithCustomError(feed, 'BadAnswer');
    await expect(feed.connect(reporter).transmit(-1, t)).to.be.revertedWithCustomError(feed, 'BadAnswer');
  });

  it('the owner names reporters and sets the band within 1% and 30%; nobody else can', async () => {
    const { feed, owner, reporter, other, now } = await setup();
    await expect(feed.connect(other).setReporter(other.address, true)).to.be.revertedWithCustomError(feed, 'OwnableUnauthorizedAccount');
    await expect(feed.connect(reporter).setMaxDeviationBps(3000)).to.be.revertedWithCustomError(feed, 'OwnableUnauthorizedAccount');
    await expect(feed.connect(owner).setReporter(other.address, true)).to.emit(feed, 'ReporterSet').withArgs(other.address, true);
    await feed.connect(other).transmit(MID8, await now());
    await feed.connect(owner).setReporter(reporter.address, false);
    await time.increase(1);
    await expect(feed.connect(reporter).transmit(MID8, await now())).to.be.revertedWithCustomError(feed, 'NotReporter');
    await expect(feed.connect(owner).setReporter(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(feed, 'BadConfig');
    await expect(feed.connect(owner).setMaxDeviationBps(99)).to.be.revertedWithCustomError(feed, 'BadConfig');
    await expect(feed.connect(owner).setMaxDeviationBps(3001)).to.be.revertedWithCustomError(feed, 'BadConfig');
    await expect(feed.connect(owner).setMaxDeviationBps(500)).to.emit(feed, 'MaxDeviationSet').withArgs(500);
    expect(await feed.maxDeviationBps()).to.equal(500);
  });

  it('ownership moves in two steps and can never be renounced', async () => {
    const { feed, owner, newOwner } = await setup();
    await feed.connect(owner).transferOwnership(newOwner.address);
    expect(await feed.owner()).to.equal(owner.address);
    await feed.connect(newOwner).acceptOwnership();
    expect(await feed.owner()).to.equal(newOwner.address);
    await expect(feed.connect(newOwner).renounceOwnership()).to.be.revertedWithCustomError(feed, 'RenounceDisabled');
  });

  it('refuses a broken setup at deployment', async () => {
    const { Feed, owner, reporter } = await setup();
    const make = (o, r, asset, dec, band, age) => Feed.deploy(o, r, asset, dec, band, age);
    await expect(make(ethers.ZeroAddress, [], ASSET, 6, BAND, MAX_AGE)).to.be.revertedWithCustomError(Feed, 'OwnableInvalidOwner');
    await expect(make(owner.address, [], 157, 6, BAND, MAX_AGE)).to.be.revertedWithCustomError(Feed, 'BadConfig'); // a spot index without 10000
    await expect(make(owner.address, [], ASSET, 9, BAND, MAX_AGE)).to.be.revertedWithCustomError(Feed, 'BadConfig');
    await expect(make(owner.address, [], ASSET, 6, 50, MAX_AGE)).to.be.revertedWithCustomError(Feed, 'BadConfig');
    await expect(make(owner.address, [], ASSET, 6, BAND, 0)).to.be.revertedWithCustomError(Feed, 'BadConfig');
    await expect(make(owner.address, [ethers.ZeroAddress], ASSET, 6, BAND, MAX_AGE)).to.be.revertedWithCustomError(Feed, 'BadConfig');
    const ok = await make(owner.address, [reporter.address], ASSET, 6, BAND, MAX_AGE);
    expect(await ok.isReporter(reporter.address)).to.equal(true);
  });

  it('a transmit costs well under HyperEVM small blocks (2M gas)', async () => {
    const { feed, reporter, now } = await setup();
    const first = await (await feed.connect(reporter).transmit(MID8, await now())).wait();
    await time.increase(30);
    const next = await (await feed.connect(reporter).transmit(MID8, await now())).wait();
    console.log(`      gas: first round ${first.gasUsed}, next rounds ${next.gasUsed}`);
    expect(next.gasUsed).to.be.lessThan(100_000n);
  });
});
