/**
 * Pay for an x402-gated **A2A skill** (`@cryptoapis-io/x402-buyer-sdk/a2a`).
 *
 * The buyer half of the A2A transport (`specs/transports-v2/a2a.md`), completing the third and
 * last x402 transport after `http` (`createX402Fetch`) and `mcp` (`createX402ToolCaller`).
 * Without it an agent can pay endpoints and MCP tools but not another AGENT — including one a
 * CryptoAPIs merchant exposes with our own merchant SDK's `/a2a` adapter.
 *
 * Same core as both other paths (`buildPaymentForChallenge`): authorize, sign LOCALLY, retry.
 * Only the envelope differs, and A2A's differs the most:
 *   - the challenge is a TASK in state `input-required`, carrying `PaymentRequired` in the
 *     message metadata under the literal dotted key `x402.payment.required`;
 *   - the payment goes back in a NEW MESSAGE under `x402.payment.payload`, correlated to the
 *     original task by `taskId` — not as a header or a `_meta` field on the same call;
 *   - the payload wraps `{resource, accepted, payload}` (the client echoes the requirement it
 *     chose) rather than the flat `{scheme, network, payload}` HTTP and MCP use;
 *   - receipts come back as an ARRAY in `x402.payment.receipts`.
 */

import { createAuthorizeClient } from './authorizeClient.js';
import { buildPaymentForChallenge } from './payFlow.js';

/** Metadata keys defined by the A2A x402 extension. Literal dotted strings. @type {Object} */
const META = {
    STATUS: 'x402.payment.status',
    REQUIRED: 'x402.payment.required',
    PAYLOAD: 'x402.payment.payload',
    RECEIPTS: 'x402.payment.receipts',
    ERROR: 'x402.payment.error',
};

/** `x402.payment.status` values this client sends or reads. @type {Object} */
const STATUS = {
    REQUIRED: 'payment-required',
    SUBMITTED: 'payment-submitted',
    COMPLETED: 'payment-completed',
    FAILED: 'payment-failed',
};

/** The extension URI, and the header that activates it per-request. @type {string} */
const EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';
const EXTENSION_HEADER = 'X-A2A-Extensions';

/**
 * Read an x402 `PaymentRequired` challenge out of an A2A task.
 *
 * A task is a challenge when it is in `input-required` AND its status message carries the
 * payment metadata. The state alone is not enough — `input-required` is A2A's generic "I need
 * more from you", used for plenty of non-payment prompts.
 *
 * @param {Object} [task] an A2A task (or a JSON-RPC `result` containing one)
 * @return {(Object|null)} the PaymentRequired body, or null when this is not a payment challenge
 */
function parseTaskChallenge(task) {
    const t = task?.result ?? task;
    if (t?.status?.state !== 'input-required') {
        return null;
    }
    const meta = t.status.message?.metadata;
    if (meta?.[META.STATUS] !== STATUS.REQUIRED) {
        return null;
    }
    const body = meta[META.REQUIRED];
    return body && typeof body === 'object' && Array.isArray(body.accepts) ? body : null;
}

/**
 * Build the A2A-shaped PaymentPayload from the flat one the shared flow produces.
 *
 * A2A echoes the chosen requirement back under `accepted` and repeats the `resource`. Our
 * facilitator reads either form (`payload.scheme ?? payload.accepted?.scheme`), but a
 * spec-conformant A2A server may read only `accepted` — so emit the A2A shape, and keep the flat
 * fields alongside it so nothing that reads the common form breaks.
 *
 * @param {Object} flat the `{x402Version, scheme, network, payload}` payload from payFlow
 * @param {Object} requirements the requirement being paid
 * @param {Object} [resource] the ResourceInfo from the challenge
 * @return {Object} the A2A PaymentPayload
 */
function toA2aPayload(flat, requirements, resource) {
    return {
        ...flat,
        ...(resource ? { resource: resource } : {}),
        accepted: requirements,
    };
}

/**
 * Build the message that submits a payment for a task.
 *
 * @param {Object} params inputs
 * @param {string} params.taskId the task the payment answers — REQUIRED for correlation
 * @param {Object} params.paymentPayload the A2A PaymentPayload
 * @param {string} [params.text] the human-readable part of the message
 * @return {Object} an A2A message ready for `message/send`
 */
function paymentMessage({ taskId, paymentPayload, text = 'Here is the payment authorization.' }) {
    return {
        taskId: taskId,
        role: 'user',
        parts: [{
            kind: 'text',
            text: text
        }],
        metadata: {
            [META.STATUS]: STATUS.SUBMITTED,
            [META.PAYLOAD]: paymentPayload,
        },
    };
}

/**
 * Read the settlement receipts from a completed (or failed) task.
 *
 * @param {Object} [task] an A2A task
 * @return {(Array<Object>|undefined)} the SettlementResponse array, when present
 */
function readReceipts(task) {
    const t = task?.result ?? task;
    return t?.status?.message?.metadata?.[META.RECEIPTS];
}

/**
 * Create a `sendMessage` wrapper that transparently pays x402-gated A2A skills.
 *
 * @param {Object} params inputs
 * @param {string} params.apiKey the buyer's CryptoAPIs API key (X402_BUYER feature)
 * @param {string} params.walletId the agent wallet RECORD id to pay from
 * @param {Function} params.signToPayload `({scheme, signing, requirements}) => PaymentPayload`
 *   — the same local signer dispatch the HTTP and MCP paths use
 * @param {Array<string>} [params.allowedNetworks] restrict which CAIP-2 networks to pay on
 * @param {(string|Function)} [params.paymentId] `payment-identifier` idempotency id, or a
 *   `({requirements}) => id` callback
 * @param {string} [params.baseUrl] buyer service base URL override (QA/local)
 * @param {Function} [params.fetchImpl] fetch implementation (injectable for tests)
 * @return {Function} `payTask(sendMessage, params)` — call it with YOUR A2A client's
 *   `message/send` fn and the message params; it returns the paid task
 */
function createX402TaskSender({
    apiKey, walletId, signToPayload, allowedNetworks, paymentId, baseUrl, fetchImpl,
} = {}) {
    if (!walletId) {
        throw new Error('createX402TaskSender: walletId is required');
    }
    if (typeof signToPayload !== 'function') {
        throw new Error('createX402TaskSender: signToPayload is required (non-custodial — the SDK holds no keys)');
    }
    const authorizeClient = createAuthorizeClient({
        apiKey: apiKey,
        baseUrl: baseUrl,
        fetchImpl: fetchImpl ?? globalThis.fetch,
    });

    /**
     * Send an A2A message, paying the task if it comes back asking for payment.
     *
     * @param {Function} sendMessage your A2A client's send fn — `(params) => task`
     * @param {Object} params the `message/send` params (`{message}`)
     * @return {Promise<Object>} the task — paid when a challenge was answered
     */
    return async function payTask(sendMessage, params) {
        const first = await sendMessage(params);
        const challenge = parseTaskChallenge(first);
        if (!challenge) {
            // Not a payment challenge (done, or an ordinary input-required prompt) — hand it
            // back untouched rather than interpreting someone else's task state.
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
            // Nothing offered is acceptable — return the challenge so the caller sees the price.
            return first;
        }

        const task = first?.result ?? first;
        const taskId = task?.id;
        if (!taskId) {
            // Without a taskId the server cannot correlate the payment to the work. Fail loudly
            // rather than send a payment that will be orphaned.
            throw new Error('x402 a2a: the challenge task has no `id` — cannot correlate the payment');
        }

        // Exactly ONE retry, never a loop: a second challenge means the payment was rejected,
        // and re-paying would risk paying twice for one task.
        return sendMessage({
            ...params,
            message: paymentMessage({
                taskId: taskId,
                paymentPayload: toA2aPayload(built.paymentPayload, built.requirements, challenge.resource),
            }),
        });
    };
}

export {
    createX402TaskSender,
    parseTaskChallenge,
    paymentMessage,
    toA2aPayload,
    readReceipts,
    META,
    STATUS,
    EXTENSION_URI,
    EXTENSION_HEADER,
};
