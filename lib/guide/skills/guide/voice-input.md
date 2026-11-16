# Voice input

A microphone button on the Leader's panel turns speech into text on this machine. The text lands
in the message box, where the person reads it, edits it and presses Enter as for anything typed.

## Turning it on and off
- It is off until the person asks the Leader for it. The Leader sets `voice.on` in `openovai.json`
  with its `settings` tool. Asking again turns it off the same way.
- The language is `voice.language`, English (`en`) unless the person asks for another. Any language
  Whisper knows works, by its code: `de`, `fr`, `pl`, `ja` and so on. The Leader sets it on request.
- While it is off the microphone button is still in the Leader's box, greyed, and its hover says
  "Voice input is off: ask the Leader to turn it on". A click on it does nothing.

## What the first click installs
- Speech is turned into text by faster-whisper with the Whisper large-v3-turbo model, running on
  the CPU. Nothing goes to a cloud service and no model is asked to rewrite the text.
- Turning the setting on installs nothing: it shows the button. The person's first click on it, or
  Tab in the Leader's box, starts the install, and the server does it in the background. From
  that click until it is done the button is gone and the pill at the left of the Leader's pill row
  says which of four steps the install is at, and the percent of the last:
  - "Voice 1/4: runtime...": its own Python, CPython 3.13 from python-build-standalone, about
    30 MB to download, checked against the sha256 ovai ships. The machine's Python is never used,
    so none needs to be there.
  - "Voice 2/4: dependencies...": in that Python, exactly the packages
    `lib/voice/requirements.txt` pins, about 480 MB, from PyPI only, as prebuilt wheels: nothing
    is resolved and no package runs code while it installs. Every wheel is checked against the
    sha256 the file gives for it, and one that does not match stops the install.
  - "Voice 3/4: model files..." and "Voice 4/4: model 42%": the model, 1.6 GB, from one pinned
    revision on Hugging Face, its small files first. Every file is checked against the sha256 ovai
    ships before it is kept.
- Then the pill clears and the button is back. When it is already installed on this machine, by
  any instance, there is no install step: the button dictates at the first click.
- Where: `~/.local/share/openovai/voice/` (`$XDG_DATA_HOME/openovai/voice/` when that is set), beside
  ovai's own Node.js and Claude Code. Every instance on the machine shares it. The last install's
  log is `install.log` there.
- It runs on Linux (x86_64 and arm64) and macOS (Apple silicon on macOS 14 or later, Intel on
  macOS 11 or later: the oldest its packages are built for), and needs `tar` to unpack its Python.
- When the install fails, the pill turns amber and says "Voice failed, click to retry", with the
  reason and the log's path in its hover, and the button stays away. A click on the pill, or Tab in the Leader's box, tries again.

## Using it
- Click the button, or press Tab in the Leader's box, and speak. Click or press Tab again to stop.
  The text appears at the cursor in a few seconds, however long the recording. Esc while
  recording stops it (see the cancel below). A recording has no length limit. Tab does this only in the
  Leader's box and only while voice input is on; everywhere else it moves the focus as always.
- The speech is turned into text while the person goes on speaking: the recording is cut at a
  pause once it is 20 seconds long (at 30 seconds, without a pause, at its quietest moment), and
  each part is turned into text on its own, told the text of the parts before it so it reads as
  one. After Stop only the last part is left, and the parts' text lands in the box all at once.
- While it records and while it turns speech into text, the box is greyed and takes no typing;
  the text lands where the cursor was, and the cursor ends after it.
- While it turns speech into text, the microphone button is a cross: a click on it, or Esc,
  stops it. The speech process is stopped, so the work does not go on using the CPU; the text of
  the parts already done lands in the box ("Dictation stopped early"), or nothing when none was
  ("Dictation cancelled"); the box takes typing again at once. Esc while recording does the same:
  it drops the audio since the last cut and the part being worked on, and the parts already done
  land in the box. The next recording loads the model again, a
  few seconds that pass while the person speaks. Tab does not cancel.
- A pill at the left of the Leader's pill row says what is happening: "Listening... 0:07" in red
  with a running clock, then "Turning speech into text…", its ground filling from the left as the
  work left after Stop goes. The fill moves steadily at a speed guessed on the slow side, and it
  stops short of the end while work is left. When the text comes the rest is swept full in about
  a tenth of a second, and the text lands as the sweep ends. After, for a few seconds, what came of it when no text did, with the
  reason in its hover: "Microphone appears muted", "No speech heard", "Not turned into text", "No
  microphone", "Dictation cancelled", "Dictation stopped early".
- A recording with no sound in it, as from a muted microphone, is not turned into text: Whisper
  makes up words for silence.
- Silence and noise inside a recording are cut out by a voice-activity filter before Whisper hears
  them. On an Intel Mac there is no filter (its onnxruntime has no build there), so noise alone
  can come back as made-up text.
- The browser asks once whether the page may use the microphone. Browsers allow a microphone only
  on a secure page, and the page's own address, `http://127.0.0.1:<port>` or
  `http://localhost:<port>`, is one. Through an SSH tunnel the microphone is the one at the
  browser, and the speech is turned into text on the machine ovai runs on.
- A line sent after dictating, edited or not, reaches the Leader marked as voice
  (`<user voice="true">`), so the Leader reads it as transcribed speech: it may hold sound-alike
  words.
- Whisper is given a glossary, built anew for each recording without any AI call: the team's names,
  the project directories and ovai's own words, then the unusual words (names, hyphenated or dotted
  words, words in backticks) of the last few lines on the Leader's panel, the desk titles and the
  Leader's status. It helps Whisper spell them. Whisper takes about 220 tokens of it, roughly 60
  such words; what does not fit is left out, the oldest lines first. From the second part of a
  recording on, the last words of the parts before it (up to 96 tokens) take their room first.

## What it costs
- Measured on an 8-core laptop CPU (i7-11850H): about 4 s of waiting after 15 s of speech, with
  most cores busy meanwhile, and about 2.6 GB of memory while the model is loaded.
- A longer dictation is mostly turned into text while it is spoken, so the wait after Stop stays
  about the same. On the same laptop: 3.5 s after 90 s of speech and 3.5–6.9 s after 3 minutes;
  in one piece the same recordings took 18–22 s and 45–114 s, the more the busier the machine.
  Meanwhile the speech process works on each part as it is cut, with the cores busy in bursts.
- The model is loaded at the first click, while the person speaks, and unloaded after 10 minutes
  with no recording.

## Removing it
- Turning it off stops the speech process and leaves the install where it is, so turning it on
  again is instant. To free the space, turn it off and delete `~/.local/share/openovai/voice/`.
- An update that changes what voice input installs installs it anew beside the old one. A server
  start removes the old install once no instance of the user uses it any more ("Old runtimes" in
  setup-and-update.md).

## What it does not do
- No button on a Worker's panel: dictation is for the Leader.
- No clean-up of the text by a model: what Whisper heard is what lands in the box.
- No dictation on a page reached over plain http by another name than 127.0.0.1 or localhost,
  which the browser refuses a microphone and ovai's server does not answer anyway.
