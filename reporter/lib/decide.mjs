// When to push a round, as Chainlink's push feeds do: on a deviation from the last round, or on the
// heartbeat. The reporter pushes a little before the heartbeat so the feed never looks late.

export const RULES = Object.freeze({
  deviationBps: 100, // 1%
  heartbeatSec: 3600, // one round an hour at least
  earlySec: 120, // pushed 2 minutes before the hour runs out
});

/**
 * latest: null (no round yet) or { answer: bigint, updatedAt: number (s) }; answer: bigint (8 decimals).
 * Returns { push, why }.
 */
export function decide(latest, answer, nowSec, rules = RULES) {
  if (!(typeof answer === 'bigint' && answer > 0n)) return { push: false, why: 'no price' };
  if (!latest) return { push: true, why: 'first round' };
  const last = latest.answer;
  const gap = answer > last ? answer - last : last - answer;
  const bps = last > 0n ? Number((gap * 1_000_000n) / last) / 100 : Infinity;
  if (bps >= rules.deviationBps) return { push: true, why: `moved ${(bps / 100).toFixed(2)}%` };
  const age = nowSec - latest.updatedAt;
  if (age >= rules.heartbeatSec - rules.earlySec) return { push: true, why: `heartbeat (${age} s since the last round)` };
  return { push: false, why: `moved ${(bps / 100).toFixed(2)}%, last round ${age} s ago` };
}

/**
 * The contract's guard, checked before sending: the answer must sit within `bandBps` of the HyperCore
 * mid the contract reads (8 decimals). Same integer maths as RatUsdFeed.transmit.
 */
export function withinBand(answer, coreMid, bandBps) {
  const gap = answer > coreMid ? answer - coreMid : coreMid - answer;
  return gap * 10_000n <= coreMid * BigInt(bandBps);
}
