// SPDX-License-Identifier: GPL-3.0-or-later
import {money, timestamp, ProviderError} from '../../provider-utils.js';

export const name = 'RunPod';
export const estimateFromBalance = true;

const HOUR = 60 * 60 * 1000;
const AMOUNTS = [
    'gpuCloudAmount', 'cpuCloudAmount', 'serverlessAmount',
    'storageAmount', 'runpodEndpointAmount',
];

function query(key, graphql, fetch) {
    const response = fetch('https://api.runpod.io/graphql', key, {query: graphql});
    if (response.errors?.length)
        throw new ProviderError('RunPod GraphQL query rejected');
    return response.data.myself;
}

export function balance(key, fetch) {
    return money(query(key, 'query { myself { clientBalance } }', fetch).clientBalance);
}

export function spend(key, now, fetch) {
    const graphql = 'query { myself { billing(input: {granularity: MINUTELY}) { summary { time gpuCloudAmount cpuCloudAmount serverlessAmount storageAmount runpodEndpointAmount } } } }';
    const rows = query(key, graphql, fetch).billing.summary;
    if (!Array.isArray(rows))
        throw new ProviderError('RunPod billing summary unavailable');
    const end = now.getTime();
    return rows.reduce((sum, row) => {
        const time = timestamp(row.time);
        if (time < end - HOUR || time > end)
            return sum;
        return sum + AMOUNTS.reduce((subtotal, field) => subtotal + money(row[field] ?? 0), 0);
    }, 0);
}
