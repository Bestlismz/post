# Command center architecture

## Problem

The POC has one durable JSON writer, one browser lease, and a reservation that locks a Group target before the remote click. Multi-group analysis and Messenger add asynchronous work. The new code must keep the existing Group lock and prevent duplicate Messenger sends without adding a production queue to this Docker POC.

## Caller usage

Express parses transport input and calls one application object. Routes do not coordinate persistence, OpenAI, Chromium, or Meta.

```js
const center = createCommandCenter({ store, site, analyzer, generator, meta, clock });

await center.start();
const group = await center.execute({ type: "group.add", rawUrl });
const scan = await center.execute({ type: "group.scan", groupId: group.id });
const view = await center.query({ type: "workspace" });
```

The raw Meta route verifies and persists accepted events before it returns `200`. A worker handles queued events after acknowledgement.

```js
const accepted = await center.webhooks.acceptMeta({ rawBody, signature });
response.status(200).json({ accepted: accepted.newEvents });
```

## Shape

`Version3State` stores maps keyed by stable domain identity.

- `groups[groupId]` owns Group configuration and scan status.
- `targets[targetKey]` retains existing target keys.
- `analyses[targetKey]` records both the target and business-profile fingerprints.
- `submissions[targetKey]` remains a permanent Group send lock.
- `messengerMessages[pageId:mid]` is the inbound deduplication record.
- `messengerOutbound[pageId:mid]` is the only outbound attempt for that inbound message.
- `messengerThreads[senderId]` owns bot, handoff, or paused status plus a mode revision.

`src/state.mjs` remains the only physical writer. It exposes capability-specific operations rather than a callback that can replace the full document. Group code cannot edit Messenger maps, and Messenger code cannot edit Group submissions.

The application facade has `start`, `close`, `query`, `execute`, and authenticated webhook ingestion. Its command union is the only capability registry. Channel modules own their rules behind that facade.

```text
server.mjs
    |
command-center.mjs
    |-- groups.mjs -> relevance.mjs -> browser.mjs
    |-- group-replies.mjs -> browser.mjs
    |-- messenger-worker.mjs -> reply-policy.mjs -> meta-client.mjs
    |
state.mjs
```

Group preflight, reservation, and the remote click stay under the same browser lease. Only a reservation with `created: true` can reach `submitOnce`.

Messenger writes an outbound reservation before Meta I/O. The worker rechecks enabled state, thread mode revision, the reply window, and rate limits in a claim-send transition. A duplicate event sees the same inbound and outbound keys. A `sent`, `rejected`, or `unknown` attempt is terminal for automatic dispatch.

## Synthesis decision

Candidate A is the base because its facade and sole-writer model fit the existing process and it uses a keyed sender actor to order takeover against bot work. The design does not expose Candidate A's generic full-state transition callback. Private capability transitions prevent split semantic ownership.

The design adopts two parts from Candidate B. A separate `messengerOutbound[inboundKey]` map removes overlap between event deduplication and message history. Deterministic per-sender and global rate limits constrain runaway replies. Runtime configuration derives Page readiness from environment values instead of persisting a `configured` boolean.

Candidate B's generic work and event machinery is rejected. It adds command, decision, event, work, and workflow layers to a small JavaScript POC. Its original reservation-to-network gap also allowed takeover to race a send.

## Tradeoffs accepted

- The store rewrites one bounded JSON document so cross-record reservations stay atomic.
- Group scans and Messenger draining start sequentially so tests and browser ownership remain deterministic.
- An ambiguous remote outcome remains locked to prevent a duplicate customer message.
- Short polling updates the Messenger UI. A production deployment can replace the JSON store and polling together.

## Next step

Implement the version-3 migration and capability-specific state operations. Prove that a migrated verified Group submission remains locked before adding new routes.

