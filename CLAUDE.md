# CLAUDE.md — @cryptoapis/x402-buyer-sdk

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
4. **Sign locally** via `signer` (per-scheme dispatch in `signToPayload`). v1: `eip712` →
   `signer.signTypedData(signing)`; other schemes throw `unsupported_scheme`.
5. Build the x402 `PaymentPayload` (`paymentPayload.js`), base64 into the **`X-PAYMENT`** header, and
   **retry the original request once**.

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
mcp-signer produces an `X-PAYMENT` whose signature the facilitator's `@cryptoapis/x402-evm`
`eip3009.verifyAuthorization` recovers to the buyer (ethers-signer ↔ viem-verifier interop).

## Commands
```bash
npm install
npm test          # node --test (x402Fetch flow + authorizeClient + paymentPayload; mocked fetch/signer)
npm run lint      # eslint (@common; tests relax jsdoc/object-shorthand)
```
Tests live under `tests/`, never colocated.

## Status
Code-only (built + unit-tested, 12 tests + a real-signer E2E; not published). v1: EVM `eip712`
end-to-end. Per-scheme dispatch → SVM/UTXO/XRP/Kaspa slot in as their signer paths land. An agentic
`x402_pay` MCP tool can wrap this core later.
