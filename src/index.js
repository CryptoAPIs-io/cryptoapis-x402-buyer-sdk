/**
 * CryptoAPIs x402 buyer SDK (`@cryptoapis-io/x402-buyer-sdk`) — a `fetch` wrapper that
 * transparently pays HTTP 402 responses (parse → authorize → sign locally → retry).
 *
 * NON-CUSTODIAL: the SDK holds no keys. You pass a `signer` (e.g. wrapping
 * `@cryptoapis-io/mcp-signer`); signing happens in your process. All six artifact
 * schemes are wired — `eip712` (EVM), `svm-transaction`, `tron-transaction`,
 * `utxo-transaction`, `kaspa-transaction`, `xrp-transaction` — dispatched by the
 * `signer` method the scheme needs. EVM is verified end-to-end against the facilitator.
 *
 *   const fetch402 = createX402Fetch({ apiKey, walletId, signer });
 *   const res = await fetch402('https://api.example.com/premium'); // auto-pays a 402
 */

export {
    createX402Fetch, selectRequirements
} from './x402Fetch.js';
export {
    createAuthorizeClient, DEFAULT_BASE_URL
} from './authorizeClient.js';
export {
    createWalletsClient, assertCreateWalletInput
} from './walletsClient.js';
export {
    validatePaymentRequirements, familyOf
} from './requirementsValidation.js';
export {
    parse402, buildEip712Payload, encodePaymentHeader, X402_VERSION
} from './paymentPayload.js';
