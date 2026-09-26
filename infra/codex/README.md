# Local Codex run box

This container simulates the remote **machine**, not the agent. It runs real `@openai/codex@0.157.1` app-server. Model turns require a valid OpenAI account/API credential and network access. It does not provision AWS or provide a GPU.

Build once from the repository root:

```sh
node --input-type=module -e 'import {prepareCodexImage} from "./lib/codex-docker.mjs"; await prepareCodexImage()'
```

`createCodexDockerRuntime({sessionId, installId, onNotification, onExit})` starts or reconnects an installation/session-scoped container and completes the app-server `initialize` / `initialized` handshake. It returns `request(method, params)`, `close()`, and asynchronous `stop()`. `onNotification(method, params)` receives parsed server notifications. `onExit({message})` reports a safe transport status once, including an explicit close. Credentials are supplied only by the calling backend through the `account/login/start` request over stdin. This transport never logs protocol or stderr contents and never passes model credentials in Docker arguments or environment variables.

The image runs as `node` with a read-only root, a private writable `/tmp`, dropped capabilities, no-new-privileges, and CPU/memory/process limits. Each session has one named `/home/node` volume containing its workspace and Codex session/auth state. There are no host paths, Docker socket mounts, or published ports. This is a local trusted Docker-host boundary, not hardened multi-tenant isolation: containers have outbound network access, and Docker operators can inspect their volumes. Do not expose this service publicly or send host secrets into the workspace.

Closing the transport leaves the container running for reconnect. Stopping it retains the volume and conversation history. `stopCodexContainer({sessionId, installId})` stops an existing owned container without starting a transport or creating missing resources; use it after a server restart or protocol failure. Removing a container or volume is an explicit operator action, not part of stop. Resource ownership labels and expected container configuration are checked before reconnect. Prepare the image separately; requests never build images implicitly.

Messages are bounded to 2 MiB; at most 32 requests are pending and each times out after 30 seconds. Timeout closes the connection; callers must reconcile persisted server state before retrying a mutation. Interactive approval requests are declined, and other unsupported server requests receive a method-not-found response. Use an explicit sandbox/approval policy when starting threads; never interpret a connected transport as completed agent work.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
