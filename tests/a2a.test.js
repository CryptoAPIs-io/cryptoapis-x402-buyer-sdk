/**
 * A2A buyer transport — the third and last x402 transport.
 *
 * The last test is the important one: it wires this buyer against the MERCHANT SDK's own `/a2a`
 * adapter, so the two halves are proven to interoperate rather than each merely matching its own
 * reading of the spec.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createX402TaskSender, parseTaskChallenge, paymentMessage, toA2aPayload, readReceipts, META, STATUS,
} from '../src/a2a.js';

const NETWORK = 'eip155:8453';
const REQS = {
    scheme: 'exact',
    network: NETWORK,
    amount: '10000',
    asset: '0xasset',
    payTo: '0xmerchant'
};
const RESOURCE = { url: 'https://api.example.com/generate-image' };

/** A challenge task exactly as the spec's example shows it. */
function challengeTask(id = 'task-123') {
    return {
        kind: 'task',
        id: id,
        status: {
            state: 'input-required',
            message: {
                kind: 'message',
                role: 'agent',
                parts: [{
                    kind: 'text',
                    text: 'Payment is required.'
                }],
                metadata: {
                    [META.STATUS]: STATUS.REQUIRED,
                    [META.REQUIRED]: {
                        x402Version: 2,
                        resource: RESOURCE,
                        accepts: [REQS]
                    },
                },
            },
        },
    };
}

/** Buyer-service + signer stubs so the flow runs without network or keys. */
function deps() {
    return {
        apiKey: 'k',
        walletId: 'w',
        signToPayload: async ({ requirements }) => ({
            x402Version: 2,
            scheme: 'exact',
            network: requirements.network,
            payload: { signature: '0xsig' },
        }),
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                authorized: true,
                scheme: 'eip712',
                signing: {}
            }),
        }),
    };
}

test('parseTaskChallenge only fires on a PAYMENT input-required', () => {
    assert.ok(parseTaskChallenge(challengeTask()));
    assert.ok(parseTaskChallenge({ result: challengeTask() }), 'unwraps a JSON-RPC result');

    // input-required is A2A's generic "I need more from you" — state alone must NOT count.
    const plainPrompt = {
        kind: 'task',
        id: 't',
        status: {
            state: 'input-required',
            message: {
                metadata: {},
                parts: []
            }
        },
    };
    assert.equal(parseTaskChallenge(plainPrompt), null, 'a non-payment prompt is not a challenge');
    assert.equal(parseTaskChallenge({ status: { state: 'completed' } }), null);
    assert.equal(parseTaskChallenge(undefined), null);
});

test('paying a task: correlates by taskId and submits under the dotted payload key', async () => {
    const sent = [];
    const sendMessage = async (params) => {
        sent.push(params);
        return sent.length === 1
            ? challengeTask('task-abc')
            : {
                kind: 'task',
                id: 'task-abc',
                status: {
                    state: 'completed',
                    message: {
                        metadata: {
                            [META.STATUS]: STATUS.COMPLETED,
                            [META.RECEIPTS]: [{
                                success: true,
                                transaction: '0xtx',
                                network: NETWORK
                            }],
                        }
                    }
                }
            };
    };

    const payTask = createX402TaskSender(deps());
    const out = await payTask(sendMessage, {
        message: {
            role: 'user',
            parts: []
        }
    });

    assert.equal(sent.length, 2, 'exactly ONE retry — never a loop');
    const retry = sent[1].message;
    assert.equal(retry.taskId, 'task-abc', 'the payment is correlated to the task it answers');
    assert.equal(retry.metadata[META.STATUS], STATUS.SUBMITTED);

    const paid = retry.metadata[META.PAYLOAD];
    assert.ok(paid, 'payload sits under the literal dotted key');
    assert.deepEqual(paid.accepted, REQS, 'A2A echoes the chosen requirement under `accepted`');
    assert.deepEqual(paid.resource, RESOURCE);
    assert.equal(paid.network, NETWORK, 'the flat fields stay too, so common readers still work');
    assert.equal(paid.payload.signature, '0xsig');

    assert.equal(out.status.state, 'completed');
    assert.equal(readReceipts(out)[0].transaction, '0xtx');
});

test('a non-challenge task passes through untouched, unpaid', async () => {
    const done = {
        kind: 'task',
        id: 't',
        status: { state: 'completed' }
    };
    let calls = 0;
    const payTask = createX402TaskSender(deps());
    const out = await payTask(async () => { calls++; return done; }, { message: {} });
    assert.equal(calls, 1, 'no payment attempted');
    assert.deepEqual(out, done);
});

test('a challenge with no acceptable network is returned, not paid', async () => {
    let calls = 0;
    const payTask = createX402TaskSender({
        ...deps(),
        allowedNetworks: ['eip155:1']
    });
    const out = await payTask(async () => { calls++; return challengeTask(); }, { message: {} });
    assert.equal(calls, 1, 'never retried');
    assert.ok(parseTaskChallenge(out), 'the caller gets the challenge back so it can see the price');
});

test('a challenge task with no id throws rather than orphaning a payment', async () => {
    const noId = challengeTask();
    delete noId.id;
    const payTask = createX402TaskSender(deps());
    await assert.rejects(
        () => payTask(async () => noId, { message: {} }),
        /cannot correlate the payment/
    );
});

test('the SDK refuses to hold keys', () => {
    assert.throws(() => createX402TaskSender({ walletId: 'w' }), /signToPayload is required/);
    assert.throws(() => createX402TaskSender({ signToPayload: () => {} }), /walletId is required/);
});

test('helpers build the documented shapes', () => {
    const msg = paymentMessage({
        taskId: 't1',
        paymentPayload: { a: 1 }
    });
    assert.equal(msg.taskId, 't1');
    assert.equal(msg.role, 'user');
    assert.ok(Object.hasOwn(msg.metadata, 'x402.payment.payload'), 'literal dotted key');

    const wrapped = toA2aPayload({
        scheme: 'exact',
        network: NETWORK
    }, REQS, RESOURCE);
    assert.deepEqual(wrapped.accepted, REQS);
    assert.equal(wrapped.network, NETWORK);
    assert.equal(readReceipts({ status: { message: { metadata: {} } } }), undefined);
});

test('INTEROP: this buyer pays the MERCHANT SDK\'s own /a2a skill', async () => {
    // Import the merchant adapter directly from the sibling checkout — if the two halves disagree
    // on the wire shape, this is where it surfaces.
    const merchantUrl = new URL('../../cryptoapis-x402-merchant-sdk/src/a2a.js', import.meta.url);
    let paymentSkill;
    try {
        ({ paymentSkill } = await import(merchantUrl.href));
    } catch {
        console.log('  (merchant SDK checkout not present — interop check skipped)');
        return;
    }

    const facilitator = {
        verify: async () => ({
            isValid: true,
            payer: '0xpayer'
        }),
        settle: async () => ({
            success: true,
            payer: '0xpayer',
            transaction: '0xtx',
            network: NETWORK
        }),
    };
    const skill = paymentSkill({ facilitator })(
        RESOURCE,
        {
            network: NETWORK,
            asset: '0xasset',
            amount: '10000',
            payTo: '0xmerchant'
        },
        async () => ({
            artifacts: [{
                kind: 'image',
                name: 'out.png'
            }]
        })
    );

    // The merchant's skill IS the A2A server for this test; give it a task id like a real one.
    let task = null;
    const sendMessage = async (params) => {
        const res = await skill(params);
        task = {
            kind: 'task',
            id: 'task-interop',
            ...res
        };
        return task;
    };

    const payTask = createX402TaskSender(deps());
    const out = await payTask(sendMessage, {
        message: {
            role: 'user',
            parts: []
        }
    });

    assert.equal(out.status.state, 'completed', 'the merchant accepted the buyer\'s payment');
    assert.equal(out.status.message.metadata[META.STATUS], STATUS.COMPLETED);
    assert.equal(readReceipts(out)[0].transaction, '0xtx');
    assert.deepEqual(out.artifacts, [{
        kind: 'image',
        name: 'out.png'
    }], 'the paid work came back');
});
