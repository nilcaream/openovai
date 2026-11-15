# Speech to text for the page's voice button: one process, started by the ovai server with the
# Python of the voice environment (lib/chat/voice.mjs), that loads the model once and then answers
# one request per line on stdin with one answer per line on stdout, in order, until stdin closes.
#
#   python stt.py <model directory>
#   in:  {"pcm": "<base64 of 16-bit little-endian mono samples at 16 kHz>", "language": "en", "words": ["Mira", "ovai", ...], "previous": "..."}
#   out: {"ready": true} once, when the model is loaded; then per request, {"progress": <0..1>} as each
#        segment is written (its end over the samples' length), and last {"text": "..."} or {"error": "..."}
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


# A dictation is turned into text in stretches cut at pauses, each told the text before it: the last
# PREVIOUS_TOKENS of that text, cut at a word, go at the END of the prompt, where Whisper reads them
# as what was just said and where faster-whisper keeps them; the glossary gets what is left.
PREVIOUS_TOKENS = 96


def prompt(words, previous, count):
    kept = []
    for word in reversed(previous.split()[-PREVIOUS_TOKENS:]):
        if count(" " + " ".join([word] + kept)) > PREVIOUS_TOKENS:
            break
        kept.insert(0, word)
    tail = " ".join(kept)
    head = glossary(words, count, PROMPT_TOKENS - (count(" " + tail) if tail else 0))
    return " ".join(part for part in (head, tail) if part) or None


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
            initial = prompt(asked.get("words") or [], asked.get("previous") or "", count)
            segments, _ = model.transcribe(samples, language=asked["language"], initial_prompt=initial, beam_size=5, vad_filter=VAD)
            # faster-whisper writes the segments of each 30 s window once the window is decoded.
            seconds = max(len(samples), 1) / 16000
            texts = []
            for segment in segments:
                texts.append(segment.text.strip())
                say({"progress": round(min(1.0, segment.end / seconds), 3)})
            say({"text": " ".join(texts).strip()})
        except Exception as error:  # one bad request is answered, and the next one is read
            say({"error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
