/**
 * CryptoAPIs x402 buyer SDK (`@cryptoapis/x402-buyer-sdk`) — a `fetch` wrapper that
 * transparently pays HTTP 402 responses (parse → authorize → sign locally → retry).
 *
 * NON-CUSTODIAL: the SDK holds no keys. You pass a `signer` (e.g. wrapping
 * `@cryptoapis-io/mcp-signer` `evm_sign` `sign-typed-data`); signing happens in your
 * process. v1 supports the EVM `eip712` scheme end-to-end.
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
    parse402, buildEip712Payload, encodePaymentHeader, X402_VERSION
} from './paymentPayload.js';
