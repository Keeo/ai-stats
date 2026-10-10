// SPDX-License-Identifier: GPL-3.0-or-later
import {money, iso, ProviderError} from '../../provider-utils.js';

export const name = 'OpenRouter';

export function balance(key, fetch) {
    const data = fetch('https://openrouter.ai/api/v1/credits', key).data;
    return money(data.total_credits) - money(data.total_usage);
}

export function spend(key, now, fetch) {
    const start = new Date(now.getTime() - 60 * 60 * 1000);
    const data = fetch('https://openrouter.ai/api/v1/analytics/query', key, {
        metrics: ['total_usage'], granularity: 'minute',
        time_range: {start: iso(start), end: iso(now)},
    }).data;
    if (data.metadata.truncated || data.warnings?.length)
        throw new ProviderError('OpenRouter analytics response is incomplete');
    if (!Array.isArray(data.data))
        throw new ProviderError('OpenRouter analytics rows missing');
    return data.data.reduce((sum, row) => sum + money(row.total_usage), 0);
}
