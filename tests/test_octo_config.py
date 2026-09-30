import hashlib
import unittest

from idoly_story_index.octo_source import aes_key


class OctoKeyTests(unittest.TestCase):
    def test_original_text_is_sha256_derived(self):
        for value in ('example-passphrase', '0123456789abcdef', ' keep spaces '):
            with self.subTest(value=value):
                self.assertEqual(aes_key({'IDOLY_OCTO_AES_PASSPHRASE': value}),
                                 hashlib.sha256(value.encode()).digest())

    def test_derived_hex_key_is_not_hashed_again(self):
        for size in (16, 24, 32):
            key = bytes(range(size))
            self.assertEqual(aes_key({'IDOLY_OCTO_AES_KEY_HEX': key.hex().upper()}), key)

    def test_invalid_hex_has_actionable_message_without_value(self):
        secret = 'private-passphrase-example'
        with self.assertRaises(ValueError) as caught:
            aes_key({'IDOLY_OCTO_AES_KEY_HEX': secret})
        self.assertIn('IDOLY_OCTO_AES_PASSPHRASE', str(caught.exception))
        self.assertNotIn(secret, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_both_values_rejected_instead_of_silently_selecting_hex(self):
        with self.assertRaisesRegex(ValueError, 'Set only one'):
            aes_key({'IDOLY_OCTO_AES_KEY_HEX': 'ab' * 32,
                     'IDOLY_OCTO_AES_PASSPHRASE': 'example'})

    def test_missing_or_invalid_length_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing'):
            aes_key({})
        for value in ('aa', 'aa' * 15, 'aa' * 33):
            with self.assertRaisesRegex(ValueError, '16, 24 or 32 bytes'):
                aes_key({'IDOLY_OCTO_AES_KEY_HEX': value})


if __name__ == '__main__':
    unittest.main()
