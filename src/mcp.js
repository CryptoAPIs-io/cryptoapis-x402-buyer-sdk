/**
 * Pay for an x402-gated **MCP tool** (`@cryptoapis-io/x402-buyer-sdk/mcp`).
 *
 * The buyer half of the MCP transport (`specs/transports-v2/mcp.md`). `createX402Fetch`
 * pays HTTP 402s; this pays TOOLS — which is what an agent actually calls. Without it an
 * agent can only pay endpoints, so a paid MCP tool (including one a CryptoAPIs merchant
 * exposes with our own merchant SDK) is unpayable.
 *
 * Same core as the HTTP path (`buildPaymentForChallenge`): authorize, sign LOCALLY, retry.
 * Only the envelope differs:
 *   - the challenge is a tool RESULT with `isError: true`, carrying `PaymentRequired` in
 *     `structuredContent` AND `content[0].text` (the spec requires servers to send both;
 *     clients SHOULD prefer structured and fall back to parsing the text);
 *   - the payment goes back as a RAW OBJECT in `_meta["x402/payment"]` — MCP carries
 *     structured JSON natively, so there is no base64;
 *   - the receipt comes back in `_meta["x402/payment-response"]`.
 */

import { createAuthorizeClient } from './authorizeClient.js';
import { buildPaymentForChallenge } from './payFlow.js';

/** `_meta` key the payment is sent under. @type {string} */
const PAYMENT_META_KEY = 'x402/payment';

/** `_meta` key the settlement receipt comes back under. @type {string} */
const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/**
 * Read an x402 `PaymentRequired` challenge out of an MCP tool result.
 *
 * Per the spec a client SHOULD prefer `structuredContent` and fall back to parsing
 * `content[0].text` — servers must send both, but a server that sends only the text form
 * is still payable, and treating it as unpayable would strand the user.
 *
 * @param {Object} [result] an MCP tool result
 * @return {(Object|null)} the PaymentRequired body, or null when this is not a payment challenge
 */
function parseToolChallenge(result) {
    if (!result?.isError) {
        return null;
    }
    const isChallenge = (o) => o && typeof o === 'object' &&
        o.x402Version !== undefined && Array.isArray(o.accepts);

    if (isChallenge(result.structuredContent)) {
        return result.structuredContent;
    }
    const text = result.content?.[0]?.text;
    if (typeof text === 'string') {
        try {
            const parsed = JSON.parse(text);
            if (isChallenge(parsed)) {
                return parsed;
            }
        } catch {
            // Not JSON — an ordinary tool error, not a payment challenge.
            return null;
        }
    }
    return null;
}

/**
 * Attach a PaymentPayload to a tool call's `_meta`, preserving any `_meta` already there.
 *
 * @param {Object} [params] the tool-call params (`{name, arguments, _meta?}`)
 * @param {Object} paymentPayload the signed PaymentPayload
 * @return {Object} params with the payment attached
 */
function withPaymentMeta(params, paymentPayload) {
    return {
        ...(params ?? {}),
        _meta: {
            ...(params?._meta ?? {}),
            [PAYMENT_META_KEY]: paymentPayload,
        },
    };
}

/**
 * Create a `callTool` wrapper that transparently pays x402-gated MCP tools.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the buyer's CryptoAPIs API key (X402_BUYER feature)
 * @param {string} params.walletId the agent wallet RECORD id to pay from
 * @param {Function} params.signToPayload `({scheme, signing, requirements}) => PaymentPayload`
 *   — the same local signer dispatch the HTTP path uses (see `createX402Fetch`)
 * @param {Array<string>} [params.allowedNetworks] restrict which CAIP-2 networks to pay on
 * @param {(string|Function)} [params.paymentId] `payment-identifier` idempotency id, or a
 *   `({requirements}) => id` callback — the only safe way to retry a call whose result was lost
 * @param {string} [params.baseUrl] buyer service base URL override (QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (injectable for tests)
 * @return {Function} `payToolCall(callTool, params)` — call it with YOUR MCP client's
 *   `callTool` and the tool-call params; it returns the paid tool result
 */
function createX402ToolCaller({
    apiKey, walletId, signToPayload, allowedNetworks, paymentId, baseUrl, fetchImpl,
} = {}) {
    if (!walletId) {
        throw new Error('createX402ToolCaller: walletId is required');
    }
    if (typeof signToPayload !== 'function') {
        throw new Error('createX402ToolCaller: signToPayload is required (non-custodial — the SDK holds no keys)');
    }
    const authorizeClient = createAuthorizeClient({
        apiKey: apiKey,
        baseUrl: baseUrl,
        fetchImpl: fetchImpl ?? globalThis.fetch,
    });

    /**
     * Call an MCP tool, paying it if it answers with a payment challenge.
     *
     * @param {Function} callTool your MCP client's tool-call fn — `(params) => toolResult`
     * @param {Object} params the tool-call params (`{name, arguments}`)
     * @return {Promise<Object>} the tool result — paid when a challenge was answered
     */
    return async function payToolCall(callTool, params) {
        const first = await callTool(params);
        const challenge = parseToolChallenge(first);
        if (!challenge) {
            // Not a payment challenge (success, or an ordinary tool error) — hand it back
            // untouched rather than interpreting someone else's error.
            return first;
        }

        const built = await buildPaymentForChallenge({
            accepts: challenge.accepts,
            allowedNetworks: allowedNetworks,
            authorizeClient: authorizeClient,
            walletId: walletId,
            signToPayload: signToPayload,
            paymentId: paymentId,
        });
        if (!built) {
            // Nothing offered is acceptable (e.g. allowedNetworks excludes them all) —
            // return the original challenge so the caller can see the price and decide.
            return first;
        }

        // Exactly ONE retry, never a loop: a second challenge means the payment was
        // rejected, and re-paying would risk paying twice for one call.
        return callTool(withPaymentMeta(params, built.paymentPayload));
    };
}

/**
 * Read the settlement receipt from a paid tool result.
 *
 * @param {Object} [result] an MCP tool result
 * @return {(Object|undefined)} the SettlementResponse, when present
 */
function readSettlement(result) {
    return result?._meta?.[PAYMENT_RESPONSE_META_KEY];
}

export {
    createX402ToolCaller,
    parseToolChallenge,
    withPaymentMeta,
    readSettlement,
    PAYMENT_META_KEY,
    PAYMENT_RESPONSE_META_KEY,
};
