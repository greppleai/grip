# Remote session storage server

Example Hono server for Grip remote sessions. It stores each session as a JSONL file for easy inspection and uses a static bearer token.

This server is for protocol development only. It does not provide atomic publication, process-safe concurrency, tenant isolation, TLS, or power-loss durability and must not be used to certify a production remote session service. The client supports services with optional ETags, but a service that omits ETags has only a single-client consistency assumption.

## Run

```bash
GRIP_REMOTE_SESSION_TOKEN=dev-token \
GRIP_REMOTE_SESSION_DIR=/tmp/grip-remote-sessions \
npx tsx packages/coding-agent/examples/remote-session-server/server.ts
```

The server listens on `http://localhost:8787` by default. Override with `PORT`. Requests and session operations are logged to stdout.

## Use from the Grip CLI

From the repo root:

```bash
GRIP_REMOTE_SESSION_BASE_URL=http://localhost:8787 \
GRIP_REMOTE_SESSION_TOKEN=dev-token \
./grip-test.sh
```

Equivalent flags:

```bash
./grip-test.sh --remote-session-base-url http://localhost:8787 --remote-session-token dev-token
```

Optional project id:

```bash
GRIP_REMOTE_PROJECT_ID=my-project \
GRIP_REMOTE_SESSION_BASE_URL=http://localhost:8787 \
GRIP_REMOTE_SESSION_TOKEN=dev-token \
./grip-test.sh
```

## Use from the SDK

```ts
import { GripAgent, RemoteSessionManager } from "@greppleai/grip";

const sessionManager = new RemoteSessionManager({
  baseUrl: "http://localhost:8787",
  token: "dev-token",
  cwd: process.cwd(),
});

const grip = await GripAgent.create({ sessionManager });
const session = await grip.createAgentSession();
await session.prompt("hello from a remote session");
await session.waitForIdle();
await grip.dispose();
```

Sessions are stored as `<session-id>.jsonl` under `GRIP_REMOTE_SESSION_DIR`.

## API covered

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/recent`
- `GET /v1/sessions/:id`
- `POST /v1/sessions/:id/entries`
- `PUT /v1/sessions/:id/snapshot`
- `POST /v1/sessions/:id/fork`
- `POST /v1/sessions/import-jsonl`
