/**
 * LangChain adapter — expose x402 payment as a LangChain `DynamicStructuredTool`:
 *
 *   import { x402PayTool } from '@cryptoapis-io/x402-buyer-sdk/langchain';
 *
 *   const tool = await x402PayTool({ apiKey, walletId, signer });
 *   // add `tool` to your agent's tools list (createReactAgent, AgentExecutor, …)
 *
 * `@langchain/core` + `zod` are PEER dependencies (the caller has them); imported
 * lazily so the buyer SDK stays zero-dep.
 */

import { createPayTool } from './agentTool.js';

/**
 * Build a LangChain tool for x402 payment.
 *
 * @param {Object} config the createX402Fetch config ({apiKey, walletId, signer, ...})
 * @param {Object} [deps] `{ DynamicStructuredTool, z }`; auto-imported from @langchain/core + zod if omitted
 * @return {Promise<Object>|Object} the LangChain tool (a Promise when auto-importing)
 */
function x402PayTool(config, deps) {
    const t = createPayTool(config);
    const build = ({ DynamicStructuredTool, z }) => new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: z.object({
            url: z.string().describe('The URL to fetch; a 402 is auto-paid'),
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
            body: z.string().optional(),
        }),
        func: async (args) => JSON.stringify(await t.execute(args)),
    });
    if (deps) {
        return build(deps);
    }
    return Promise.all([import('@langchain/core/tools'), import('zod')])
        .then(([tools, zod]) => build({
            DynamicStructuredTool: tools.DynamicStructuredTool,
            z: zod.z ?? zod.default ?? zod
        }));
}

export { x402PayTool };
