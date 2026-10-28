import hashlib
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / 'scripts' / 'generate-notification-chime.py'


class NotificationSoundGeneratorTests(unittest.TestCase):
    def test_generator_is_deterministic_and_emits_expected_pcm_waveform(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            first_path = Path(directory) / 'first.wav'
            second_path = Path(directory) / 'second.wav'
            for output in (first_path, second_path):
                subprocess.run(
                    [sys.executable, str(GENERATOR), str(output)],
                    check=True,
                    cwd=ROOT,
                )

            first = first_path.read_bytes()
            second = second_path.read_bytes()
            self.assertEqual(hashlib.sha256(first).digest(), hashlib.sha256(second).digest())

            with wave.open(str(first_path), 'rb') as audio:
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getframerate(), 44_100)
                self.assertEqual(audio.getnframes(), round(44_100 * 0.84))
                samples = struct.unpack('<' + 'h' * audio.getnframes(), audio.readframes(audio.getnframes()))

            self.assertEqual(samples[0], 0)
            self.assertEqual(samples[-1], 0)
            self.assertGreater(max(abs(sample) for sample in samples), 4_000)
            self.assertLess(max(abs(sample) for sample in samples), 32_000)


if __name__ == '__main__':
    unittest.main()
