// SPDX-License-Identifier: GPL-3.0-or-later
// Shared validation helpers for provider modules and the collector.
export class ProviderError extends Error {}

export function money(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim()))
        throw new Error('Missing amount');
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new Error('Invalid amount');
    return number;
}

// Avoid exposing floating-point summation artifacts without erasing tiny charges.
export function dollars(value) {
    return String(Number(value.toPrecision(15)));
}

export function iso(time) {
    return time.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function timestamp(value) {
    if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value))
        throw new Error('Missing time zone');
    const result = Date.parse(value);
    if (!Number.isFinite(result))
        throw new Error('Invalid timestamp');
    return result;
}
