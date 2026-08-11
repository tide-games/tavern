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

// ---------------------------------------------------------------- sealed mode
//
// The courier PoC (#146 without pods): a game sends the player here with
// ?did=&seal=&return=, the purse is their SEALED balance, and every stake and
// payout is a REAL trail transition signed in this browser with the same nostr
// key the seal uses (tidegate's keySigner — entered once per origin). The
// player then carries the signed slip home in a query string, and the game
// replays it into the seal. The trail is a signed document; the player is the
// transport. Pods later change WHERE the trail lives, not this shape.

const SEAL = (() => {
  const qp = new URLSearchParams(location.search);
  const did = (qp.get('did') || '').trim().toLowerCase();
  if (!/^did:nostr:[0-9a-f]{64}$/.test(did)) return null;
  return {
    did,
    seal: Math.max(0, Math.floor(Number(qp.get('seal')) || 0)),
    ret: qp.get('return') || 'https://nostr.social/tideholm/',
  };
})();
const segKey = () => 'tavern-seal-' + SEAL.did.slice(-8);

function loadSeg() {
  try {
    const s = JSON.parse(localStorage.getItem(segKey()));
    if (s && Number.isFinite(s.base) && Array.isArray(s.txs)) return s;
  } catch { /* fresh */ }
  return { base: SEAL.seal, txs: [] };
}
function saveSeg(s) { localStorage.setItem(segKey(), JSON.stringify(s)); }

/** The purse: what the seal is worth here right now. */
function purse() {
  const s = loadSeg();
  return s.base + s.txs.reduce((a, t) => a + t.delta, 0);
}

let _sealTools = null;
async function sealTools() {
  if (_sealTools) return _sealTools;
  const base = 'https://melvincarvalho.github.io/tidegate/';
  const [core, keys] = await Promise.all([import(base + 'tidegate.js'), import(base + 'keys.js')]);
  const signer = await keys.keySigner(); // prompts for the key once, per origin
  if (signer.pubkey !== SEAL.did.slice('did:nostr:'.length)) {
    throw new Error('the stored key does not match this identity');
  }
  _sealTools = { core, signer };
  return _sealTools;
}

/** Sign one +/- move of sealed gold, chained onto the segment. */
async function signSealTx(delta) {
  const { core, signer } = await sealTools();
  const s = loadSeg();
  const prev = s.base + s.txs.reduce((a, t) => a + t.delta, 0);
  const t = { did: SEAL.did, prev, delta, next: prev + delta };
  t.sig = await signer.sign(core.transitionBytes(t));
  t.pubkey = signer.pubkey;
  s.txs.push(t);
  saveSeg(s);
  return t;
}

const b64url = (s) => btoa(unescape(encodeURIComponent(s)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function paintSeal() {
  if (!SEAL) return;
  const p = $('seal-purse');
  p.hidden = false;
  p.innerHTML = `⚑ <strong>Sealed mode</strong> — playing for the gold of `
    + `<code>${SEAL.did.slice(0, 16)}…${SEAL.did.slice(-4)}</code>. `
    + `Purse: <strong>${fmt(purse())}</strong>. Stakes and winnings are signed trail moves, not play money.`;
  const s = loadSeg();
  const slip = $('seal-slip');
  if (!s.txs.length) { slip.hidden = true; return; }
  const net = s.txs.reduce((a, t) => a + t.delta, 0);
  slip.hidden = false;
  slip.textContent = `Slip: ${s.txs.length} signed move${s.txs.length > 1 ? 's' : ''}, net ${net >= 0 ? '+' : ''}${fmt(net)}. `;
  const a = document.createElement('a');
  a.href = `${SEAL.ret}?tavern=${b64url(JSON.stringify(s.txs))}`;
  a.textContent = 'Settle up ↗';
  slip.appendChild(a);
  slip.appendChild(document.createTextNode(' · '));
  const wipe = document.createElement('a');
  wipe.href = '#';
  wipe.textContent = 'wipe the slip';
  wipe.title = 'only after the game has accepted it — a wiped slip is gone';
  wipe.addEventListener('click', (ev) => {
    ev.preventDefault();
    saveSeg({ base: purse(), txs: [] }); // the purse carries over; the moves are spent
    paintSeal();
  });
  slip.appendChild(wipe);
}

// ---------------------------------------------------------------- the tide
//
// The block-seed wager. The seed is the hash of the next testnet4 block: it
// does not exist at bet time, so there is nothing for any house to commit to
// or shop for — the chain is the commitment. The player's mark still salts the
// roll, so bets riding the same block get different dice. This is the one part
// of the page that touches the network, and only when a button is pressed.

const TIDE_API = 'https://mempool.space/testnet4/api';
const TIDE_KEY = 'tavern-tide-bets';

function loadTide() {
  try { return JSON.parse(localStorage.getItem(TIDE_KEY)) || []; } catch { return []; }
}
function saveTide(bets) { localStorage.setItem(TIDE_KEY, JSON.stringify(bets)); }

async function tideText(path) {
  const r = await fetch(`${TIDE_API}${path}`);
  if (!r.ok) throw new Error(`the tide is unreadable (${r.status})`);
  return (await r.text()).trim();
}

function sayTide(msg, bad) {
  $('tide-msg').textContent = msg;
  $('tide-msg').className = bad ? 'hint over' : 'hint';
}

async function tideBet() {
  const target = Number($('target').value);
  // Sealed gold is whole gold; play money can be fractional.
  const stake = SEAL ? Math.floor(Number($('stake').value)) : Number($('stake').value);
  const q = T.quote(target, stake, OPTS);
  if (q.error) return sayTide(`Refused: ${q.error}.`, true);
  if (SEAL) {
    if (q.stake > purse()) return sayTide(`The purse holds ${fmt(purse())} — the sea takes no IOUs.`, true);
  } else {
    const max = T.maxStake(state.bank, target, OPTS);
    if (q.stake > max) return sayTide(`Over the house limit — most it will take here is ${fmt(max)}.`, true);
  }
  let height;
  try { height = Number(await tideText('/blocks/tip/height')); } catch (e) { return sayTide(e.message, true); }
  if (SEAL) {
    // The stake leaves the purse NOW, as a signed trail move — win or lose,
    // this transition stands; a win signs its payout at settlement.
    try { await signSealTx(-q.stake); } catch (e) { return sayTide(e.message, true); }
  }
  const bets = loadTide();
  bets.push({
    height,                       // block height+1 is the seed nobody has seen
    nonce: $('tide-nonce').value || randomSeed().slice(0, 16),
    target: q.target,
    stake: q.stake,
    sealed: !!SEAL,
    status: 'riding',
    at: Date.now(),
  });
  saveTide(bets);
  $('tide-nonce').value = randomSeed().slice(0, 16); // fresh mark for the next cast
  sayTide(`Cast. Block ${(height + 1).toLocaleString('en-GB')} decides — press the button when the tide turns.`);
  paintTide(); paintSeal();
}

async function tideCheck() {
  const bets = loadTide();
  const riding = bets.filter((b) => b.status === 'riding');
  if (!riding.length) return sayTide('Nothing riding.');
  let tip;
  try { tip = Number(await tideText('/blocks/tip/height')); } catch (e) { return sayTide(e.message, true); }
  let settled = 0;
  for (const b of riding) {
    if (b.height + 1 > tip) continue;               // that block is still at sea
    let blockHash;
    try { blockHash = (await tideText(`/block-height/${b.height + 1}`)).toLowerCase(); }
    catch { continue; }                             // next press will find it
    const hash = await sha256(`${blockHash}|${b.nonce}`);
    const r = T.rollFromHash(hash);
    if (b.sealed) {
      // Sealed rounds play against the sea, not the play bank: quote() prices
      // it, `roll > target` decides it (settle()'s rule, minus the bankroll),
      // and a win is a signed +payout onto the slip. If signing fails the bet
      // keeps riding — a win must never be recorded unsigned.
      const q = T.quote(b.target, b.stake, OPTS);
      const win = r > b.target;
      const payout = win ? Math.floor(q.payout) : 0;
      if (win) {
        try { await signSealTx(payout); } catch (e) { sayTide(e.message, true); continue; }
      }
      Object.assign(b, { status: win ? 'won' : 'lost', roll: r, payout, blockHash, hash });
      settled++;
      continue;
    }
    const out = T.settle({ bankroll: state.bank, target: b.target, stake: b.stake, roll: r, opts: OPTS });
    if (out.error) { b.status = 'refused'; b.reason = out.error; continue; }
    state.bank = out.bankroll;
    Object.assign(b, {
      status: out.win ? 'won' : 'lost',
      roll: out.roll,
      payout: out.payout,
      blockHash,
      hash,
    });
    settled++;
  }
  saveTide(bets);
  sayTide(settled
    ? `${settled} wager${settled > 1 ? 's' : ''} settled by the chain.`
    : 'The deciding block is still at sea. Blocks come when they please.');
  paintBank(); paintQuote(); paintTide(); paintSeal();
}

function paintTide() {
  const list = $('tide-bets');
  list.textContent = '';
  const bets = loadTide();
  for (const b of [...bets].reverse().slice(0, 8)) {
    const p = document.createElement('p');
    p.className = 'hint';
    const head = `⚓ ${fmt(b.stake)} above ${b.target}`;
    if (b.status === 'riding') {
      p.textContent = `${head} — riding; block ${(b.height + 1).toLocaleString('en-GB')} decides.`;
    } else if (b.status === 'refused') {
      p.textContent = `${head} — refused at settlement: ${b.reason}.`;
    } else {
      p.textContent = `${head} — the chain rolled ${b.roll}: `
        + (b.status === 'won' ? `you take ${fmt(b.payout)}. ` : 'the bank keeps it. ');
      const a = document.createElement('a');
      a.href = '#verify';
      a.textContent = 'check it';
      a.addEventListener('click', () => {
        // hand the round to the verifier: block hash as the seed, no commitment
        $('v-commit').value = '';
        $('v-seed').value = b.blockHash;
        $('v-nonce').value = b.nonce;
        $('v-roll').value = String(b.roll);
      });
      p.appendChild(a);
    }
    list.appendChild(p);
  }
}

// ---------------------------------------------------------------- verifier

async function verify() {
  const commitment = $('v-commit').value.trim();
  const seed = $('v-seed').value.trim();
  const nonce = $('v-nonce').value;
  const rollRaw = $('v-roll').value.trim();
  if (!commitment && seed) {
    // A tide round: the seed is a block hash, and the chain itself is the
    // commitment — there is nothing else to check it against here. Verify the
    // roll follows, and send the reader to any block explorer for the hash.
    const hash = await sha256(`${seed}|${nonce}`);
    const expected = T.rollFromHash(hash);
    if (expected == null) {
      $('v-out').textContent = '✗ the seed is not a usable hash.';
      $('v-out').className = 'verdict bad';
      return;
    }
    const claimed = rollRaw === '' ? null : Math.floor(Number(rollRaw));
    const ok = claimed == null || claimed === expected;
    $('v-out').textContent = ok
      ? `✓ the roll follows: ${expected}. Block-seed round — confirm the block hash itself on any explorer.`
      : `✗ the roll does not follow from the hash — it should have been ${expected}.`;
    $('v-out').className = 'verdict ' + (ok ? 'good' : 'bad');
    return;
  }
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
$('tide-bet').addEventListener('click', tideBet);
$('tide-check').addEventListener('click', tideCheck);
for (const id of ['target', 'stake']) $(id).addEventListener('input', paintQuote);

// Query-string prefill — the modular seam for other apps: a game can send a
// player here with ?stake=&target=&mark= and the table is already set.
{
  const qp = new URLSearchParams(location.search);
  if (qp.get('stake')) $('stake').value = qp.get('stake');
  if (qp.get('target')) $('target').value = qp.get('target');
  $('tide-nonce').value = qp.get('mark') || randomSeed().slice(0, 16);
}

paintBank();
newRound();
paintTide();
paintSeal();
