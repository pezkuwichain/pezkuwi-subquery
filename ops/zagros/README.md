# Zagros Asset Hub history (explorer host)

Serves `HistoryElement` for Zagros Asset Hub to explorer.pezkuwichain.io. It
runs on the explorer host next to its own archive node, never on the mainnet
indexer host (`deploy-vps` ignores `zagros-assethub.yaml`,
`docker-compose.zagros.yml` and this directory).

## Pieces

| piece | where | listens |
|---|---|---|
| archive node `zagros-ah-archive` (systemd, `--state-pruning archive --blocks-pruning archive`, relay followed over RPC) | host | RPC 127.0.0.1:9955 |
| postgres 16 | compose | 127.0.0.1:5433 |
| subql-node, `zagros-assethub.yaml` | compose | 3101 (firewalled) |
| subql-query | compose | 3100 (firewalled); nginx exposes `POST /history/assethub` only |

## Build and start

```sh
git clone https://github.com/pezkuwichain/pezkuwi-subquery /opt/zagros-history
cd /opt/zagros-history
# Build the mapping (dist/) without installing Node on the host.
docker run --rm -v "$PWD":/w -w /w node:24-alpine sh -c \
  'corepack enable && yarn install --immutable && yarn subql codegen zagros-assethub.yaml && yarn subql build zagros-assethub.yaml'
printf 'ZAGROS_DB_PASS=%s\n' "$(openssl rand -hex 24)" > .env.zagros && chmod 600 .env.zagros
docker compose -f docker-compose.zagros.yml --env-file .env.zagros up -d --build
```

## Check

```sh
curl -s -X POST 127.0.0.1:3100 -H 'content-type: application/json' \
  -d '{"query":"{_metadata{lastProcessedHeight targetHeight}}"}'
```

`targetHeight - lastProcessedHeight` above 100 for ten minutes means the
indexer has stalled; the explorer then shows "on its way" for payments it has
not seen yet.
