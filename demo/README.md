## Demo 

`npm run build`

## Swarm storage (serverless persistence)

Opt-in: set `VITE_BEE_API_URL` (e.g. `http://localhost:1633`) in `demo/.env`,
or open the demo in a Swarm-aware browser that injects `window.swarm` — then
sheet snapshots are AES-256-GCM encrypted and stored on Ethereum Swarm, with
a feed per sheet as the mutable "latest" pointer (feed history doubles as
version history).

- `VITE_SWARM_POSTAGE_BATCH_ID` pins a postage batch; without it the first
  usable batch on the node is auto-discovered. A node with no batch still
  reads — the demo runs read-only and offers to buy/extend a batch in-app.
- The URL fragment carries the feed owner key and the sheet's decryption key
  (`#skey=owner:doc`), so the address bar is the share link. Pure-Swarm mode
  is single-writer: a sheet opened from someone else's link is readable but
  not writable (through a provider, which signs only as itself).
- Edits made while Swarm is unreachable are held locally (IndexedDB +
  localStorage keep working) and go out when the node returns.

The Swarm tests that need a real Bee node run when one is reachable at
`BEE_API_URL` (default `http://localhost:1633`) in the state they test, for
example with a usable postage batch; otherwise they are skipped.
