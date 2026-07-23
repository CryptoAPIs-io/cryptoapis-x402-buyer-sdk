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
 * only the scheme(s) it wants to support. Each maps 1:1 to a `@cryptoapis-io/mcp-signer`
 * capability (the intended signer):
 *   - `eip712`          → `signer.signTypedData(typedData)` → 65-byte sig      (evm_sign sign-typed-data)
 *   - `svm-transaction` → `signer.signSvm({transaction})` → base64 signed tx   (svm_sign partial-sign)
 *   - `tron-transaction`→ `signer.signTron({transaction})` → {txID,raw_data_hex,signature} (tron_sign)
 *   - `utxo-transaction`→ `signer.signUtxo({preparedTransaction, network})` → signed raw hex (utxo_sign)
 *   - `kaspa-transaction`→ `signer.signKaspa({preparedTransaction})` → signed tx JSON  (kaspa-wasm/kaspa_sign)
 *   - `xrp-transaction` → `signer.signXrp({transaction})` → signed tx_blob     (xrp_sign)
 *
 * SUPPORTED FAMILIES: only **EVM** (`eip712`) and **Solana** (`svm-transaction`) are
 * live-verified end-to-end and enabled. Tron, UTXO, XRP and Kaspa are wired but NOT yet
 * live-verified, so they are gated OFF here and return a clear `family_not_yet_supported`
 * error (they are on the roadmap — "upcoming"). Enabling a family once verified is a
 * one-line addition to `SUPPORTED_SCHEMES`.
 */

import { createAuthorizeClient } from './authorizeClient.js';
import {
    parse402, buildEip712Payload, buildTransactionPayload, encodePaymentHeader
} from './paymentPayload.js';

/**
 * Wire schemes this SDK currently supports (live-verified end-to-end). Other families
 * (`tron-transaction`, `utxo-transaction`, `kaspa-transaction`, `xrp-transaction`) are
 * wired but not yet live-verified — gated off until each is exercised in production.
 * @type {Set<string>}
 */
const SUPPORTED_SCHEMES = new Set(['eip712', 'svm-transaction']);

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
        const network = requirements.network;

        // Gate off families that are wired but not yet live-verified (Tron/UTXO/XRP/Kaspa).
        // EVM + Solana are supported today; the rest are on the roadmap.
        if (!SUPPORTED_SCHEMES.has(scheme)) {
            throw new Error(
                `family_not_yet_supported: the "${scheme}" family is coming soon — ` +
                'only EVM (eip712) and Solana (svm-transaction) are supported today'
            );
        }

        // EVM eip712 — detached typed-data signature + the message as the authorization.
        if (scheme === 'eip712') {
            requireSigner('signTypedData', scheme);
            const signature = await signer.signTypedData(signing);
            return buildEip712Payload({
                network: network,
                authorization: signing.message,
                signature: signature,
            });
        }

        // Every non-EVM family: sign the artifact, wrap the signed tx in { transaction }.
        // The signer returns the exact tx form that family's parsePayload reads.
        if (scheme === 'svm-transaction') {
            requireSigner('signSvm', scheme);
            // signing = { transaction: <base64 unsigned> } → partial-sign → base64.
            const transaction = await signer.signSvm({ transaction: signing.transaction });
            return buildTransactionPayload({
                network,
                transaction
            });
        }
        if (scheme === 'tron-transaction') {
            requireSigner('signTron', scheme);
            // signing = { transaction: <TronWeb tx> } → sign → {txID, raw_data_hex, signature}.
            const transaction = await signer.signTron({ transaction: signing.transaction });
            return buildTransactionPayload({
                network,
                transaction
            });
        }
        if (scheme === 'utxo-transaction') {
            requireSigner('signUtxo', scheme);
            // signing = { preparedTransaction } → verify outputs + fully sign → signed raw hex.
            const transaction = await signer.signUtxo({
                preparedTransaction: signing.preparedTransaction,
                network: network
            });
            return buildTransactionPayload({
                network,
                transaction
            });
        }
        if (scheme === 'kaspa-transaction') {
            requireSigner('signKaspa', scheme);
            // signing = { preparedTransaction } → schnorr fully sign → signed tx JSON.
            const transaction = await signer.signKaspa({ preparedTransaction: signing.preparedTransaction });
            return buildTransactionPayload({
                network,
                transaction
            });
        }
        if (scheme === 'xrp-transaction') {
            requireSigner('signXrp', scheme);
            // signing = { transaction: <unsigned Payment> } → sign → signed tx_blob.
            const transaction = await signer.signXrp({ transaction: signing.transaction });
            return buildTransactionPayload({
                network,
                transaction
            });
        }

        throw new Error(`unsupported_scheme: ${scheme}`);
    }

    /**
     * Assert the caller's signer implements the method a scheme needs.
     *
     * @param {string} method the required signer method name
     * @param {string} scheme the scheme requiring it
     * @return {void}
     * @throws {Error} when the signer lacks the method
     */
    function requireSigner(method, scheme) {
        if (typeof signer[method] !== 'function') {
            throw new Error(`signer.${method} is required for the ${scheme} scheme`);
        }
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
