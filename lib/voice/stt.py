# Speech to text for the page's voice button: one process, started by the ovai server with the
# Python of the voice environment (lib/chat/voice.mjs), that loads the model once and then answers
# one request per line on stdin with one answer per line on stdout, in order, until stdin closes.
#
#   python stt.py <model directory>
#   in:  {"pcm": "<base64 of 16-bit little-endian mono samples at 16 kHz>", "language": "en", "words": ["Mira", "ovai", ...]}
#   out: {"ready": true} once, when the model is loaded; then {"text": "..."} or {"error": "..."} per request
#
# It opens no port and reads no file but the model: the audio comes in as samples the page already
# decoded, so no container format is parsed here. The model is read from the directory the server
# names, with the Hugging Face hub kept offline, so nothing goes on the network.

import base64
import importlib.util
import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"

import numpy  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

# faster-whisper's voice-activity filter (Silero VAD) cuts silence and noise out before Whisper,
# which writes confident text for them ("Closed Captioning by …"); speech comes through unchanged.
# It runs on onnxruntime, which requirements.txt leaves out on an Intel Mac: there, no filter.
VAD = importlib.util.find_spec("onnxruntime") is not None

# Whisper's prompt: faster-whisper keeps the last max_length // 2 - 1 = 223 tokens of it and drops
# the start without a word (transcribe.py, get_prompt), and each token of it costs time (about 0.35 s
# per 100 tokens on an 8-core laptop). The words come most important first; as many are kept as fit
# in PROMPT_TOKENS, counted with the model's own tokenizer, and they are written most important LAST,
# because when a recording runs past one 30 s window, the text heard so far pushes the start out.
PROMPT_TOKENS = 223


def glossary(words, count, most=PROMPT_TOKENS):
    kept = []
    for word in words:
        if count(" Glossary: " + ", ".join(reversed(kept + [word])) + ".") > most:
            break
        kept.append(word)
    return "Glossary: " + ", ".join(reversed(kept)) + "." if kept else None


def say(answer):
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 2:
        say({"error": "stt.py takes the model directory"})
        return 2
    threads = max(1, min(8, os.cpu_count() or 1))
    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    def count(text):
        return len(model.hf_tokenizer.encode(text, add_special_tokens=False).ids)

    say({"ready": True})
    for line in sys.stdin:
        try:
            asked = json.loads(line)
            samples = numpy.frombuffer(base64.b64decode(asked["pcm"]), dtype="<i2").astype(numpy.float32) / 32768.0
            segments, _ = model.transcribe(samples, language=asked["language"], initial_prompt=glossary(asked.get("words") or [], count), beam_size=5, vad_filter=VAD)
            say({"text": " ".join(segment.text.strip() for segment in segments).strip()})
        except Exception as error:  # one bad request is answered, and the next one is read
            say({"error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
