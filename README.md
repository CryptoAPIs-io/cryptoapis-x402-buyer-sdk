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

## Quick start — a fetch that pays for itself

```js
import { createX402Fetch } from '@cryptoapis-io/x402-buyer-sdk';
import { Wallet } from 'ethers';

const wallet = new Wallet(process.env.PRIVATE_KEY);   // your key — stays in your process

const fetch402 = createX402Fetch({
  apiKey:   process.env.CRYPTOAPIS_API_KEY,           // CryptoAPIs key with the X402_BUYER feature
  walletId: 'your-agent-wallet-id',                   // the wallet the buyer service pays from
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

### Claude Code, Cursor, Codex & other MCP agents

Use **[`@cryptoapis-io/mcp-x402-pay`](https://www.npmjs.com/package/@cryptoapis-io/mcp-x402-pay)** — an MCP
server exposing the same `x402_pay` tool. Add it to your agent's MCP config and it can pay for endpoints
out of the box.

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

---

## Configuration

| Option | Required | Description |
|---|---|---|
| `apiKey` | ✓ | CryptoAPIs API key with the `X402_BUYER` feature |
| `walletId` | ✓ | the agent wallet the buyer service authorizes payments from |
| `signer` | ✓ | your local signer (see the table above) — the SDK holds no keys |
| `allowedNetworks` | | restrict which CAIP-2 networks you'll pay on, e.g. `['eip155:8453']` |
| `baseUrl` | | buyer service base URL (default `https://ai.cryptoapis.io/x402/buyer`) |

Amounts in `PaymentRequirements` are **atomic units** (USDC 6-decimals: `"10000"` = $0.01). Networks are
[CAIP-2](https://chainagnostic.org/CAIPs/caip-2) (e.g. `eip155:8453` = Base).

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
