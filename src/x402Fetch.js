/**
 * `createX402Fetch` — a drop-in `fetch` that transparently pays HTTP 402 responses.
 *
 * Flow on a 402:
 *   1. parse the merchant's `accepts` (PaymentRequirements list) and pick one
 *   2. POST it to the CryptoAPIs buyer `/authorize` → `{ scheme, signing }`
 *   3. **sign LOCALLY** via the caller-provided `signer` (keys never enter the SDK)
 *   4. build the `PaymentPayload` + base64 `X-PAYMENT` header and RETRY the request once
 *
 * NON-CUSTODIAL: the SDK never holds a key. The caller passes a `signer` implementing
 * the scheme it wants to support (e.g. `signTypedData` for EVM `eip712` — the exact
 * shape `@cryptoapis-io/mcp-signer` `evm_sign` `sign-typed-data` produces).
 *
 * v1 supports the **EVM `eip712`** scheme end-to-end (the only enabled chain). Other
 * schemes throw `unsupported_scheme` until their signer path is wired — the structure
 * is a per-scheme dispatch so adding one is localized.
 */

import { createAuthorizeClient } from './authorizeClient.js';
import {
    parse402, buildEip712Payload, encodePaymentHeader
} from './paymentPayload.js';

/**
 * Choose which of the merchant's accepted requirements to pay. Default: the first
 * one whose network is in `allowedNetworks` (if given), else the first.
 *
 * @param {Array<Object>} accepts the merchant's PaymentRequirements list
 * @param {Array<string>} [allowedNetworks] optional caller allowlist of CAIP-2 networks
 * @return {(Object|null)} the chosen requirements, or null if none acceptable
 */
function selectRequirements(accepts, allowedNetworks) {
    if (accepts.length === 0) {
        return null;
    }
    if (Array.isArray(allowedNetworks) && allowedNetworks.length > 0) {
        return accepts.find((r) => allowedNetworks.includes(r.network)) ?? null;
    }
    return accepts[0];
}

/**
 * Create a fetch wrapper bound to a buyer wallet + signer.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the buyer's CryptoAPIs API key (X402_BUYER feature)
 * @param {string} params.walletId the agent wallet id to pay from
 * @param {Object} params.signer the local signer — `{ signTypedData({domain,types,primaryType,message}): Promise<string> }` for EVM
 * @param {Array<string>} [params.allowedNetworks] restrict which CAIP-2 networks the wallet will pay on
 * @param {string} [params.baseUrl] buyer service base URL override (QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (default global fetch; injectable for tests)
 * @return {Function} an `x402Fetch(url, init)` compatible with fetch
 */
function createX402Fetch({ apiKey, walletId, signer, allowedNetworks, baseUrl, fetchImpl } = {}) {
    if (!walletId) {
        throw new Error('createX402Fetch: walletId is required');
    }
    if (!signer) {
        throw new Error('createX402Fetch: a signer is required (non-custodial — the SDK holds no keys)');
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    const authorizeClient = createAuthorizeClient({
        apiKey: apiKey,
        baseUrl: baseUrl,
        fetchImpl: doFetch
    });

    /**
     * Sign a scheme's artifact and produce the PaymentPayload. Dispatch by scheme.
     *
     * @param {Object} params inputs
     * @param {string} params.scheme the wire scheme from /authorize
     * @param {Object} params.signing the signing artifact from /authorize
     * @param {Object} params.requirements the chosen PaymentRequirements
     * @return {Promise<Object>} the PaymentPayload to resubmit
     * @throws {Error} `unsupported_scheme` when the scheme has no wired signer path
     */
    async function signToPayload({ scheme, signing, requirements }) {
        if (scheme === 'eip712') {
            if (typeof signer.signTypedData !== 'function') {
                throw new Error('signer.signTypedData is required for the eip712 scheme');
            }
            // `signing` is the EIP-712 typed-data { domain, types, primaryType, message }.
            const signature = await signer.signTypedData(signing);
            return buildEip712Payload({
                network: requirements.network,
                authorization: signing.message,
                signature: signature,
            });
        }
        throw new Error(`unsupported_scheme: ${scheme} (v1 buyer SDK supports eip712; other schemes are pending)`);
    }

    /**
     * fetch that auto-pays a 402.
     *
     * @param {(string|URL|Request)} url the request url
     * @param {Object} [init] fetch init
     * @return {Promise<Response>} the (paid) response
     */
    return async function x402Fetch(url, init = {}) {
        const first = await doFetch(url, init);
        if (first.status !== 402) {
            return first;
        }

        const body = await first.clone().json().catch(() => null);
        const accepts = parse402(body);
        const requirements = selectRequirements(accepts, allowedNetworks);
        if (!requirements) {
            // Nothing we can/will pay — hand the 402 back to the caller unchanged.
            return first;
        }

        const { scheme, signing } = await authorizeClient.authorize({
            paymentRequirements: requirements,
            walletId: walletId,
        });
        const paymentPayload = await signToPayload({
            scheme,
            signing,
            requirements
        });

        // Retry the ORIGINAL request with the X-PAYMENT header added.
        const retryInit = {
            ...init,
            headers: {
                ...(init.headers ?? {}),
                'x-payment': encodePaymentHeader(paymentPayload),
            },
        };
        return doFetch(url, retryInit);
    };
}

export {
    createX402Fetch, selectRequirements
};
