import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from collector import cloud_cost as cost
from providers.runpod import provider as runpod

NOW = datetime(2026, 1, 2, 12, 30, tzinfo=timezone.utc)


def fake_fetch(url, key, payload=None):
    if key not in ('or-key', 'rp-key'):
        raise AssertionError('Unexpected credential')
    if url.endswith('/credits'):
        return {'data': {'total_credits': 100, 'total_usage': 34.25}}
    if url.endswith('/analytics/query'):
        assert payload == {
            'metrics': ['total_usage'],
            'granularity': 'minute',
            'time_range': {'start': '2026-01-02T11:30:00Z', 'end': '2026-01-02T12:30:00Z'},
        }
        return {'data': {'data': [
            {'date__minute': '2026-01-02 12:10:00', 'total_usage': '0.1'},
            {'date__minute': '2026-01-02 12:12:00', 'total_usage': '0.2'},
        ], 'metadata': {'truncated': False}}}
    if url.endswith('/graphql'):
        if 'clientBalance' in payload['query']:
            return {'data': {'myself': {'clientBalance': 10.5}}}
        return {'data': {'myself': {'billing': {'summary': [
            {'time': '2026-01-02T12:00:00Z', 'gpuCloudAmount': 0.25,
             'storageAmount': 0.03},
            {'time': '2026-01-02T11:29:59Z', 'gpuCloudAmount': 10},
            {'time': '2026-01-02T12:31:00Z', 'gpuCloudAmount': 10},
        ]}}}}
    raise AssertionError(url)


class CloudCostTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.cache_dir = Path(folder.name)
        self.sample_path = self.cache_dir / 'runpod-samples.json'

    def collect(self, lookup, fetch=fake_fetch, providers_dir=cost.PROVIDERS_DIR):
        return cost.collect(NOW, lookup, fetch, cache_dir=self.cache_dir,
                            providers_dir=providers_dir)['providers']

    def test_collect(self):
        status = cost.collect(NOW, lambda p: {'openrouter': 'or-key', 'runpod': 'rp-key'}[p],
                              fake_fetch, cache_dir=self.cache_dir)
        self.assertEqual(list(status['providers']), ['openrouter', 'runpod'])
        self.assertEqual(status['providers']['openrouter']['name'], 'OpenRouter')
        self.assertEqual(status['providers']['openrouter']['balance'], '65.75')
        self.assertEqual(status['providers']['openrouter']['last_hour_spend'], '0.3')
        self.assertEqual(status['providers']['runpod']['balance'], '10.5')
        self.assertEqual(status['providers']['runpod']['last_hour_spend'], '0.28')
        self.assertTrue(status['providers']['runpod']['configured'])
        self.assertEqual(status['updated_at'], '2026-01-02T12:30:00Z')

    def test_missing_key_does_not_break_other_service(self):
        def lookup(provider):
            if provider == 'runpod':
                raise RuntimeError('No runpod key in GNOME Keyring')
            return 'or-key'

        status = self.collect(lookup)
        self.assertEqual(status['openrouter']['last_hour_spend'], '0.3')
        self.assertFalse(status['runpod']['configured'])
        self.assertIsNone(status['runpod']['balance'])

    def test_truncated_analytics_never_reported_as_full_spend(self):
        def fetch(url, key, payload=None):
            result = fake_fetch(url, key, payload)
            if url.endswith('/analytics/query'):
                result['data']['metadata']['truncated'] = True
            return result

        row = self.collect(lambda _: 'or-key', fetch)['openrouter']
        self.assertEqual(row['balance'], '65.75')
        self.assertIsNone(row['last_hour_spend'])
        self.assertIn('incomplete', row['spend_error'])

    def test_missing_runpod_billing_is_not_a_zero(self):
        def fetch(url, key, payload=None):
            result = fake_fetch(url, key, payload)
            if url.endswith('/graphql') and 'billing(' in payload['query']:
                result['data']['myself']['billing']['summary'] = None
            return result

        row = self.collect(lambda _: 'rp-key', fetch)['runpod']
        self.assertEqual(row['balance'], '10.5')
        self.assertIsNone(row['last_hour_spend'])

    def test_runpod_balance_estimate_and_refill_reset(self):
        self.assertIsNone(runpod.record_balance(NOW - timedelta(hours=1),
                                                  cost.money('10'), self.sample_path))
        self.assertEqual(runpod.record_balance(NOW, cost.money('9.70'), self.sample_path),
                         cost.money('0.30'))
        self.assertIsNone(runpod.record_balance(NOW + timedelta(minutes=3),
                                                cost.money('20'), self.sample_path))
        self.assertIsNone(runpod.record_balance(NOW + timedelta(minutes=5),
                                                cost.money('19.90'), self.sample_path))
        self.assertEqual(self.sample_path.stat().st_mode & 0o777, 0o600)

    def test_runpod_billing_error_uses_explicit_estimate_after_hour(self):
        runpod.record_balance(NOW - timedelta(hours=1), cost.money('11'), self.sample_path)

        def fetch(url, key, payload=None):
            if url.endswith('/graphql') and 'billing(' in payload['query']:
                return {'data': {'myself': {'billing': {'summary': None}}},
                        'errors': [{'message': 'Provider failure'}]}
            return fake_fetch(url, key, payload)

        row = self.collect(lambda _: 'rp-key', fetch)['runpod']
        self.assertEqual(row['last_hour_spend'], '0.5')
        self.assertEqual(row['spend_source'], 'balance_estimate')
        self.assertIn('Estimate', row['spend_note'])

    def test_new_provider_discovered_and_broken_provider_isolated(self):
        directory = self.cache_dir / 'providers'
        for name, code in {
            'custom': "NAME = 'My Provider'\n"
                      "def balance(key, fetch): return '12.50'\n"
                      "def spend(key, now, fetch): return '0.125'\n",
            'broken': "raise RuntimeError('secret must not leak')\n",
            'failing': "NAME = 'Failing'\n"
                       "def balance(key, fetch): raise ValueError('secret must not leak')\n"
                       "def spend(key, now, fetch): raise RuntimeError('secret must not leak')\n",
        }.items():
            folder = directory / name
            folder.mkdir(parents=True)
            (folder / 'provider.py').write_text(code)
            (folder / 'icon.svg').write_text('<svg/>')
        rows = self.collect(lambda _: 'key', providers_dir=directory)
        self.assertEqual(rows['custom']['name'], 'My Provider')
        self.assertEqual(rows['custom']['balance'], '12.50')
        self.assertEqual(rows['custom']['last_hour_spend'], '0.125')
        self.assertEqual(rows['broken']['balance_error'], 'Provider plugin unavailable')
        self.assertEqual(rows['failing']['spend_error'], 'Unexpected provider response')
        self.assertNotIn('secret', json.dumps(rows))
        (directory / 'custom' / 'provider.py').unlink()
        self.assertNotIn('custom', self.collect(lambda _: 'key', providers_dir=directory))

    def test_publish_is_private_and_valid_json(self):
        path = self.cache_dir / 'cache' / 'status.json'
        cost.publish({'providers': {}, 'updated_at': cost.iso(NOW)}, path)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(path.parent).st_mode & 0o777, 0o700)
        self.assertEqual(json.loads(path.read_text())['updated_at'], '2026-01-02T12:30:00Z')


if __name__ == '__main__':
    unittest.main()
