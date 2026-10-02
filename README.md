# SQLite-backed named counters — JavaScript

A Worker routes each counter name to its own Durable Object and private SQLite database. Atomic updates preserve every increment, including concurrent ones.

## Pattern At A Glance

| | |
|---|---|
| Difficulty | Intermediate |
| Build time | 10 minutes |
| Runtime | Cloudflare Workers and Durable Objects |
| Language | JavaScript |
| Framework | No framework |
| Data store | SQLite in each Durable Object |

## What It Implements

- `GET /` describes the API; `GET /health` exposes a stable deployment marker.
- `GET /counter/{name}` reads one persisted count, initially zero.
- `POST /counter/{name}/increment`, `/decrement`, and `/reset` update it.
- `POST /counter/{name}/set` accepts `{"value":7}`; the JSON body is capped at 1024 bytes.
- Names are 1–40 ASCII letters, digits, hyphens, or underscores. Integers are limited to -1,000,000 through 1,000,000; out-of-range updates return HTTP 409.

## Where It's Applicable

Per-room or per-user coordination, votes, inventories, and other workloads needing strong consistency for **one entity at a time**. Each distinct name uses a different object. This example is a counter, not a chat room or a WebSocket application.

## How It Works

1. The front Worker validates the path, method, and optional body before selecting `env.COUNTER.getByName(name)`.
2. The `Counter` class creates its SQLite table and initial row idempotently on construction. Storage lives with the object, not in Worker memory.
3. RPC methods read or change the row. Each increment/decrement is one parameterized, synchronous `UPDATE … RETURNING` statement. There is no `await` between reading and writing a count.
4. The API returns the persisted value with `cache-control: no-store`. Another name selects another object and database.

`wrangler.jsonc` declares a SQLite-backed class via `exports`. New namespaces are supported on Workers Free and Paid plans. This project uses a new Worker name; switching the `storage` setting of an existing KV-backed class would not migrate its data.

## Prerequisites

- Node.js 22 or later.
- A Cloudflare account for a lasting deployment. The pattern page also offers a temporary-account deployment when available.

## Setup

From this implementation directory, run `npm ci`. Dependencies are pinned by `package-lock.json`.

## Run Locally

Run `npm run dev`. Wrangler serves the Worker and local Durable Objects at `http://localhost:8787`.

## Deploy Remotely

Authenticate with `npx wrangler login`, run `npm run check`, then `npm run deploy`. Wrangler creates the SQLite namespace and prints your `workers.dev` URL. Do not remove the `exports.Counter` declaration on later deploys.

## Test Locally

Use a fresh name to avoid another visitor's state:

```sh
BASE=http://localhost:8787
NAME=demo-$(date +%s)
curl "$BASE/health"
curl "$BASE/counter/$NAME"                  # count: 0
curl -X POST "$BASE/counter/$NAME/increment" # count: 1
curl -X POST "$BASE/counter/$NAME/set" -H 'content-type: application/json' -d '{"value":7}'
curl "$BASE/counter/$NAME"                  # count: 7
curl "$BASE/counter/$NAME-other"            # count: 0 (separate object)
```

Check concurrent increments on a new name:

```sh
NAME=parallel-$(date +%s)
for i in $(seq 1 12); do curl -fsS -X POST "$BASE/counter/$NAME/increment" >/dev/null & done
wait
curl "$BASE/counter/$NAME" # count: 12
```

Try `POST /counter/$NAME/set` with `{"value":1.5}` (HTTP 400), an invalid name (HTTP 400), or `GET /counter/$NAME/increment` (HTTP 405). Set to 1000000 and then increment to see HTTP 409 without changing the count.

## Test Remotely

Set `BASE` to the URL Wrangler prints, such as `https://workers-durable-objects-javascript.your-subdomain.workers.dev`, then repeat the local tests with a new name. Redeploy the **same** Worker and read that name again: its value persists. The hosted demo and API console on the pattern page use a shared public namespace; choose a unique name.

## Cleanup

To remove the Worker, run `npx wrangler delete workers-durable-objects-javascript`. To retire the class **and its stored data**, follow the [Durable Object class deletion procedure](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class) before removing the Worker; that deletion is irreversible.

## Watch Out For

- Public demo names are untrusted inputs, not authenticated user IDs; anyone who knows one can modify that counter.
- A single busy counter is handled by one object. Partition by real coordination keys and account for per-object throughput and storage limits.
- There are no WebSockets, alarms, broadcasts, authentication, or write quotas in this teaching example.
- The former TypeScript example used `new_classes` (legacy KV backend). SQLite cannot replace that namespace in place.

## Production Fit

Derive counter names from verified identity, authorize reads and writes, add rate limiting and monitoring, and budget for stored state. Keep the atomic SQL mutation when you add features; a JavaScript read–`await`–write sequence can lose concurrent updates. Plan a deliberate migration and backup before renaming or deleting a Durable Object class.

## Pattern and live demo

- [Pattern page](https://serverless.build/patterns/worker-durable-objects)
- [Live deployment](https://workers-durable-objects-javascript.dwarven.workers.dev)
