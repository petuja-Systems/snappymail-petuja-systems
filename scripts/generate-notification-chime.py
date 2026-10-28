#!/usr/bin/env python3
"""Generate petuja.email's original, deterministic notification chime as PCM WAV.

Usage: python3 scripts/generate-notification-chime.py OUTPUT.wav

The sound is a soft, rising E-major arpeggio (E5, G#5, B5), with a short
cosine attack, decaying inharmonic partials, and a short tail fade. The script
uses only the Python standard library. Encode its WAV output with a temporary
FFmpeg build when regenerating the MP3 and Ogg assets:

    ffmpeg -i OUTPUT.wav -map_metadata -1 -ac 1 -ar 44100 \
      -c:a libmp3lame -b:a 48k -write_xing 0 -id3v2_version 0 OUTPUT.mp3
    ffmpeg -i OUTPUT.wav -map_metadata -1 -ac 1 -ar 44100 \
      -c:a libvorbis -q:a 3 OUTPUT.ogg
"""

import argparse
import math
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44_100
DURATION_SECONDS = 0.84
TARGET_RMS = 10 ** (-24 / 20)
MAX_PEAK = 10 ** (-6.8 / 20)
NOTES = (
    (659.255, 0.00),  # E5
    (830.609, 0.19),  # G#5
    (987.767, 0.38),  # B5
)
PARTIALS = (
    (1.00, 1.00, 0.34),
    (2.01, 0.22, 0.24),
    (3.98, 0.06, 0.15),
)
ATTACK_SECONDS = 0.012
TAIL_FADE_SECONDS = 0.055


def synthesize_samples():
    """Return mono signed 16-bit samples with deterministic gain and timing."""
    frame_count = round(SAMPLE_RATE * DURATION_SECONDS)
    floating_samples = []

    for frame in range(frame_count):
        time = frame / SAMPLE_RATE
        sample = 0.0

        for frequency, onset in NOTES:
            elapsed = time - onset
            if elapsed < 0:
                continue

            attack = min(1.0, elapsed / ATTACK_SECONDS)
            attack = 0.5 - 0.5 * math.cos(math.pi * attack)

            for ratio, amplitude, decay_seconds in PARTIALS:
                sample += (
                    amplitude * attack
                    * math.exp(-elapsed / decay_seconds)
                    * math.sin(2 * math.pi * frequency * ratio * elapsed)
                )

        fade_start = DURATION_SECONDS - TAIL_FADE_SECONDS
        if time > fade_start:
            fade_progress = min(1.0, (time - fade_start) / TAIL_FADE_SECONDS)
            sample *= 0.5 + 0.5 * math.cos(math.pi * fade_progress)

        floating_samples.append(sample)

    peak = max(abs(sample) for sample in floating_samples)
    rms = math.sqrt(sum(sample * sample for sample in floating_samples) / frame_count)
    gain = min(TARGET_RMS / rms, MAX_PEAK / peak)

    return [
        max(-32768, min(32767, round(sample * gain * 32767)))
        for sample in floating_samples
    ]


def write_wav(destination):
    samples = synthesize_samples()
    pcm = struct.pack('<' + 'h' * len(samples), *samples)
    with wave.open(str(destination), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='destination PCM WAV file')
    args = parser.parse_args()
    write_wav(args.output)


if __name__ == '__main__':
    main()
