# @cryptoapis-io/x402-buyer-sdk

A `fetch` wrapper that transparently **pays HTTP 402 responses** with x402: it parses the merchant's
price, gets the signing payload from the CryptoAPIs buyer service, **signs locally**, and retries — so
your agent/app just calls `fetch` and paywalled endpoints Just Work.

**Non-custodial:** the SDK holds no keys. You provide a `signer` (e.g. wrapping
`@cryptoapis-io/mcp-signer`); signing happens in your process. v1 supports the EVM `eip712` scheme
end-to-end (the only enabled chain).

## Install

```bash
npm install @cryptoapis-io/x402-buyer-sdk
```

## Use

```js
import { createX402Fetch } from '@cryptoapis-io/x402-buyer-sdk';
import { Wallet } from 'ethers';

const wallet = new Wallet(process.env.PRIVATE_KEY); // your key — never leaves your process

const fetch402 = createX402Fetch({
    apiKey: process.env.CRYPTOAPIS_API_KEY,   // buyer key (X402_BUYER feature)
    walletId: 'your-agent-wallet-id',          // the wallet the buyer service pays from
    signer: {
        // EVM eip712: sign the typed-data the buyer /authorize returns
        signTypedData: (td) => wallet.signTypedData(td.domain, stripDomain(td.types), td.message),
    },
});

// Paywalled endpoints just work — a 402 is auto-paid and the request retried.
const res = await fetch402('https://api.example.com/premium');
const data = await res.json();
```

`stripDomain` = drop the `EIP712Domain` entry from `types` (ethers adds it). If you use
`@cryptoapis-io/mcp-signer` `evm_sign` `sign-typed-data`, it handles that for you — pass the whole
`{domain, types, primaryType, message}`.

## How it works

On a `402`, the wrapper:
1. Parses `accepts` (the merchant's PaymentRequirements) and picks one (respecting `allowedNetworks`).
2. POSTs it to the CryptoAPIs buyer **`/authorize`** → `{ scheme, signing }` (the artifact to sign).
3. Calls your **`signer`** locally to sign it (keys never enter the SDK).
4. Builds the x402 `PaymentPayload`, base64-encodes it into the **`X-PAYMENT`** header, and retries the
   original request once.

A non-402 response passes through untouched. A 402 with no acceptable network is returned unchanged.

## Config

- `apiKey` (required) — buyer CryptoAPIs key (X402_BUYER feature).
- `walletId` (required) — the agent wallet the buyer service authorizes payments from.
- `signer` (required) — non-custodial signing interface. EVM: `{ signTypedData(typedData): Promise<string> }`.
- `allowedNetworks` — restrict which CAIP-2 networks the wallet will pay on (e.g. `['eip155:8453']`).
- `baseUrl` — buyer service base URL (default `https://ai.cryptoapis.io/x402/buyer`; set for QA/local).

## Roadmap

v1 = EVM `eip712`. The signer dispatch is per-scheme, so SVM (`svm-transaction`) / UTXO / XRP / Kaspa
paths slot in as their signer wiring lands (see `@cryptoapis-io/mcp-signer`).
