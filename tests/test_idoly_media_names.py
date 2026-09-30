from types import SimpleNamespace
import unittest

from idoly_story_index.media import select_voice_clips


class VoiceNameTests(unittest.TestCase):
    def test_game_bank_extension_variant(self):
        name = 'sud_vo_adv_card_mna_09_02-koh010'
        correct = SimpleNamespace(m_Name=name + '.wav')
        malformed = SimpleNamespace(m_Name=name + 'wav')
        self.assertEqual(select_voice_clips([malformed, correct], [name]), {name: correct})

    def test_exact_name_takes_priority_independent_of_order(self):
        exact = SimpleNamespace(m_Name='voice')
        suffixed = SimpleNamespace(m_Name='voice.wav')
        for clips in ([exact, suffixed], [suffixed, exact]):
            self.assertIs(select_voice_clips(clips, ['voice'])['voice'], exact)

    def test_missing_names_are_not_guessed(self):
        self.assertEqual(select_voice_clips([SimpleNamespace(m_Name='voicewav')], ['voice']), {})

    def test_ambiguous_clip_names_fail(self):
        for name in ('voice', 'voice.wav'):
            with self.assertRaisesRegex(ValueError, 'Ambiguous audio name'):
                select_voice_clips([SimpleNamespace(m_Name=name), SimpleNamespace(m_Name=name)], ['voice'])


if __name__ == '__main__':
    unittest.main()
