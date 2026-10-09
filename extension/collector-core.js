// SPDX-License-Identifier: GPL-3.0-or-later
// Pure collection logic. The separate collector.js process supplies keyring, HTTP and disk I/O.

const HOUR = 60 * 60 * 1000;
const AMOUNTS = [
    'gpuCloudAmount', 'cpuCloudAmount', 'serverlessAmount',
    'storageAmount', 'runpodEndpointAmount',
];

export class ProviderError extends Error {}

function money(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim()))
        throw new Error('Missing amount');
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new Error('Invalid amount');
    return number;
}

// Avoid exposing floating-point summation artifacts without erasing tiny charges.
function dollars(value) {
    return String(Number(value.toPrecision(15)));
}

function iso(time) {
    return time.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestamp(value) {
    if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value))
        throw new Error('Missing time zone');
    const result = Date.parse(value);
    if (!Number.isFinite(result))
        throw new Error('Invalid timestamp');
    return result;
}

export function openrouterBalance(key, fetch) {
    const data = fetch('https://openrouter.ai/api/v1/credits', key).data;
    return money(data.total_credits) - money(data.total_usage);
}

export function openrouterSpend(key, now, fetch) {
    const data = fetch('https://openrouter.ai/api/v1/analytics/query', key, {
        metrics: ['total_usage'], granularity: 'minute',
        time_range: {start: iso(new Date(now.getTime() - HOUR)), end: iso(now)},
    }).data;
    if (data.metadata.truncated || data.warnings?.length)
        throw new ProviderError('OpenRouter analytics response is incomplete');
    if (!Array.isArray(data.data))
        throw new ProviderError('OpenRouter analytics rows missing');
    return data.data.reduce((sum, row) => sum + money(row.total_usage), 0);
}

function runpodQuery(key, query, fetch) {
    const response = fetch('https://api.runpod.io/graphql', key, {query});
    if (response.errors?.length)
        throw new ProviderError('RunPod GraphQL query rejected');
    return response.data.myself;
}

export function runpodBalance(key, fetch) {
    return money(runpodQuery(key, 'query { myself { clientBalance } }', fetch).clientBalance);
}

export function runpodSpend(key, now, fetch) {
    const query = 'query { myself { billing(input: {granularity: MINUTELY}) { summary { time gpuCloudAmount cpuCloudAmount serverlessAmount storageAmount runpodEndpointAmount } } } }';
    const rows = runpodQuery(key, query, fetch).billing.summary;
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

// Called after every successful balance poll, including when billing succeeds.
// An increase clears the window: a smaller refill masked by charges cannot be detected.
export function recordBalance(now, amount, previous) {
    const end = now.getTime();
    let samples = [];
    if (Array.isArray(previous)) {
        try {
            const parsed = previous.map(row => ({time: timestamp(row.time), balance: money(row.balance)}))
                .sort((a, b) => a.time - b.time);
            // A future sample means the clock has moved backwards. Never reuse it.
            if (parsed.length && parsed.at(-1).time <= end)
                samples = parsed.filter(row => row.time >= end - 2 * HOUR);
        } catch (_) {
            samples = [];
        }
    }
    if (samples.length && (end <= samples.at(-1).time || amount > samples.at(-1).balance + 0.01))
        samples = [];
    samples.push({time: end, balance: amount});
    const target = end - HOUR;
    const nearest = samples.reduce((best, row) =>
        Math.abs(row.time - target) < Math.abs(best.time - target) ? row : best);
    return {
        samples: samples.map(row => ({time: iso(new Date(row.time)), balance: dollars(row.balance)})),
        estimate: Math.abs(nearest.time - target) <= 4 * 60 * 1000
            ? Math.max(0, nearest.balance - amount) : null,
    };
}

function safeError(error) {
    // Never put an arbitrary exception (which may include credentials or response data) in the cache.
    return error instanceof ProviderError ? error.message : 'Unexpected provider response';
}

export function collect(now, lookup, fetch, readSamples, writeSamples) {
    const status = {updated_at: iso(now), providers: {}};
    const providers = [
        {id: 'openrouter', name: 'OpenRouter', balance: openrouterBalance, spend: openrouterSpend},
        {id: 'runpod', name: 'RunPod', balance: runpodBalance, spend: runpodSpend},
    ];
    for (const provider of providers) {
        const row = {
            name: provider.name, configured: false, balance: null, last_hour_spend: null,
            balance_error: null, spend_error: null, spend_source: null, spend_note: null,
        };
        status.providers[provider.id] = row;
        let key;
        try {
            key = lookup(provider.id);
        } catch (_) {
            row.balance_error = row.spend_error = 'Cannot access Secret Service (is GNOME Keyring unlocked?)';
            continue;
        }
        if (!key) {
            row.balance_error = row.spend_error = `No ${provider.name} key in GNOME Keyring`;
            continue;
        }
        row.configured = true;
        let balance = null;
        try {
            balance = money(provider.balance(key, fetch));
            row.balance = dollars(balance);
        } catch (error) {
            row.balance_error = safeError(error);
        }
        let estimate = null;
        if (provider.id === 'runpod' && balance !== null) {
            try {
                const history = recordBalance(now, balance, readSamples());
                writeSamples(history.samples);
                estimate = history.estimate;
            } catch (_) {
                // Billing may still work even if history cannot be saved.
            }
        }
        try {
            row.last_hour_spend = dollars(money(provider.spend(key, now, fetch)));
            row.spend_source = 'billing';
        } catch (error) {
            if (estimate !== null) {
                row.last_hour_spend = dollars(estimate);
                row.spend_source = 'balance_estimate';
                row.spend_note = 'Estimate from balance changes; small refills may be missed';
            } else if (provider.id === 'runpod' && balance !== null) {
                row.spend_error = 'RunPod billing unavailable; collecting ~1h of balance history';
            } else {
                row.spend_error = safeError(error);
            }
        }
    }
    return status;
}
