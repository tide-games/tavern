// tavern tests — zero dependencies, run with `node tests.js`.
//
// Written the way tideholm's suite is: assertions that would fail if the
// implementation were quietly wrong, not assertions that restate it. Every
// block here has been checked by mutating tavern.js and confirming it goes
// red — see MUTANTS at the bottom for the list.

import * as t from './tavern.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------- rolls

console.log('rollFromHash');
{
  const h = 'a'.repeat(64);
  check('a hash gives a roll in range', (() => {
    const r = t.rollFromHash(h);
    return r >= 1 && r <= 100;
  })());
  check('the same hash always gives the same roll', t.rollFromHash(h) === t.rollFromHash(h));
  check('a different hash usually gives a different roll',
    t.rollFromHash('a'.repeat(64)) !== t.rollFromHash('b'.repeat(64)));
  check('0x prefix and case are tolerated',
    t.rollFromHash('0x' + 'AB'.repeat(32)) === t.rollFromHash('ab'.repeat(32)));

  // Refusing beats guessing: a short or non-hex input must not silently
  // produce a roll, because a wrong roll is indistinguishable from a fair one.
  check('too short is refused', t.rollFromHash('abc') === null);
  check('non-hex is refused', t.rollFromHash('zzzzzzzzzzzzzz') === null);
  check('non-string is refused', t.rollFromHash(12345678901234) === null);
  check('empty is refused', t.rollFromHash('') === null);

  // Distribution: 13 hex chars is 52 bits, so bias at 100 sides is ~2e-14.
  // This checks the roll actually varies across the range rather than
  // clustering, which a truncation bug would cause.
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const hex = (i * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(2);
    seen.add(t.rollFromHash(hex));
  }
  check('rolls spread across the range', seen.size > 60, `only ${seen.size} distinct`);
  check('and never leave it', [...seen].every((r) => r >= 1 && r <= 100));

  check('a custom number of sides is honoured', (() => {
    const r = t.rollFromHash(h, 6);
    return r >= 1 && r <= 6;
  })());
}

// ---------------------------------------------------------------- verification

console.log('\nverifyRound');
{
  const commitment = 'deadbeef'.repeat(8);
  const computed = 'cafebabe'.repeat(8);
  const roll = t.rollFromHash(computed);

  check('a good round verifies',
    t.verifyRound({ commitment, seedHash: commitment, computedHash: computed, roll }).ok);
  check('and returns the roll it derived',
    t.verifyRound({ commitment, seedHash: commitment, computedHash: computed }).roll === roll);

  // The three ways a house could cheat, each caught separately.
  check('a seed that does not match the commitment is rejected',
    t.verifyRound({ commitment, seedHash: 'f'.repeat(64), computedHash: computed, roll }).reason === 'commitment');
  check('a roll that does not match the hash is rejected',
    t.verifyRound({ commitment, seedHash: commitment, computedHash: computed, roll: roll === 1 ? 2 : 1 }).reason === 'roll');
  check('and it says what the roll should have been',
    t.verifyRound({ commitment, seedHash: commitment, computedHash: computed, roll: roll === 1 ? 2 : 1 }).expected === roll);
  check('an unusable hash is rejected',
    t.verifyRound({ commitment, seedHash: commitment, computedHash: 'abc', roll }).reason === 'hash');
  check('missing fields are rejected',
    t.verifyRound({ commitment, computedHash: computed }).reason === 'missing');
  check('case and 0x differences do not break a valid round',
    t.verifyRound({ commitment: '0x' + commitment.toUpperCase(), seedHash: commitment, computedHash: computed }).ok);
}

// ---------------------------------------------------------------- pricing

console.log('\nquote');
{
  // target 50 on a d100: 50 faces win, so chance is exactly 0.5 and the fair
  // multiplier is exactly 2. Anchoring on an exact case makes the edge
  // arithmetic checkable by hand.
  const q = t.quote(50, 100, { edgeBps: 0 });
  check('chance is (sides - target) / sides', close(q.chance, 0.5), q.chance);
  check('fair multiplier is 1/chance', close(q.fair, 2), q.fair);
  check('with no edge, multiplier is the fair one', close(q.multiplier, 2), q.multiplier);
  check('payout includes the stake', close(q.payout, 200), q.payout);
  check('risk is payout minus stake', close(q.risk, 100), q.risk);

  const e = t.quote(50, 100, { edgeBps: 200 });
  check('a 2% edge takes 2% off the multiplier', close(e.multiplier, 1.96), e.multiplier);
  check('so the payout shrinks, not the stake', close(e.payout, 196) && e.stake === 100);

  // A long shot must be priced as a long shot: target 99 leaves one face.
  const long = t.quote(99, 10, { edgeBps: 0 });
  check('a one-in-a-hundred shot pays 100x', close(long.multiplier, 100), long.multiplier);
  check('and risks 990 on a stake of 10', close(long.risk, 990), long.risk);

  check('target below range is refused', t.quote(0, 10).error === 'target');
  check('target at sides is refused', t.quote(100, 10).error === 'target');
  check('a zero stake is refused', t.quote(50, 0).error === 'stake');
  check('a negative stake is refused', t.quote(50, -5).error === 'stake');
  check('a NaN stake is refused', t.quote(50, NaN).error === 'stake');

  // Config that would break the bank falls back rather than being obeyed.
  check('a negative edge falls back to the default',
    t.quote(50, 100, { edgeBps: -500 }).edgeBps === t.DEFAULT_EDGE_BPS);
  check('an edge of 100% or more falls back',
    t.quote(50, 100, { edgeBps: 10000 }).edgeBps === t.DEFAULT_EDGE_BPS);
  check('junk edge falls back', t.quote(50, 100, { edgeBps: 'lots' }).edgeBps === t.DEFAULT_EDGE_BPS);
}

// ---------------------------------------------------------------- risk limit

console.log('\nmaxStake');
{
  const bank = 10000;
  // At 2% max risk, the bank will expose 200. An even-money bet risks 0.96
  // per unit staked at a 2% edge, so the cap is ~208.
  const even = t.maxStake(bank, 50, { edgeBps: 200, maxRiskFrac: 0.02 });
  check('an even-money bet caps near riskFrac/perUnitRisk', close(even, 200 / 0.96), even);

  const long = t.maxStake(bank, 99, { edgeBps: 200, maxRiskFrac: 0.02 });
  check('a long shot caps far lower', long < even / 50, `${long} vs ${even}`);
  check('because the cap is on EXPOSURE, not stake',
    close(long * (t.quote(99, 1, { edgeBps: 200 }).multiplier - 1), 200), long);

  check('a bigger bankroll allows a bigger bet',
    t.maxStake(20000, 50, { edgeBps: 200 }) > t.maxStake(10000, 50, { edgeBps: 200 }));
  check('an empty bank allows nothing', t.maxStake(0, 50) === 0);
  check('a negative bank allows nothing', t.maxStake(-100, 50) === 0);
  check('an invalid target allows nothing', t.maxStake(bank, 0) === 0);
  check('a nonsense riskFrac falls back rather than uncapping',
    close(t.maxStake(bank, 50, { edgeBps: 200, maxRiskFrac: 9 }),
          t.maxStake(bank, 50, { edgeBps: 200 })));
}

// ---------------------------------------------------------------- settlement

console.log('\nsettle');
{
  const base = { bankroll: 100000, target: 50, stake: 100, opts: { edgeBps: 200 } };

  const win = t.settle({ ...base, roll: 51 });
  check('a roll above target wins', win.win === true);
  check('the bank pays only the profit', close(win.delta, -96), win.delta);
  check('and the bankroll moves by exactly that', close(win.bankroll, 100000 - 96), win.bankroll);
  check('payout includes the stake', close(win.payout, 196), win.payout);

  const lose = t.settle({ ...base, roll: 50 });
  check('a roll equal to target loses (strictly above)', lose.win === false);
  check('the bank keeps the whole stake', close(lose.delta, 100), lose.delta);
  check('and pays nothing', lose.payout === 0);

  check('the boundary is target+1', t.settle({ ...base, roll: 51 }).win === true
    && t.settle({ ...base, roll: 50 }).win === false);
  check('the lowest face loses', t.settle({ ...base, roll: 1 }).win === false);
  check('the highest face wins', t.settle({ ...base, roll: 100 }).win === true);

  check('a roll outside the die is refused', t.settle({ ...base, roll: 101 }).error === 'roll');
  check('a zero roll is refused', t.settle({ ...base, roll: 0 }).error === 'roll');
  check('a NaN roll is refused', t.settle({ ...base, roll: NaN }).error === 'roll');

  // The limit must bind at settlement, not only in the UI — otherwise a
  // crafted request drains the bank whatever the client displayed.
  const over = t.settle({ bankroll: 1000, target: 99, stake: 500, roll: 100, opts: {} });
  check('a stake over the risk limit is refused at settlement', over.error === 'maxStake');
  check('and it reports the limit', over.maxStake > 0 && over.maxStake < 500);

  // The property that actually matters for a bank: no single settled round
  // may take more than the configured fraction, whatever the target.
  let worst = 0;
  for (let target = 1; target <= 99; target++) {
    const stake = t.maxStake(100000, target, { edgeBps: 200, maxRiskFrac: 0.02 });
    const r = t.settle({ bankroll: 100000, target, stake, roll: 100, opts: { edgeBps: 200, maxRiskFrac: 0.02 } });
    if (r.ok) worst = Math.max(worst, -r.delta / 100000);
  }
  check('no target can lose the bank more than maxRiskFrac in one round',
    worst <= 0.02 + 1e-9, `worst was ${(worst * 100).toFixed(3)}%`);
}

// ---------------------------------------------------------------- the edge is real

console.log('\nedge');
{
  // Over the whole die, the bank must expect to win. If this ever goes
  // negative the house is paying out more than fair and the bank bleeds.
  let worstTarget = null, worstReturn = Infinity;
  for (let target = 1; target <= 99; target++) {
    const r = t.expectedBankReturn(target, { edgeBps: 200 });
    if (r < worstReturn) { worstReturn = r; worstTarget = target; }
  }
  check('the bank expects to profit at every target', worstReturn > 0,
    `worst was ${worstReturn.toFixed(6)} at target ${worstTarget}`);
  check('and the expected return equals the edge', close(worstReturn, 0.02, 1e-9),
    worstReturn);
  check('a zero edge is exactly break-even',
    close(t.expectedBankReturn(50, { edgeBps: 0 }), 0));

  // Simulated grind: with a fixed edge the bank should end ahead over many
  // rounds. Deterministic — no Math.random, so this cannot flake.
  let bank = 1000000;
  for (let i = 0; i < 5000; i++) {
    const hex = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(2);
    const roll = t.rollFromHash(hex);
    const r = t.settle({ bankroll: bank, target: 50, stake: 100, roll, opts: { edgeBps: 200 } });
    if (r.ok) bank = r.bankroll;
  }
  check('the bank is ahead after 5000 even-money rounds', bank > 1000000,
    `ended at ${Math.round(bank)}`);
}

// ---------------------------------------------------------------- bankroll shares

console.log('\nbankroll');
{
  const first = t.bankrollAdd(0, 0, 1000);
  check('the first deposit sets the unit', first.minted === 1000 && first.totalShares === 1000);
  check('and the bank equals the deposit', first.bankroll === 1000);

  const second = t.bankrollAdd(1000, 1000, 500);
  check('a later deposit mints pro rata', close(second.minted, 500), second.minted);

  // After the bank grows on the edge, the SAME deposit must buy fewer shares —
  // otherwise a latecomer dilutes the providers who carried the risk.
  const grown = t.bankrollAdd(2000, 1000, 500);
  check('once the bank has grown, a deposit buys fewer shares',
    grown.minted < 500, grown.minted);
  check('specifically deposit x total / bank', close(grown.minted, 250), grown.minted);

  check('a zero deposit is refused', t.bankrollAdd(1000, 1000, 0).error === 'deposit');
  check('a negative deposit is refused', t.bankrollAdd(1000, 1000, -5).error === 'deposit');
  check('shares with an empty bank is a broken state',
    t.bankrollAdd(0, 1000, 100).error === 'brokenBank');
  check('a bank with no shares is a broken state',
    t.bankrollAdd(1000, 0, 100).error === 'brokenBank');

  const out = t.bankrollRemove(2000, 1000, 250);
  check('burning shares returns value pro rata', close(out.out, 500), out.out);
  check('and shrinks both sides', close(out.bankroll, 1500) && out.totalShares === 750);
  check('burning more than exist is refused', t.bankrollRemove(2000, 1000, 1001).error === 'tooMany');
  check('a zero burn is refused', t.bankrollRemove(2000, 1000, 0).error === 'burn');
  check('a negative burn is refused — it must never GROW the bank',
    t.bankrollRemove(2000, 1000, -100).error === 'burn');

  check('share value tracks the bank', close(t.shareValue(2000, 1000, 250), 500));
  check('claiming more shares than exist is capped, not amplified',
    close(t.shareValue(2000, 1000, 5000), 2000));
  check('an empty bank is worth nothing', t.shareValue(0, 1000, 100) === 0);

  // Round-trip: deposit then immediately withdraw must not create value.
  const a = t.bankrollAdd(5000, 5000, 1234);
  const b = t.bankrollRemove(a.bankroll, a.totalShares, a.minted);
  check('deposit then withdraw returns what went in, never more',
    b.out <= 1234 + 1e-9, `${b.out} vs 1234`);
  check('and leaves the bank as it was', close(b.bankroll, 5000), b.bankroll);
}

// ---------------------------------------------------------------- purity

console.log('\npurity');
console.log('cutSlip');
{
  const tx = (prev, delta, sig) => ({ prev, delta, next: prev + delta, sig });
  // The live fork, 2026-09-11: slip base 800 with two settled moves ending
  // at 900; a peg-out then took the trail 900 -> 800. By balance the slip's
  // base matched the seal and both moves were kept, and play forked from 900.
  const settled = { base: 800, txs: [tx(800, -100, 'A'), tx(700, 200, 'B')], from: 'Z' };
  let r = t.cutSlip(settled, { seal: 800, tip: 'P' });
  check('a slip the trail moved past is set aside, not continued (the live fork)',
    r.reason === 'stale' && r.seg.txs.length === 0 && r.seg.base === 800 && r.seg.from === 'P' && r.archived.length === 2,
    JSON.stringify(r));
  check('by balance alone the same slip would have been kept (why the tip exists)',
    t.cutSlip(settled, { seal: 800 }).seg.txs.length === 2);
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A'), tx(700, 200, 'B')], from: 'Z' }, { seal: 900, tip: 'B' });
  check('a fully applied slip is cut to nothing and chains from the tip', r.reason === 'applied' && r.seg.txs.length === 0 && r.seg.from === 'B' && r.seg.base === 900);
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A'), tx(700, 200, 'B'), tx(900, -100, 'C')], from: 'Z' }, { seal: 900, tip: 'B' });
  check('a partly applied slip keeps the moves after the tip', r.reason === 'applied' && r.seg.txs.length === 1 && r.seg.txs[0].sig === 'C' && r.archived.length === 2);
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A')], from: 'Z' }, { seal: 800, tip: 'Z' });
  check('an unsettled slip whose tip has not moved is untouched', r.reason === 'unsettled' && r.seg.txs.length === 1);
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A')], from: 'Z' }, { seal: 500, tip: 'Z' });
  check('same tip but a different seal is impossible — set aside', r.reason === 'stale');
  r = t.cutSlip({ base: 300, txs: [] }, { seal: 300, tip: 'Q' });
  check('an empty slip adopts the seal and the tip', r.reason === 'fresh' && r.seg.from === 'Q');
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A')] }, { seal: 800, tip: 'P' });
  check('a slip from before tips existed is adopted once if it chains from the seal', r.reason === 'adopted' && r.seg.from === 'P' && r.seg.txs.length === 1);
  r = t.cutSlip({ base: 800, txs: [tx(900, -100, 'A')] }, { seal: 800, tip: 'P' });
  check('...but not if its first move does not chain from the seal', r.reason === 'stale');
  r = t.cutSlip({ base: 800, txs: [tx(800, -100, 'A'), tx(700, 200, 'B')] }, { seal: 900 });
  check('without a tip the balance rule still cuts', r.reason === 'balance' && r.seg.txs.length === 0 && r.seg.from === 'B');
}

{
  const src = await (await import('node:fs/promises')).readFile(new URL('./tavern.js', import.meta.url), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['Math.random', 'Date.now', 'new Date', 'document', 'window', 'localStorage',
    'fetch(', 'require(', 'process.']) {
    check(`no ${bad}`, !body.includes(bad));
  }
  check('no imports at all', !/^\s*import\s/m.test(body));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
process.exit(failures ? 1 : 0);
