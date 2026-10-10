// SPDX-License-Identifier: GPL-3.0-or-later
// Discovery runs only in the separate collector process; Shell sees only key-free status rows.
import Gio from 'gi://Gio';

const VALID_ID = /^[a-z][a-z0-9_-]*$/;

export async function discoverProviders(directory) {
    const root = Gio.File.new_for_path(directory);
    const entries = root.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    const ids = [];
    try {
        let info;
        while ((info = entries.next_file(null))) {
            const id = info.get_name();
            if (info.get_file_type() === Gio.FileType.DIRECTORY && VALID_ID.test(id))
                ids.push(id);
        }
    } finally {
        entries.close(null);
    }
    const providers = [];
    for (const id of ids.sort()) {
        const folder = root.get_child(id);
        const moduleFile = folder.get_child('provider.js');
        if (!moduleFile.query_exists(null) || !folder.get_child('icon.svg').query_exists(null) ||
            !folder.get_child('icon-white.svg').query_exists(null))
            continue;
        try {
            const module = await import(moduleFile.get_uri());
            if (typeof module.name !== 'string' || !module.name ||
                typeof module.balance !== 'function' || typeof module.spend !== 'function')
                throw new Error('Invalid provider module');
            providers.push({id, name: module.name, balance: module.balance, spend: module.spend,
                estimateFromBalance: module.estimateFromBalance === true});
        } catch (_) {
            // A broken provider must not prevent other providers from updating. Never log raw errors.
            printerr(`Cloud Cost: could not load provider ${id}`);
        }
    }
    return providers;
}
