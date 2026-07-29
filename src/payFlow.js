/**
 * The transport-independent half of paying an x402 challenge.
 *
 * Given the merchant's `accepts` list, this picks a requirement, authorizes it with the
 * buyer service, signs LOCALLY, and returns the `PaymentPayload` to resubmit. It knows
 * nothing about HTTP or MCP — the caller decides how the challenge arrived and how the
 * payload travels back (an `X-PAYMENT` header over HTTP, `_meta["x402/payment"]` over MCP).
 *
 * Extracted so both transports run ONE implementation: the flow is identical, and a fix or
 * a new family must never land on only one of them.
 */

import { withPaymentIdentifier } from './paymentPayload.js';
import { validatePaymentRequirements } from './requirementsValidation.js';

/**
 * Pick which offered requirement to pay: the first whose network is in `allowedNetworks`
 * (when given), else the first offered.
 *
 * @param {Array<Object>} accepts the merchant's PaymentRequirements list
 * @param {Array<string>} [allowedNetworks] optional caller allowlist of CAIP-2 networks
 * @return {(Object|null)} the chosen requirements, or null when none is acceptable
 */
function selectRequirements(accepts, allowedNetworks) {
    if (!Array.isArray(accepts) || accepts.length === 0) {
        return null;
    }
    if (Array.isArray(allowedNetworks) && allowedNetworks.length > 0) {
        return accepts.find((r) => allowedNetworks.includes(r.network)) ?? null;
    }
    return accepts[0] ?? null;
}

/**
 * Authorize + sign one x402 challenge into a resubmittable PaymentPayload.
 *
 * @param {Object} params inputs
 * @param {Array<Object>} params.accepts the merchant's PaymentRequirements list
 * @param {Array<string>} [params.allowedNetworks] restrict which CAIP-2 networks to pay on
 * @param {Object} params.authorizeClient the buyer-service client (`authorize`)
 * @param {string} params.walletId the agent wallet record id to pay from
 * @param {Function} params.signToPayload `({scheme, signing, requirements}) => PaymentPayload`
 * @param {(string|Function)} [params.paymentId] `payment-identifier` id, or a
 *   `({requirements}) => id` callback resolved per request
 * @return {Promise<{paymentPayload: Object, requirements: Object}|null>} the payload to
 *   resubmit plus the requirement it pays, or null when nothing offered is acceptable
 */
async function buildPaymentForChallenge({
    accepts, allowedNetworks, authorizeClient, walletId, signToPayload, paymentId,
}) {
    const requirements = selectRequirements(accepts, allowedNetworks);
    if (!requirements) {
        // Nothing we can/will pay — the caller hands the challenge back untouched.
        return null;
    }

    // Validate the merchant's requirements CLIENT-SIDE before the /authorize round-trip —
    // a missing SVM extra.feePayer (etc.) throws a clear local error here instead of an
    // opaque server response.
    validatePaymentRequirements(requirements);

    const { scheme, signing } = await authorizeClient.authorize({
        paymentRequirements: requirements,
        walletId: walletId,
    });
    const signedPayload = await signToPayload({
        scheme,
        signing,
        requirements
    });

    // `payment-identifier` (x402 extension): when the caller supplies an id it becomes the
    // facilitator's idempotency key, so a retry of a request whose response never arrived
    // settles once rather than twice. Resolved per-request so a caller can key it to their
    // own job/request id.
    const paymentPayload = withPaymentIdentifier(
        signedPayload,
        typeof paymentId === 'function' ? await paymentId({ requirements }) : paymentId
    );

    return {
        paymentPayload: paymentPayload,
        requirements: requirements
    };
}

export {
    buildPaymentForChallenge, selectRequirements
};
