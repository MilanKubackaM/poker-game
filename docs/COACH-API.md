# Coach API

A read-only interface for helper apps that follow a game from one player's point of view: opponent statistics, advice,
hand review. It carries exactly what that player sees at the table, in structured form. It cannot play, change settings,
chat or touch money.

Types: [`shared/coach.ts`](../shared/coach.ts). Implementation: [`server/coach/`](../server/coach/).

## Who can read it

- **Only an account.** There is no endpoint without a token. The token comes from `coach:login` (email or username and
  password, the same limits as the game login) and is a separate kind of session: it works only on this API, and a normal
  game token does not work here. The reverse holds too, so a coach token cannot play, upload a photo or open the game socket.
- Tokens are stored as SHA-256 hashes, last 30 days since last use, are limited to 5 per account and are revoked by a
  password change or reset and by `coach:logout`. A revoked token disconnects its open connections within a minute.
- **A table is readable only by the player who sits at it.** `coach:subscribe` fails for anyone else.
- **Browser origins.** The socket lives on its own path (`/coach-io`) and its own Socket.IO server, so allowing a helper's
  address in `COACH_ORIGINS` does not open the game socket. A page from another origin is refused before the handshake.
  This stops other websites, not other programs: a program can set any `Origin`, and a helper app's code is public, so
  no secret key inside it would stay secret. The protection is what the API returns, not who calls it. A program with a
  valid token receives only what the player already sees.
- Connections per IP and events per second are limited.

## What it never sends

- Other players' hidden cards. A card arrives only when it is visible to the player: their own, the board, shown hands,
  hands tabled by an all-in before the runout. Card visibility comes from `Table.liveView`, the same function the
  player's screen uses; the coach state is built from that view and nothing else.
- The shuffle seed before the game ends, tokens, emails, photos. `coach:proofs` returns the same proofs a player gets from
  the game (`fair:proofs`): the server seed is `null` until the game ends. The proofs use the table's own player ids, which
  every table member already sees, because the ids go into the shuffle key; `pids` maps them to the stable `pid`.
- The discarded card in Pineapple.

`pid` is a stable id of an account (an HMAC of the account id with a server secret, the same at every table, not
reversible to the email or the internal id). Seats from before accounts get a per-table `pid`.

## Connecting

```ts
import { io } from 'socket.io-client';
const socket = io('https://<server>', { path: '/coach-io', transports: ['websocket'], auth: { token } });
socket.on('coach:hello', ({ apiVersion, authenticated }) => { /* ... */ });
```

Without a token, connect, call `coach:login` and reuse the returned `token` in `auth` on later connections.
Always check `apiVersion`; it increases when an incompatible change is made.

| Client → server | Payload | Ack |
| --- | --- | --- |
| `coach:login` | `{ login, password }` | `{ token, username, you }` |
| `coach:logout` | | |
| `coach:tables` | | tables where the account sits (`TableSummary[]`) |
| `coach:subscribe` | `{ code }` | `{ you }`, then the running hand is replayed and a state follows |
| `coach:unsubscribe` | `{ code }` | |
| `coach:proofs` | `{ code }` | shuffle proofs of the dealt hands, `revealed`, `revealAt`, `pids` |

| Server → client | Meaning |
| --- | --- |
| `coach:hello` | `apiVersion`, `serverVersion`, whether the token was accepted |
| `hand:action` | one action of the hand, in order (`seq` from 1 per hand) |
| `coach:state` | the whole table state from the player's view, sent after every change that alters it (`rev` grows by 1) |
| `coach:closed` | the subscription ended (`deleted`, `removed`, `left`) |
| `coach:revoked` | the token is no longer valid |

## Reading a hand

`hand:action` carries `type`: `sb`, `bb`, `return-blind`, `fold`, `check`, `call`, `bet`, `raise`, `discard`,
`uncalled`. `amount` is the chips an action added to the pot (for `uncalled` the chips returned to the player, which
shrink the pot), `toAmount` the player's bet on the street afterwards, `potBefore` the pot just before it, including
ante and dead money. `allin` marks an all-in, `auto` an action the server took for the player (timeout, short break,
kick). Nothing is skipped or merged: a state sent later reflects every action sent before it, so pot, contributions
and bets can be rebuilt from the actions alone (`tools/sim` in the Coach repository checks this against the state).

`coach:state` is a projection of the table view: `settings` (blinds, variant, 7-2 and its bounty), `players`
(stack, bet, `cards`, status, `isYou`), `hand` (rules, street, boards including the second board of Double Board and
extra runs, pots, who is to act), `legal` (the player's legal actions when on turn), `lastResult`, `nextHand` (an
announced variant), `doubleBoard`, `piggy` (amount, entry, target, rings per player, contributions, series),
`modeIntro`, `runVote`, `rabbit`, `anteAmount`.

## Configuration

`COACH_ORIGINS` is a comma-separated list of browser origins allowed to open the socket. Native and server-side
clients send no `Origin` and are not affected by it. The secret for `pid` is created on first start in
`DATA_DIR/coach-secret.key`; keep it with the rest of the data, because changing it changes every `pid`.
