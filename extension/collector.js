// SPDX-License-Identifier: GPL-3.0-or-later
// Run with `gjs -m collector.js` in a separate process. Credentials never enter GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {collect, ProviderError} from './collector-core.js';

const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-cloud-cost']);
const statusPath = GLib.build_filenamev([cacheDir, 'status.json']);
const samplesPath = GLib.build_filenamev([cacheDir, 'runpod-samples.json']);
const session = new Soup.Session({timeout: 15, user_agent: 'CloudCost/1.0'});

function readJson(path) {
    const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok)
        throw new Error('Cannot read cache');
    return JSON.parse(new TextDecoder().decode(contents));
}

function publish(path, value) {
    if (GLib.mkdir_with_parents(cacheDir, 0o700) !== 0 || GLib.chmod(cacheDir, 0o700) !== 0)
        throw new Error('Cannot create private cache directory');
    const data = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    Gio.File.new_for_path(path).replace_contents(
        data, null, false, Gio.FileCreateFlags.PRIVATE, null);
    // Gio may preserve an existing file's mode on replacement.
    if (GLib.chmod(path, 0o600) !== 0)
        throw new Error('Cannot protect cache file');
}

function lookup(id) {
    // secret-tool store uses the generic Secret Service schema. A null lookup schema
    // matches the two attributes independently of the item's schema name.
    return Secret.password_lookup_sync(null,
        {service: 'gnome-cloud-cost', provider: id}, null)?.trim() ?? null;
}

function fetchJson(url, key, payload = null) {
    const message = Soup.Message.new(payload === null ? 'GET' : 'POST', url);
    if (!message)
        throw new ProviderError('Provider request failed');
    message.request_headers.append('Authorization', `Bearer ${key}`);
    message.request_headers.append('Accept', 'application/json');
    if (payload !== null)
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(payload))));
    let contents;
    try {
        contents = session.send_and_read(message, null);
    } catch (_) {
        // libsoup errors may contain request details; never show them or log the key.
        throw new ProviderError('Provider request failed (network or timeout)');
    }
    if (message.status_code < 200 || message.status_code >= 300)
        throw new ProviderError(`HTTP ${message.status_code} from provider`);
    try {
        return JSON.parse(new TextDecoder().decode(contents.get_data()));
    } catch (_) {
        throw new ProviderError('Provider returned invalid JSON');
    }
}

function main() {
    const status = collect(new Date(), lookup, fetchJson,
        () => {
            try {
                return readJson(samplesPath);
            } catch (_) {
                return [];
            }
        }, samples => publish(samplesPath, samples));
    publish(statusPath, status);
}

try {
    main();
} catch (_) {
    // A failure to publish is signalled by exit status, not an exception that might leak data.
    System.exit(1);
}
