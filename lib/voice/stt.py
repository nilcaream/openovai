# Speech to text for the page's voice button: one process, started by the ovai server with the
# Python of the voice environment (lib/chat/voice.mjs), that loads the model once and then answers
# one request per line on stdin with one answer per line on stdout, in order, until stdin closes.
#
#   python stt.py <model directory>
#   in:  {"pcm": "<base64 of 16-bit little-endian mono samples at 16 kHz>", "language": "en", "prompt": "Glossary: ..."}
#   out: {"ready": true} once, when the model is loaded; then {"text": "..."} or {"error": "..."} per request
#
# It opens no port and reads no file but the model: the audio comes in as samples the page already
# decoded, so no container format is parsed here. The model is read from the directory the server
# names, with the Hugging Face hub kept offline, so nothing goes on the network.

import base64
import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"

import numpy  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402


def say(answer):
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 2:
        say({"error": "stt.py takes the model directory"})
        return 2
    threads = max(1, min(8, os.cpu_count() or 1))
    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    say({"ready": True})
    for line in sys.stdin:
        try:
            asked = json.loads(line)
            samples = numpy.frombuffer(base64.b64decode(asked["pcm"]), dtype="<i2").astype(numpy.float32) / 32768.0
            segments, _ = model.transcribe(samples, language=asked["language"], initial_prompt=asked.get("prompt") or None, beam_size=5)
            say({"text": " ".join(segment.text.strip() for segment in segments).strip()})
        except Exception as error:  # one bad request is answered, and the next one is read
            say({"error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
