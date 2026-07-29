# tavern

Provably-fair wager maths for a game economy. Sibling of
[tidepool](https://github.com/melvincarvalho/tidepool) — same shape, same
discipline: a pure core you can lift into a server unchanged, plus a static
page that demonstrates it and, more usefully, **verifies rounds settled
elsewhere**.

Play money. No real stakes, no custody, no network.

**[Open the tavern →](https://melvincarvalho.github.io/tavern/)**

## What's here

| file | what it is |
|---|---|
| `tavern.js` | the whole of the maths — pure, zero dependencies, no clock, no DOM, no crypto |
| `tests.js` | 93 checks, `node tests.js` |
| `index.html` / `app.js` / `style.css` | the demo, and the verifier |

`tavern.js` imports nothing and touches nothing. No `Math.random`, no
`Date.now`, no `fetch`, no `process` — the test suite asserts this, because the
point is that a server can import the file as-is.

## The fairness scheme

Commit–reveal, with the player contributing entropy:

1. the house picks a secret seed and publishes `commitment = H(seed)`
2. the player bets, supplying their own nonce
3. the house reveals `seed`; anyone computes `H(seed | nonce)` and derives the
   roll from it

The commitment binds the house before it sees the bet. The player's nonce stops
it choosing a seed to suit a bet it has already seen. Neither party alone
decides the outcome.

```js
import { rollFromHash, verifyRound } from './tavern.js';

const roll = rollFromHash(await sha256(`${seed}|${nonce}`));   // 1..100

verifyRound({
  commitment,                        // published before the bet
  seedHash: await sha256(seed),      // must equal it
  computedHash: await sha256(`${seed}|${nonce}`),
  roll,                              // optional; checked if given
});
// -> { ok: true, roll } | { ok: false, reason: 'commitment' | 'roll' | 'hash' | 'missing' }
```

Hashing is the caller's job. The module takes hex strings, because the hash
function differs by host — WebCrypto in a browser, `node:crypto` on a server —
and the maths should not care.

### What the static page cannot do

Commit–reveal only means something when the party publishing the commitment
cannot change the seed afterwards. Run entirely client-side, the page holds the
seed and could cheat freely. That is stated plainly at the top of it.

The page is for two things: playing with the numbers, and **independently
verifying a round somebody else settled**. The verifier is static and offline,
so it works against any server, and you can read it before you trust it.

## Pricing

One bet type: *the roll will be strictly above `target`*, on a d100.

```
chance     = (sides - target) / sides
fair       = 1 / chance
multiplier = fair × (1 - edgeBps / 10000)      // payout includes the stake
```

The house edge is the only thing separating the bank from a coin flip, so
`quote()` refuses a negative or ≥100% edge and falls back to the default rather
than obeying a configuration mistake.

## The risk limit

A bank must survive its worst round. `maxStake()` caps the bank's **exposure**,
not the stake:

```
maxStake = bankroll × maxRiskFrac / (multiplier - 1)
```

Capping the stake instead would be useless — a 99× bet risks a hundred times
more per unit staked than an even-money one. The limit is enforced inside
`settle()`, not only in the UI, so a crafted request cannot get round it.

## The bank is a liquidity pool

Providers deposit, receive shares, and the house edge accrues to them exactly
as swap fees accrue in an AMM. `bankrollAdd` / `bankrollRemove` / `shareValue`
are lifted from tidepool's share accounting, including the two lessons it cost:

- a first deposit must not mint shares against an empty bank
- a burn must never *grow* the bank

Both are tested, and both mutants are caught.

## Testing

```sh
node tests.js
```

93 checks. Every block has been verified by mutating `tavern.js` and confirming
the suite goes red — twelve mutants, all caught, including:

- the edge silently not applied (the bank bleeds)
- `maxStake` capping the stake rather than the exposure
- `settle` not enforcing the limit
- the win boundary drifting from `>` to `>=`
- a win paying the full payout out of the bank rather than the profit
- a negative burn growing the bankroll

A test that cannot fail is worse than no test, so the suite is checked the same
way the game engine it came from is.

## Status

Client-side only, deliberately, to see how far the pure core gets before a
server is needed. It gets as far as *everything except holding value*: escrow,
a commitment that binds, and a bankroll anyone can trust all need a party the
player cannot edit.

## Licence

AGPL-3.0-or-later.
