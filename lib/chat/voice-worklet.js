// The Leader's dictation records through this AudioWorklet: it hands the page the microphone's
// samples, at the page's AudioContext rate, in blocks of about 100 ms. The page keeps them, levels
// them and cuts them at pauses (pauseCut in panels.mjs). Its output is silence.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(Math.round(sampleRate / 10));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    for (let at = 0; at < channel.length; ) {
      const taken = Math.min(channel.length - at, this.block.length - this.filled);
      this.block.set(channel.subarray(at, at + taken), this.filled);
      this.filled += taken;
      at += taken;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block);
        this.block = new Float32Array(this.block.length);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("ovai-recorder", Recorder);
