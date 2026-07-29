// tavern demo — the browser half. All arithmetic lives in tavern.js; this file
// only does I/O: hashing with WebCrypto, reading inputs, painting results.
//
// The separation is deliberate and worth keeping. tavern.js is what a server
// would import unchanged; everything here is throwaway.

import * as T from './tavern.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random hex, from the platform CSPRNG. The only randomness in the project,
 *  and it is here rather than in tavern.js on purpose. */
function randomSeed() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-GB');
const OPTS = { edgeBps: T.DEFAULT_EDGE_BPS, maxRiskFrac: T.DEFAULT_MAX_RISK_FRAC };

const state = {
  seed: null,
  commitment: null,
  spent: false,        // a seed is single-use: reusing one breaks the scheme
  bank: 100000,
  shares: 100000,
  mine: 10000,
};

// ---------------------------------------------------------------- rounds

async function newRound() {
  state.seed = randomSeed();
  state.commitment = await sha256(state.seed);
  state.spent = false;
  $('commitment').textContent = state.commitment;
  for (const id of ['r-seed', 'r-commit', 'r-hash']) $(id).textContent = '—';
  $('die').textContent = '?';
  $('die').className = 'die';
  $('verdict').textContent = '';
  $('verdict').className = 'verdict';
  $('result').textContent = '';
  paintQuote();
}

function paintQuote() {
  const target = Number($('target').value);
  const stake = Number($('stake').value);
  $('target-out').textContent = String(target);
  const q = T.quote(target, stake, OPTS);
  if (q.error) {
    $('o-chance').textContent = '—';
    $('o-mult').textContent = '—';
    $('o-payout').textContent = '—';
    $('limit').textContent = q.error === 'target'
      ? `pick between ${q.min} and ${q.max}` : 'stake must be a positive number';
    $('limit').className = 'limit over';
    return;
  }
  $('o-chance').textContent = `${(q.chance * 100).toFixed(0)}%`;
  $('o-mult').innerHTML = `${q.multiplier.toFixed(3)}&times;`;
  $('o-payout').textContent = fmt(q.payout);
  const max = T.maxStake(state.bank, target, OPTS);
  const over = q.stake > max;
  $('limit').textContent = over
    ? `over the house limit — most it will take here is ${fmt(max)}`
    : `house limit here: ${fmt(max)} · bank risks ${fmt(q.risk)}`;
  $('limit').className = over ? 'limit over' : 'limit';
}

async function roll() {
  if (!state.seed) await newRound();
  if (state.spent) {
    $('result').textContent = 'That seed is spent — start a new round.';
    $('result').className = 'result bad';
    return;
  }
  const target = Number($('target').value);
  const stake = Number($('stake').value);
  const nonce = $('nonce').value;

  const hash = await sha256(`${state.seed}|${nonce}`);
  const r = T.rollFromHash(hash);
  const out = T.settle({ bankroll: state.bank, target, stake, roll: r, opts: OPTS });

  if (out.error === 'maxStake') {
    $('result').textContent = `Over the house limit — the most it will take at this target is ${fmt(out.maxStake)}.`;
    $('result').className = 'result bad';
    return;
  }
  if (out.error) {
    $('result').textContent = `Refused: ${out.error}.`;
    $('result').className = 'result bad';
    return;
  }

  state.spent = true;
  state.bank = out.bankroll;

  const die = $('die');
  die.textContent = String(out.roll);
  die.className = 'die rolling ' + (out.win ? 'win' : 'lose');
  setTimeout(() => die.classList.remove('rolling'), 600);

  $('result').innerHTML = out.win
    ? `Rolled <strong>${out.roll}</strong> — above ${out.target}. You win <strong>${fmt(out.payout)}</strong>.`
    : `Rolled <strong>${out.roll}</strong> — not above ${out.target}. The bank keeps ${fmt(out.stake)}.`;
  $('result').className = 'result ' + (out.win ? 'good' : 'bad');

  // the reveal
  $('r-seed').textContent = state.seed;
  $('r-commit').textContent = await sha256(state.seed);
  $('r-hash').textContent = hash;

  const v = T.verifyRound({
    commitment: state.commitment,
    seedHash: await sha256(state.seed),
    computedHash: hash,
    roll: out.roll,
  });
  $('verdict').textContent = v.ok
    ? '✓ commitment matches the seed, and the roll follows from the hash.'
    : `✗ verification failed: ${v.reason}`;
  $('verdict').className = 'verdict ' + (v.ok ? 'good' : 'bad');

  paintBank();
  paintQuote();
}

// ---------------------------------------------------------------- verifier

async function verify() {
  const commitment = $('v-commit').value.trim();
  const seed = $('v-seed').value.trim();
  const nonce = $('v-nonce').value;
  const rollRaw = $('v-roll').value.trim();
  if (!commitment || !seed) {
    $('v-out').textContent = 'Paste at least a commitment and a seed.';
    $('v-out').className = 'verdict';
    return;
  }
  const v = T.verifyRound({
    commitment,
    seedHash: await sha256(seed),
    computedHash: await sha256(`${seed}|${nonce}`),
    roll: rollRaw === '' ? null : Number(rollRaw),
  });
  const why = {
    commitment: 'the seed does not hash to the published commitment — the house changed it',
    roll: `the roll does not follow from the hash — it should have been ${v.expected}`,
    hash: 'the hash is not usable',
    missing: 'something is missing',
  };
  $('v-out').textContent = v.ok
    ? `✓ verified. The roll was ${v.roll}.`
    : `✗ ${why[v.reason] || v.reason}`;
  $('v-out').className = 'verdict ' + (v.ok ? 'good' : 'bad');
}

// ---------------------------------------------------------------- the bank

function paintBank() {
  $('bank').textContent = fmt(state.bank);
  $('shares').textContent = fmt(state.shares);
  $('mine').textContent = fmt(state.mine);
  $('worth').textContent = fmt(T.shareValue(state.bank, state.shares, state.mine));
}

function say(msg, bad) {
  $('bank-msg').textContent = msg;
  $('bank-msg').className = bad ? 'hint over' : 'hint';
}

function deposit() {
  const r = T.bankrollAdd(state.bank, state.shares, Number($('dep').value));
  if (r.error) return say(`Refused: ${r.error}.`, true);
  state.bank = r.bankroll; state.shares = r.totalShares; state.mine += r.minted;
  say(`Minted ${fmt(r.minted)} shares.`);
  paintBank(); paintQuote();
}

function withdraw() {
  const burn = Math.min(Number($('wd').value), state.mine);
  const r = T.bankrollRemove(state.bank, state.shares, burn);
  if (r.error) return say(`Refused: ${r.error}.`, true);
  state.bank = r.bankroll; state.shares = r.totalShares; state.mine -= burn;
  say(`Burned ${fmt(burn)} shares for ${fmt(r.out)}.`);
  paintBank(); paintQuote();
}

/** Grind the edge so providers can watch it accrue. Uses the platform CSPRNG
 *  per round — this is a simulation of many rounds, not one verifiable one. */
async function grind() {
  const target = Number($('target').value);
  const before = T.shareValue(state.bank, state.shares, state.mine);
  let played = 0;
  for (let i = 0; i < 500; i++) {
    const stake = Math.min(100, T.maxStake(state.bank, target, OPTS));
    const r = T.settle({
      bankroll: state.bank, target, stake,
      roll: T.rollFromHash(randomSeed()), opts: OPTS,
    });
    if (r.ok) { state.bank = r.bankroll; played++; }
  }
  const after = T.shareValue(state.bank, state.shares, state.mine);
  const d = after - before;
  say(`${played} rounds. Your stake ${d >= 0 ? 'grew' : 'fell'} by ${fmt(Math.abs(d))} `
    + `(${(d / before * 100).toFixed(2)}%). Expected edge over that volume: ~2%.`);
  paintBank(); paintQuote();
}

// ---------------------------------------------------------------- wiring

$('new-round').addEventListener('click', newRound);
$('roll').addEventListener('click', roll);
$('v-go').addEventListener('click', verify);
$('do-dep').addEventListener('click', deposit);
$('do-wd').addEventListener('click', withdraw);
$('grind').addEventListener('click', grind);
for (const id of ['target', 'stake']) $(id).addEventListener('input', paintQuote);

paintBank();
newRound();
