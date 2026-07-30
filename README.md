# @cryptoapis-io/x402-buyer-sdk

**Let your app or AI agent pay for anything behind an [x402](https://x402.org) paywall — automatically.**

Wrap `fetch`, or drop a ready-made tool into your agent. When a server responds `402 Payment Required`,
the SDK reads the price, gets a signing payload from the CryptoAPIs buyer service, **signs it locally with
your key**, and retries — so paywalled endpoints Just Work.

- 🔒 **Non-custodial** — you provide the signer; **private keys never enter the SDK**.
- 🪶 **Zero runtime dependencies** — pure `fetch` + `Buffer`. Node 18+ / any modern runtime.
- 🌐 **Supported today** — EVM (Base, Ethereum, …) and Solana. Tron, Bitcoin/UTXO, XRP and Kaspa are
  **upcoming** (wired but not yet enabled).
- 🤖 **Agent-ready** — one-line adapters for the Vercel AI SDK, LangChain, MCP, and raw function-calling
  (OpenAI / Anthropic / Gemini).

```bash
npm install @cryptoapis-io/x402-buyer-sdk
```

---

## Prerequisite — create an agent wallet (get your `walletId`)

The SDK pays from a CryptoAPIs **agent wallet**, referenced by `walletId` — the buyer service's own record
id, **not** the on-chain address. Register one once (per blockchain+network); it returns the `walletId` you
pass to `createX402Fetch`. **Non-custodial:** you register only your PUBLIC `address` (or an `xpub`); the
private key never leaves your process.

Use the built-in helper (validates the input before the round-trip):

```js
import { createWalletsClient } from '@cryptoapis-io/x402-buyer-sdk';

const wallets = createWalletsClient({ apiKey: process.env.CRYPTOAPIS_API_KEY });

const { walletId } = await wallets.createWallet({
  blockchain: 'base',
  network:    'eip155:8453',            // CAIP-2 id — NOT a bare "base"
  address:    '0xYourWalletAddress',    // your PUBLIC address (required for Solana/Kaspa)
});
// → pass walletId to createX402Fetch({ apiKey, walletId, signer })

await wallets.listWallets();            // your registered wallets (each with its walletId)
```

Or the raw endpoint:

```bash
curl -X POST https://ai.cryptoapis.io/x402/buyer/wallets \
  -H "x-api-key: $CRYPTOAPIS_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "blockchain": "base", "network": "eip155:8453", "address": "0xYourWalletAddress" }'
# → { "walletId": "…", "address": "0xYourWalletAddress", "type": "address" }
```

Required fields (a malformed body returns a clear `400 malformed_request`, never a silent failure):

| Field | Required | Notes |
|---|---|---|
| `network` | ✓ | the **[CAIP-2](https://chainagnostic.org/CAIPs/caip-2) id** — e.g. `eip155:8453` (Base), `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet). **Not** a bare name like `"base"` or `"mainnet"`. |
| `blockchain` | | human name (`base`, `solana`, …) — informational |
| **one of** `address` \| `xpub` | ✓ | **address mode**: bring your own `address` (works on every chain, incl. **Solana/Kaspa which are address-only**). **xpub mode**: supply an `xpub` (+ optional `derivationPath`) on xpub-capable chains — the service derives the address. Supplying neither or both → `400`. |
| `allowedNetworks` | | restrict which CAIP-2 networks this wallet may pay on |
| `limits` | | budget policy — `{ perTxLimit?, dailyLimit?, monthlyLimit? }` (atomic-unit strings; omit a field = no cap for it). **All three ENFORCE** at `/authorize` (per-tx vs the amount; daily/monthly vs the wallet's spend in the UTC day/month window). **Omit `limits` entirely → the wallet gets DEFAULT safety caps** (~$50/tx + $500/day, USDC-denominated) so it's never unlimited by accident; the create response then returns `limits` + `limitsDefaulted:true`. Pass your own `limits` to override the defaults. |

> **Solana / SVM:** create the wallet in **address mode** (`address` = your Solana pubkey, base58) with
> `network: "solana:<genesisHash>"`. Then `/authorize` for SVM also needs the merchant's
> `requirements.extra` to carry `{ feePayer, decimals, tokenProgram }` (see the merchant SDK / facilitator).

## Quick start — a fetch that pays for itself

```js
import { createX402Fetch } from '@cryptoapis-io/x402-buyer-sdk';
import { Wallet } from 'ethers';

const wallet = new Wallet(process.env.PRIVATE_KEY);   // your key — stays in your process

const fetch402 = createX402Fetch({
  apiKey:   process.env.CRYPTOAPIS_API_KEY,           // CryptoAPIs key with the X402_BUYER feature
  walletId: 'your-agent-wallet-id',                   // the id from POST /wallets (a registry _id, NOT the chain address)
  signer:   { signTypedData: (td) => wallet.signTypedData(td.domain, td.types, td.message) },
});

// A normal fetch. A 402 is paid + retried transparently; anything else passes through.
const res  = await fetch402('https://api.example.com/premium');
const data = await res.json();
```

That's it. No manual 402 handling, no header juggling.

---

## Give an AI agent the ability to pay

Same core, wrapped as a tool for every major agent runtime. The agent decides *when* to call it; the SDK
handles the payment.

### Vercel AI SDK

```js
import { x402PayTool } from '@cryptoapis-io/x402-buyer-sdk/ai-sdk';
import { generateText } from 'ai';

const result = await generateText({
  model,
  tools: { x402_pay: await x402PayTool({ apiKey, walletId, signer }) },
  prompt: 'Fetch https://api.example.com/premium and summarize it.',
});
```

### LangChain

```js
import { x402PayTool } from '@cryptoapis-io/x402-buyer-sdk/langchain';

const tool = await x402PayTool({ apiKey, walletId, signer });
// add `tool` to createReactAgent / AgentExecutor / a LangGraph node
```

### OpenAI · Anthropic · Gemini (function calling)

```js
import { x402PayFunction } from '@cryptoapis-io/x402-buyer-sdk/function-calling';

const pay = x402PayFunction({ apiKey, walletId, signer });

// OpenAI:    tools: [pay.openaiTool]
// Anthropic: tools: [pay.anthropicTool]
// Gemini:    functionDeclarations: [pay.geminiTool]

// when the model calls the tool:
const result = await pay.run(JSON.parse(toolCall.arguments));
```

### Paying an x402-gated MCP **tool**

`createX402Fetch` pays HTTP endpoints. Agents call **tools** — so a paid MCP tool needs the `/mcp` export:

```js
import { createX402ToolCaller } from '@cryptoapis-io/x402-buyer-sdk/mcp';

const payToolCall = createX402ToolCaller({ apiKey, walletId, signToPayload });

// Wrap YOUR MCP client's callTool — a challenged tool is paid and retried automatically.
const result = await payToolCall(
  (params) => client.callTool(params),
  { name: 'financial_analysis', arguments: { ticker: 'AAPL' } }
);
```

An unpaid call answers with `isError: true` carrying the price; this reads it (preferring
`structuredContent`, falling back to `content[0].text`), signs locally, and retries **once** with the
payment in `_meta["x402/payment"]`. The receipt arrives in `_meta["x402/payment-response"]` — read it with
`readSettlement(result)`.

A result that is not a payment challenge passes through untouched, and a challenge you decline (say
`allowedNetworks` excludes every option) is returned unpaid so you can see the price and decide.

### Claude Code, Cursor, Codex & other MCP agents

Use **[`@cryptoapis-io/mcp-x402-pay`](https://www.npmjs.com/package/@cryptoapis-io/mcp-x402-pay)** — an MCP
server exposing the same `x402_pay` tool. Add it to your agent's MCP config and it can pay for endpoints
out of the box.

---

## Beyond HTTP — paying MCP tools and A2A agents

x402 defines three transports and this SDK covers all of them. The payment flow is identical
(authorize → sign locally → retry); only the envelope changes.

**MCP — pay another server's tool:**

```js
import { createX402ToolCaller } from '@cryptoapis-io/x402-buyer-sdk/mcp';

const payToolCall = createX402ToolCaller({ apiKey, walletId, signToPayload });
const result = await payToolCall(client.callTool.bind(client), {
  name: 'premium_data',
  arguments: { query: 'gold' },
});
```

A challenge arrives as a tool result with `isError: true`; the payment goes back as a raw object in
`_meta["x402/payment"]`, and the receipt comes back in `_meta["x402/payment-response"]`.

**A2A — pay another agent:**

```js
import { createX402TaskSender, readReceipts } from '@cryptoapis-io/x402-buyer-sdk/a2a';

const payTask = createX402TaskSender({ apiKey, walletId, signToPayload });
const task = await payTask(a2aClient.sendMessage, { message });
const receipts = readReceipts(task);
```

A2A is task-based: a challenge is a task in `input-required` carrying the price under
`x402.payment.required`, and the payment goes back in a **new message** correlated by `taskId`.

Both retry exactly once. A second challenge means the payment was rejected — retrying again would risk
paying twice.

---

## Non-custodial signing — the `signer` contract

The SDK **never holds a key.** You pass a `signer` that signs locally (in your process, KMS, hardware
wallet — your choice). Implement only the chain(s) you use:

| Chain | Status | `/authorize` scheme | `signer` method | Signs |
|---|---|---|---|---|
| **EVM** (Base, Ethereum, Polygon, …) | ✅ Supported | `eip712` | `signTypedData(typedData)` | the EIP-3009 `TransferWithAuthorization` |
| **Solana** | ✅ Supported | `svm-transaction` | `signSvm({ transaction })` | the partial-signed base64 tx |
| **Tron** | 🚧 Upcoming | `tron-transaction` | `signTron({ transaction })` | the TRC-20 transfer |
| **Bitcoin / UTXO** | 🚧 Upcoming | `utxo-transaction` | `signUtxo({ preparedTransaction, network })` | the fully-signed raw tx |
| **XRP** | 🚧 Upcoming | `xrp-transaction` | `signXrp({ transaction })` | the signed `tx_blob` |
| **Kaspa** | 🚧 Upcoming | `kaspa-transaction` | `signKaspa({ preparedTransaction })` | the signed tx JSON |

> **Upcoming** families are wired but not yet enabled — attempting to pay on them returns a clear
> `family_not_yet_supported` ("coming soon") error. EVM and Solana are live and verified end-to-end.

Each maps 1:1 to a tool in **[`@cryptoapis-io/mcp-signer`](https://www.npmjs.com/package/@cryptoapis-io/mcp-signer)**
if you'd rather not implement signing yourself:

```js
import { evmSignTypedData } from '@cryptoapis-io/mcp-signer';

const signer = {
  signTypedData: async (td) =>
    (await evmSignTypedData({ action: 'sign-typed-data', privateKey, ...td })).signature,
};
```

---

## How it works

```
  your fetch/agent ──▶  GET /premium
                         └─ 402 { accepts: [PaymentRequirements] }
        ┌────────────────────────────────────────────────────────┐
        │ 1. pick an acceptable option (allowedNetworks-aware)     │
        │ 2. POST buyer /authorize  →  { scheme, signing }         │
        │ 3. signer.signX(signing)  ←  YOUR key, local only        │
        │ 4. build X-PAYMENT header (base64 PaymentPayload)        │
        └────────────────────────────────────────────────────────┘
                     ──▶  GET /premium  (X-PAYMENT: …)  →  200 + resource
```

A non-402 response passes through untouched. A 402 you can't/won't pay is returned unchanged. Exactly one
authorize→sign→retry cycle per request (no loops).

### Safe retries — `paymentId`

If a response never reaches you, you cannot tell whether the payment settled. Retrying blind risks paying
twice. The [`payment-identifier`](https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md)
extension fixes that: you supply an id, and the facilitator uses it as its **dedup key**, so the same id
settles exactly once no matter how often you retry.

```js
const pay = createX402Fetch({
  apiKey, walletId, signer,
  paymentId: ({ requirements }) => `job_${myJobId}_${requirements.network}`,
});
```

Without it the facilitator falls back to the authorization nonce — correct, but *you* cannot address it,
so you have no safe retry. Ids outside the spec's 16-128 characters are dropped rather than sent: a
silently-ignored idempotency key is worse than an obviously absent one.

---

## Configuration

| Option | Required | Description |
|---|---|---|
| `apiKey` | ✓ | CryptoAPIs API key with the `X402_BUYER` feature |
| `walletId` | ✓ | the buyer-service **wallet record id** returned by `POST /wallets` (the registry `_id`) — **NOT the on-chain address**. Passing an address gets `wallet_not_found`. |
| `signer` | ✓ | your local signer (see the table above) — the SDK holds no keys |
| `allowedNetworks` | | restrict which CAIP-2 networks you'll pay on, e.g. `['eip155:8453']` |
| `paymentId` | | **idempotency id** (16-128 chars), or a `({requirements}) => id` callback resolved per request — see below |
| `baseUrl` | | buyer service base URL (default `https://ai.cryptoapis.io/x402/buyer`) |
| `fetchImpl` | | a custom `fetch` implementation — for a corporate proxy / custom CA (see below) or testing |

Amounts in `PaymentRequirements` are **atomic units** (USDC 6-decimals: `"10000"` = $0.01). Networks are
[CAIP-2](https://chainagnostic.org/CAIPs/caip-2) (e.g. `eip155:8453` = Base).

### Corporate proxies / custom CA

Behind a TLS-intercepting corporate proxy, Node's global `fetch` fails with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (it doesn't use the system trust store). Every SDK entry point
(`createX402Fetch`, `createWalletsClient`, `createAuthorizeClient`) accepts a **`fetchImpl`** — pass a
`fetch` bound to a custom CA / proxy agent (e.g. `undici`) and all calls route through it:

```js
import { fetch as undiciFetch, Agent } from 'undici';
import { readFileSync } from 'node:fs';

const agent = new Agent({ connect: { ca: readFileSync('/etc/corp/ca.pem') } });
const fetchImpl = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });

const fetch402 = createX402Fetch({ apiKey, walletId, signer, fetchImpl });
```

For the **merchant SDK**, pass a custom `facilitatorClient` (or its `fetchImpl`) the same way — the low-level
clients accept it. Do NOT disable TLS verification globally; inject the CA instead.

---

## API

- `createX402Fetch(config)` → a `fetch`-compatible function that auto-pays 402s.
- `createPayTool(config)` (`/agent`) → framework-neutral `{ name, description, parameters, execute }`.
- `x402PayTool(config)` (`/ai-sdk`, `/langchain`) → a ready tool for that framework.
- `x402PayFunction(config)` (`/function-calling`) → OpenAI/Anthropic/Gemini tool schemas + a `run()`.
- Low-level: `createAuthorizeClient`, `parse402`, `buildEip712Payload`, `buildTransactionPayload`,
  `encodePaymentHeader`.

## Related

- **[`@cryptoapis-io/x402-merchant-sdk`](https://www.npmjs.com/package/@cryptoapis-io/x402-merchant-sdk)** — the merchant side: charge for your API.
- **[`@cryptoapis-io/mcp-x402-pay`](https://www.npmjs.com/package/@cryptoapis-io/mcp-x402-pay)** — MCP server for coding agents.
- **[`@cryptoapis-io/mcp-signer`](https://www.npmjs.com/package/@cryptoapis-io/mcp-signer)** — local signing for all chains.
- [CryptoAPIs docs](https://developers.cryptoapis.io) · [x402 protocol](https://x402.org)

## License

MIT © Crypto APIs, Inc.
