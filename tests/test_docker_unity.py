from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import unittest
from unittest.mock import patch
import warnings

import UnityPy
from UnityPy.exceptions import UnityVersionFallbackWarning
from UnityPy.files.BundleFile import BundleFile

from idoly_story_index import unity


class UnitySetupTests(unittest.TestCase):
    def setUp(self):
        self.warnings = warnings.catch_warnings(record=True)
        self.captured = self.warnings.__enter__()
        warnings.simplefilter('always')
        self.version = UnityPy.config.FALLBACK_UNITY_VERSION
        self.configured = unity._configured_version
        unity._configured_version = None

    def tearDown(self):
        self.warnings.__exit__(None, None, None)
        UnityPy.config.FALLBACK_UNITY_VERSION = self.version
        unity._configured_version = self.configured

    def test_parallel_loads_log_configuration_once_and_keep_other_warnings(self):
        def load(data):
            warnings.warn_explicit('missing metadata', UnityVersionFallbackWarning, 'BundleFile.py', 533,
                                   module='UnityPy.files.BundleFile')
            warnings.warn_explicit('different problem', UserWarning, 'BundleFile.py', 500,
                                   module='UnityPy.files.BundleFile')
            return data
        output = io.StringIO()
        with patch.dict('os.environ', {'IDOLY_UNITY_VERSION': '2022.3.57f1'}), \
             patch('UnityPy.load', side_effect=load), redirect_stdout(output):
            with ThreadPoolExecutor(max_workers=4) as pool:
                self.assertEqual(list(pool.map(unity.load_bundle, range(12))), list(range(12)))
        self.assertEqual(output.getvalue().count('Assets:'), 1)
        self.assertEqual(len(self.captured), 12)
        self.assertTrue(all(item.category is UserWarning for item in self.captured))

    def test_valid_embedded_version_is_preserved_and_zero_uses_fallback(self):
        with patch('UnityPy.load'), patch.dict('os.environ', {'IDOLY_UNITY_VERSION': '2022.3.57f1'}):
            unity.load_bundle(b'')
        bundle = BundleFile.__new__(BundleFile)
        bundle.version_engine = '2021.3.10f1'
        version = bundle.parse_version()
        self.assertEqual((version.major, version.minor, version.build), (2021, 3, 10))
        bundle.version_engine = '0.0.0'
        version = bundle.parse_version()
        self.assertEqual((version.major, version.minor, version.build), (2022, 3, 57))
        self.assertFalse(self.captured)

    def test_invalid_fallback_rejected_before_decode(self):
        for version in ('', '0.0.0', 'not-a-version'):
            with self.subTest(version=version), patch.dict('os.environ', {'IDOLY_UNITY_VERSION': version}), patch('UnityPy.load') as decode:
                with self.assertRaisesRegex(ValueError, 'IDOLY_UNITY_VERSION'):
                    unity.load_bundle(b'')
                decode.assert_not_called()

    def test_parse_errors_are_not_suppressed(self):
        with patch.dict('os.environ', {'IDOLY_UNITY_VERSION': '2022.3.57f1'}), patch('UnityPy.load', side_effect=ValueError('bad bundle')):
            with self.assertRaisesRegex(ValueError, 'bad bundle'):
                unity.load_bundle(b'invalid')


if __name__ == '__main__':
    unittest.main()
