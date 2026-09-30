# dekit-router

Port-less local preview URLs for [dekit](https://dekit.run) stacks.

Several people or agents run the same multi-service app on one machine, each
from their own checkout. Each stack registers with one machine-wide router,
which gives it:

- **a free group of ports**. The router picks them, checks every port is free
  on IPv4 and IPv6, and remembers them, so stacks never collide;
- **URLs with no port in them**, derived from the stack's name:

```
http://this-fix-kimi.cqx.localhost            ← the stack's main service
http://id.this-fix-kimi.cqx.localhost
http://dashboard.this-fix-kimi.cqx.localhost
```

`*.localhost` resolves to this machine in browsers and on macOS and Linux
with no DNS setup. The router listens on port 80 and proxies by `Host`,
WebSockets included, so dev-server hot reload works. Redirects that a dev
server builds from its own port are rewritten back to the port-less URL.

### One OAuth callback, many stacks

GitHub and most OAuth providers allow **one** callback URL per app. Point a
product's dev apps at `http://github.<product>.localhost/<callback path>` and
put the stack's name at the front of `state` (`<stack>~<random>`). The router
sends the browser on to that stack's service for the path, as registered with
`--relay`.

## Install

```sh
bun run install:local        # builds a single binary into ~/.local/bin/dekit-router
dekit-router setup           # adds the router to dekit's host runner and starts it
```

`setup` writes `~/.config/dekit/host/dekit-router.yaml` and loads it from the
host runner's `dekit.yaml`. `dekit attach host::dekit-router` shows its log.
macOS lets an ordinary user listen on port 80. `DEKIT_ROUTER_PORT` changes
the port.

## Use from a stack's launcher

```sh
dekit-router register cqx this-fix-kimi \
  --services main,id,dashboard --near 3000 \
  --relay /connect/callback=main --relay /auth/github/callback=id
```

It prints JSON with each service's `port`, `host` and `url`. Start your
services on those ports, for example with dekit, passing the ports and the
stack name as environment variables. When the stack stops, free its entry:

```sh
dekit-router release cqx this-fix-kimi
dekit-router ls
```

`register` starts the router through dekit's host runner if it isn't
answering. Registering the same stack again returns the same ports.

## Control API

On `http://router.localhost` (JSON):

| | |
|---|---|
| `POST /stacks` | `{product, stack, services: ["", "id", …], near?, relay?}` → the assignment |
| `DELETE /stacks/<product>/<stack>` | release |
| `GET /stacks` | everything registered |

State lives in `~/.local/state/dekit-router/state.json` (`DEKIT_ROUTER_STATE`).

## Develop

```sh
bun test
bun run build
```

Not affiliated with dekit. It's a companion that runs under dekit's host
runner.

## License

Apache-2.0
