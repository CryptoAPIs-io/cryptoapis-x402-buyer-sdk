# CLAUDE.md — @cryptoapis-io/x402-buyer-sdk

The **buyer-side** x402 client SDK (Node 18+, ESM, zero runtime deps): a `fetch` wrapper that auto-pays
HTTP 402 responses. One of the x402 client surfaces (siblings: `cryptoapis-x402-merchant-sdk` = the
merchant side; `@cryptoapis-io/mcp-signer` = the local signing primitives). **Non-custodial: the SDK
holds NO keys and signs NOTHING** — the caller passes a `signer`; signing happens in their process.

## The flow it implements (`src/x402Fetch.js`)
`createX402Fetch({ apiKey, walletId, signer, allowedNetworks?, baseUrl?, fetchImpl? })` → an
`x402Fetch(url, init)`:
1. `fetch` the request. If the status isn't **402**, return it untouched.
2. Parse the 402 body's `accepts` (PaymentRequirements list); pick one (respecting `allowedNetworks`).
   None acceptable → return the 402 unchanged.
3. POST it to the buyer **`/authorize`** (`authorizeClient.js`) → `{ scheme, signing }`.
4. **Sign locally** via `signer` (per-scheme dispatch in `signToPayload`). All 6 artifact schemes wired:
   `eip712`→`signTypedData`, `svm-transaction`→`signSvm`, `tron-transaction`→`signTron`,
   `utxo-transaction`→`signUtxo`, `kaspa-transaction`→`signKaspa`, `xrp-transaction`→`signXrp`. A scheme
   whose signer method is absent throws (`signer.X is required`); an unknown scheme → `unsupported_scheme`.
5. Build the x402 `PaymentPayload` (`paymentPayload.js`), base64 into the **`X-PAYMENT`** header, and
   **retry the original request once**.

**CRITICAL — the two meanings of "scheme":** the buyer `/authorize` returns an ARTIFACT scheme
(`eip712`/`svm-transaction`/…) that tells the client HOW to sign. The WIRE `paymentPayload.scheme` is
**always `exact`** — the facilitator's `parseEnvelope` rejects anything else, and derives the family from
`network` (`familyOf`). So the SDK signs by the artifact scheme but emits `scheme:'exact'` + `network`.
requirements↔payload are paired by **network**, never scheme.

## Modules (`src/`)
- `authorizeClient.js` — `createAuthorizeClient({apiKey, baseUrl, fetchImpl})` → `authorize({paymentRequirements, walletId})`. Buyer service at `ai.cryptoapis.io/x402/buyer/*`, `x-api-key` (X402_BUYER). Non-2xx throws (budget/auth).
- `paymentPayload.js` — `parse402` (accepts list), `buildEip712Payload` (the `{x402Version, scheme, network, payload:{signature, authorization}}` wire shape), `encodePaymentHeader` (base64).
- `x402Fetch.js` — the orchestrator + `selectRequirements` (allowlist-aware pick).
- `index.js` — barrel.

## Non-negotiable
- **Non-custodial.** No keys, no signing in the SDK. The `signer` is caller-provided; `walletId` + `signer` are required (guardrails throw otherwise). The buyer `/authorize` is also non-custodial — it returns an artifact to sign, never signs.
- **Retry once.** A 402 triggers exactly one authorize→sign→retry cycle; a second 402 is returned (no loop).
- **402 is the buyer's concern; other failures propagate.** A transport/auth/budget error from `/authorize` throws (the caller handles it); an unpayable 402 is returned as-is.
- **Zero runtime deps** (global `fetch` + `Buffer`). `ethers` etc. live in the CALLER's signer, not here.

## The signer contract
EVM (`eip712`): `signer.signTypedData(typedData) → Promise<signature>`, where `typedData` is the
`{domain, types, primaryType, message}` from `/authorize`. This matches `@cryptoapis-io/mcp-signer`
`evm_sign` `sign-typed-data` exactly — the intended signer. **Verified end-to-end:** SDK + real
mcp-signer produces an `X-PAYMENT` whose signature the facilitator's EIP-3009
`verifyAuthorization` recovers to the buyer (ethers-signer ↔ viem-verifier interop).

## Commands
```bash
npm install
npm test          # node --test (x402Fetch flow + authorizeClient + paymentPayload; mocked fetch/signer)
npm run lint      # eslint (@common; tests relax jsdoc/object-shorthand)
```
Tests live under `tests/`, never colocated.

## Status
Code-only (built + unit-tested, 28 tests (incl. agent adapters) + a full-envelope real-signer E2E; not published). **All 6
artifact schemes wired** (EVM/SVM/Tron/UTXO/Kaspa/XRP); EVM is verified end-to-end (SDK → mcp-signer →
`parseEnvelope` accepts + `eip3009.verifyAuthorization` recovers the buyer). Non-EVM schemes are wired +
unit-tested but await their signer implementations being exercised live. Agent adapters shipped: `/agent` (neutral), `/ai-sdk`, `/langchain`, `/function-calling` (OpenAI/Anthropic/Gemini); the MCP surface is `@cryptoapis-io/mcp-x402-pay`.

## The standard this implements

- **[x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)** — the normative wire contract: `PaymentRequired` (§5.1),
  `PaymentPayload` (§5.2), `SettlementResponse` (§5.3), `VerifyResponse` (§5.4), the facilitator
  interface (§7), the Discovery API (§8) and the standard error codes (§9).
- **[Transports](https://github.com/coinbase/x402/tree/main/specs/transports-v2)** — `http`, `mcp`, `a2a`: how a resource server and client signal payment
  over each. The facilitator interface is identical across all of them.

When changing anything on the wire, check it against the spec — a field the spec marks Required is
not optional for us, and error codes on the wire are the spec's vocabulary, not our internal one.
