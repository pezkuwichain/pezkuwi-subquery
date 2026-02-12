# Pezkuwi SubQuery

SubQuery indexer for Pezkuwi blockchain - provides staking rewards, NominationPools, transfers and era validator data for PezWallet.

## Projects

- **pezkuwi.yaml** - Pezkuwi Relay Chain staking indexer
- **pezkuwi-assethub.yaml** - Pezkuwi Asset Hub NominationPools and transfers indexer

## Features

- Staking rewards (Reward/Rewarded events)
- Nomination Pool rewards (PaidOut events)
- Slashing events (Slash/Slashed, PoolSlashed, UnbondingPoolSlashed)
- Native transfers (balances.Transfer)
- Asset transfers (assets.Transferred) - Asset Hub only
- Era validator information (StakersElected/StakingElection)
- Full transaction history (signed extrinsics)

## Get Started

### Install dependencies

```shell
yarn install
```

### Build

```shell
yarn build
```

### Local Development

```shell
sh local-runner.sh pezkuwi.yaml
```

### Deploy to SubQuery Network

```shell
./node_modules/.bin/subql publish -f pezkuwi.yaml
./node_modules/.bin/subql publish -f pezkuwi-assethub.yaml
```

## Endpoints

- **Pezkuwi Relay**: wss://rpc.pezkuwichain.io
- **Pezkuwi Asset Hub**: wss://asset-hub-rpc.pezkuwichain.io

## License

Apache 2.0 - Based on Nova SubQuery implementation
