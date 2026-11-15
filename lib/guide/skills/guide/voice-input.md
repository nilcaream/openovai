# Voice input

A microphone button on the Leader's panel turns speech into text on this machine. The text lands
in the message box, where the person reads it, edits it and presses Enter as for anything typed.

## Turning it on and off
- It is off until the person asks the Leader for it. The Leader sets `voice.on` in `openovai.json`
  with its `settings` tool. Asking again turns it off the same way.
- The language is `voice.language`, English (`en`) unless the person asks for another. Any language
  Whisper knows works, by its code: `de`, `fr`, `pl`, `ja` and so on. The Leader sets it on request.
- While it is off there is no button.

## What turning it on installs, the first time
- Speech is turned into text by faster-whisper with the Whisper large-v3-turbo model, running on
  the CPU. Nothing goes to a cloud service and no model is asked to rewrite the text.
- The server installs it in the background as soon as the setting is on. The button stays faint
  while it does, and its tooltip says what it is at.
  - Its own Python, CPython 3.13 from python-build-standalone, about 30 MB to download, checked
    against the sha256 ovai ships. The machine's Python is never used, so none needs to be there.
  - In that Python, exactly the packages `lib/voice/requirements.txt` pins, about 400 MB, from
    PyPI only, as prebuilt wheels: nothing is resolved and no package runs code while it installs.
  - The model, 1.6 GB, from one pinned revision on Hugging Face. Every file is checked against the
    sha256 ovai ships before it is kept.
- Where: `~/.local/share/openovai/voice/` (`$XDG_DATA_HOME/openovai/voice/` when that is set), beside
  ovai's own Node.js and Claude Code. Every instance on the machine shares it. The last install's
  log is `install.log` there.
- It runs on Linux (x86_64 and arm64) and macOS (Apple silicon and Intel), and needs `tar` to
  unpack its Python.
- When the install fails, the button turns amber and its tooltip says why. A click on it tries
  again.

## Using it
- Click the button and speak. Click again to stop. The text appears at the cursor in a few
  seconds. Esc while recording drops the recording. A recording stops by itself at 2 minutes.
- The box says what is happening: "Listening… 0:07" in red with a running clock while it
  records, then "Turning speech into text…" until the text lands. Anything that went wrong is
  said there too.
- A recording with no sound in it, as from a muted microphone, is not turned into text: Whisper
  makes up words for silence. The panel says that no sound was heard.
- The browser asks once whether the page may use the microphone. Browsers allow a microphone only
  on a secure page, and the page's own address, `http://127.0.0.1:<port>` or
  `http://localhost:<port>`, is one. Through an SSH tunnel the microphone is the one at the
  browser, and the speech is turned into text on the machine ovai runs on.
- A line sent after dictating, edited or not, reaches the Leader marked as voice
  (`<user voice="true">`), so the Leader reads it as transcribed speech: it may hold sound-alike
  words.
- The team's names, the project directories and ovai's own words are given to Whisper as a glossary,
  which helps it spell them.

## What it costs
- Measured on an 8-core laptop CPU (i7-11850H): about 4 s of waiting after 15 s of speech, with
  most cores busy meanwhile, and about 2.6 GB of memory while the model is loaded.
- The model is loaded at the first click, while the person speaks, and unloaded after 10 minutes
  with no recording.

## Removing it
- Turning it off stops the speech process and leaves the install where it is, so turning it on
  again is instant. To free the space, turn it off and delete `~/.local/share/openovai/voice/`.

## What it does not do
- No button on a Worker's panel: dictation is for the Leader.
- No clean-up of the text by a model: what Whisper heard is what lands in the box.
- No dictation on a page reached over plain http by another name than 127.0.0.1 or localhost,
  which the browser refuses a microphone and ovai's server does not answer anyway.
