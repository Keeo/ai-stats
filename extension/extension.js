import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STALE_AFTER_SECONDS = 600;

function usd(value) {
    if (value === null || value === undefined)
        return '-';
    const number = Number(value);
    return Number.isFinite(number) ? `$${number.toFixed(2)}` : '-';
}

function amount(value) {
    if (value === null || value === undefined)
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

// A fresh GType name lets GNOME's Looking Glass reload a changed module in
// the same Shell process without colliding with the previously loaded class.
const CloudCostIndicator = GObject.registerClass({
    GTypeName: `CloudCostIndicator_${GLib.uuid_string_random().replaceAll('-', '')}`,
}, class CloudCostIndicator extends PanelMenu.Button {
    _init(directory) {
        super._init(0.5, 'Cloud spending');
        this._bar = new St.BoxLayout({style_class: 'cloud-cost-bar'});
        this.add_child(this._bar);
        this._directory = directory;
        this._segments = {};
        this._rows = {};
        this._titles = {};
        this._ids = [];
        this._staleLabel = new St.Label({
            text: 'stale', visible: false, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'cloud-cost-stale',
        });
        this._bar.add_child(this._staleLabel);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._footer.label.text = 'Waiting for collector';
        this.menu.addMenuItem(this._footer);

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncProviders(providers) {
        // The collector's cache is the provider manifest. Rebuild only when its
        // IDs change, so adding/removing a folder needs no Shell code change.
        const ids = Object.keys(providers).filter(id => /^[a-z][a-z0-9_-]*$/.test(id)).sort();
        if (ids.join('\0') === this._ids.join('\0'))
            return;
        for (const id of this._ids) {
            this._segments[id].group.destroy();
            this._rows[id].destroy();
        }
        this._ids = ids;
        this._segments = {};
        this._rows = {};
        for (const [index, id] of ids.entries()) {
            const group = new St.BoxLayout({style_class: 'cloud-cost-provider'});
            const iconFile = Gio.File.new_for_path(GLib.build_filenamev([
                this._directory, 'providers', id, 'icon.svg',
            ]));
            const icon = iconFile.query_exists(null)
                ? {gicon: new Gio.FileIcon({file: iconFile})}
                : {icon_name: 'dialog-question-symbolic'};
            group.add_child(new St.Icon({
                ...icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
                style_class: 'cloud-cost-icon system-status-icon',
            }));
            const credit = new St.Label({text: '-', y_align: Clutter.ActorAlign.CENTER});
            const rate = new St.Label({text: '-', y_align: Clutter.ActorAlign.CENTER});
            const dot = new St.Label({
                text: '·', y_align: Clutter.ActorAlign.CENTER, style_class: 'cloud-cost-dot',
            });
            group.add_child(credit);
            group.add_child(dot);
            group.add_child(rate);
            this._bar.insert_child_at_index(group, index);
            this._segments[id] = {group, credit, dot, rate};
            const row = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            this.menu.addMenuItem(row, index);
            this._rows[id] = row;
        }
    }

    _updatePanel(providers, stale) {
        for (const id of this._ids) {
            const row = providers[id] ?? {};
            const credit = stale ? null : amount(row.balance);
            const spend = stale ? null : amount(row.last_hour_spend);
            const segment = this._segments[id];
            segment.credit.text = credit === null ? '-' : `$${Math.floor(credit)}`;
            // Hide negligible reported spending, never unavailable spending.
            const negligible = spend !== null && spend < 0.001;
            segment.dot.visible = !negligible;
            segment.rate.visible = !negligible;
            segment.rate.text = spend === null ? '-' :
                `${row.spend_source === 'balance_estimate' ? '≈' : ''}$${(Math.ceil(spend * 10) / 10).toFixed(1)}/h`;
            segment.rate.remove_style_class_name('cloud-cost-rate-warning');
            segment.rate.remove_style_class_name('cloud-cost-rate-danger');
            // Compare unrounded values so the display rounding does not trigger an alert.
            if (spend !== null && credit !== null && spend > 0 &&
                (credit <= 0 || spend > credit * 0.05)) {
                segment.rate.add_style_class_name('cloud-cost-rate-danger');
            } else if (spend !== null && spend > 1) {
                segment.rate.add_style_class_name('cloud-cost-rate-warning');
            }
        }
        this._staleLabel.visible = stale;
    }

    _refresh() {
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(),
            'gnome-cloud-cost', 'status.json']);
        let status;
        try {
            const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                throw new Error('Cannot read status file');
            status = JSON.parse(new TextDecoder().decode(contents));
        } catch (_error) {
            this._updatePanel({}, true);
            for (const id of this._ids)
                this._rows[id].label.text = `${this._titles[id] ?? id}: - (unavailable)`;
            this._footer.label.text = 'No collector data (see README)';
            return;
        }

        const updated = Date.parse(status.updated_at);
        const age = (Date.now() - updated) / 1000;
        const stale = !Number.isFinite(age) || age < -60 || age > STALE_AFTER_SECONDS;
        const providers = status.providers && typeof status.providers === 'object' &&
            !Array.isArray(status.providers) ? status.providers : {};
        this._syncProviders(providers);
        this._updatePanel(providers, stale);
        for (const id of this._ids) {
            const row = providers[id] ?? {};
            const title = typeof row.name === 'string' ? row.name : id;
            this._titles[id] = title;
            const spend = `${row.spend_source === 'balance_estimate' ? '≈' : ''}${usd(row.last_hour_spend)}`;
            let text = `${title}: ${usd(row.balance)} credit · ${spend} last 1h`;
            const errors = [row.balance_error, row.spend_error, row.spend_note].filter(Boolean);
            if (errors.length)
                text += ` (${[...new Set(errors)].join('; ')})`;
            this._rows[id].label.text = text;
        }
        this._footer.label.text = Number.isFinite(age)
            ? `${stale ? 'Stale · ' : ''}Updated ${new Date(updated).toLocaleTimeString()}`
            : 'Invalid update time';
    }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        super.destroy();
    }
});

export default class CloudCostExtension extends Extension {
    enable() {
        this._indicator = new CloudCostIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
