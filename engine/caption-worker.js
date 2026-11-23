"use strict";
// Private captions in the browser: the sherpa-onnx speech engine (Apache-2.0, built for the web WITHOUT its
// text-to-speech part) runs here, in a background worker, so the screen never stutters. The microphone sound
// arrives from the page at the sound card's rate (the engine converts it to 16,000 samples a second); nothing is sent anywhere. The speech model (71 MB) is downloaded
// once, checked against its SHA-256, and kept in the browser's storage for offline use.

const HF = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main/";
const FILES = [
  { name: "encoder.onnx", url: HF + "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx", size: 71083163, sha: "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1" },
  { name: "decoder.onnx", url: HF + "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx", size: 1307236, sha: "98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02" },
  { name: "joiner.onnx", url: HF + "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx", size: 259335, sha: "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297" },
  { name: "tokens.txt", url: HF + "tokens.txt", size: 5048, sha: "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb" },
  // Punctuation and capitals (Edge-Punct-Casing, Apache-2.0), shipped with the app.
  { name: "punct.onnx", url: "punct/model.int8.onnx", size: 7490500, sha: "9d611f445fe4a46186080fe161be6059d87d72eb88d3a8cb00c1a06e83a6067e" },
  { name: "asr-bpe.vocab", url: "bpe.vocab", size: 12590, sha: "f191a4935f668fa8cd8e607bcd378404f948321cd3134a5ea13d324ba921673d" },
  { name: "bpe.vocab", url: "punct/bpe.vocab", size: 149430, sha: "e118b7ad88c54db562517df49e1cffd4836d166c34fb190fd311d7f34eb238f5" },
];
const CACHE = "ohs-models-1";

let runtimeReady;
const runtime = new Promise(res => { runtimeReady = res; });
self.Module = { locateFile: path => path, onRuntimeInitialized: () => runtimeReady() };
importScripts("sherpa-onnx-asr.js", "sherpa-onnx-wasm-main-asr.js");

let recognizer = null, stream = null, punct = 0, loading = null, lastPartial = "";

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");

async function fetchChecked(f, onBytes) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = cache && await cache.match(f.url);
  if (hit) { const buf = await hit.arrayBuffer(); onBytes(f.size); return buf; }
  const res = await fetch(f.url);
  if (!res.ok) throw new Error("download " + res.status);
  const reader = res.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes(Math.min(got, f.size));
  }
  const buf = await new Blob(parts).arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", buf)) !== f.sha) throw new Error("checksum " + f.name);
  if (cache) await cache.put(f.url, new Response(buf)).catch(() => {});
  return buf;
}

function makePunctuation() {
  // SherpaOnnxOnlinePunctuationConfig = { cnn_bilstm*, bpe_vocab*, int32 num_threads, int32 debug, provider* }
  const str = s => { const n = Module.lengthBytesUTF8(s) + 1; const p = Module._malloc(n); Module.stringToUTF8(s, p, n); return p; };
  const cfg = Module._malloc(20);
  Module.setValue(cfg, str("/punct.onnx"), "i32");
  Module.setValue(cfg + 4, str("/bpe.vocab"), "i32");
  Module.setValue(cfg + 8, 1, "i32");
  Module.setValue(cfg + 12, 0, "i32");
  Module.setValue(cfg + 16, str("cpu"), "i32");
  return Module._SherpaOnnxCreateOnlinePunctuation(cfg);
}

function load() {
  if (loading) return loading;
  loading = (async () => {
    await runtime;
    const total = FILES.reduce((a, f) => a + f.size, 0);
    const done = new Array(FILES.length).fill(0);
    let lastPct = -1;
    const report = () => { const pct = Math.floor(100 * done.reduce((a, b) => a + b, 0) / total); if (pct !== lastPct) { lastPct = pct; postMessage({ type: "progress", pct }); } };
    const bufs = await Promise.all(FILES.map((f, i) => fetchChecked(f, n => { done[i] = n; report(); })));
    FILES.forEach((f, i) => Module.FS.writeFile("/" + f.name, new Uint8Array(bufs[i])));
    makeRecognizer();
    try { punct = makePunctuation(); } catch { punct = 0; }
    postMessage({ type: "ready" });
  })().catch(e => { loading = null; postMessage({ type: "error", code: String(e.message || e).startsWith("download") ? "download-failed" : "engine-load" }); throw e; });
  return loading;
}

// Names and words the user listed (Settings), and how sure a word must be before it is shown without a mark.
let wordList = "", unsureBelow = 0.3;
function makeRecognizer() {
  if (recognizer) { try { if (stream) stream.free(); } catch { } try { recognizer.free(); } catch { } stream = null; }
  const hot = wordList.split(/[,\n]/).map(w => w.trim().toUpperCase().replace(/[^A-Z' ]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  Module.FS.writeFile("/hotwords.txt", hot.join("\n") + "\n");
  recognizer = createOnlineRecognizer(Module, {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: "/encoder.onnx", decoder: "/decoder.onnx", joiner: "/joiner.onnx" },
      paraformer: { encoder: "", decoder: "" }, zipformer2Ctc: { model: "" }, nemoCtc: { model: "" }, toneCtc: { model: "" },
      tokens: "/tokens.txt", numThreads: 1, provider: "cpu", debug: 0, modelType: "zipformer2", modelingUnit: "bpe", bpeVocab: "/asr-bpe.vocab",
    },
    // beam search lets the word list work (tested 20 Nov: same accuracy as greedy search without a list)
    decodingMethod: "modified_beam_search", maxActivePaths: 4, enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.0, rule3MinUtteranceLength: 20,
    hotwordsFile: hot.length ? "/hotwords.txt" : "", hotwordsScore: 2.0, ctcFstDecoderConfig: { graph: "", maxActive: 3000 }, ruleFsts: "", ruleFars: "",
  });
}
// Which words to mark as unsure: a word's confidence is its least sure piece (below 0.3 marks about two thirds of
// the wrong words and one right word in ten, tested 20 Nov on noisy speech).
function unsureWords(r) {
  const toks = r.tokens || [], lp = r.ys_probs || r.ysProbs || [];
  if (!unsureBelow || !lp.length || lp.length !== toks.length) return [];
  const out = []; let word = -1, worst = 0, started = false;
  const close = () => { if (started && Math.exp(worst) < unsureBelow) out.push(word); };
  toks.forEach((t, i) => {
    if (t.startsWith(" ") || t.startsWith("\u2581")) {
      close();
      if (!t.trim()) { started = false; return; }
      word++; worst = lp[i]; started = true;
    } else if (started) worst = Math.min(worst, lp[i]);
    else { word++; worst = lp[i]; started = true; }
  });
  close();
  return out;
}

function tidy(raw, finished) {
  const lower = raw.trim().toLowerCase();
  if (!lower) return "";
  if (finished && punct) {
    try {
      const n = Module.lengthBytesUTF8(lower) + 1, p = Module._malloc(n);
      Module.stringToUTF8(lower, p, n);
      const out = Module._SherpaOnnxOnlinePunctuationAddPunct(punct, p);
      Module._free(p);
      if (out) { const s = Module.UTF8ToString(out); Module._SherpaOnnxOnlinePunctuationFreeText(out); return s; }
    } catch { /* fall through to simple tidying */ }
  }
  return lower.replace(/\bi\b/g, "I").replace(/^./, c => c.toUpperCase());
}

function feed(samples, rate) {
  if (!recognizer) return;
  if (!stream) stream = recognizer.createStream();
  stream.acceptWaveform(rate || 16000, samples); // the engine resamples to 16 kHz itself
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const res = recognizer.getResult(stream), text = res.text;
  if (recognizer.isEndpoint(stream)) {
    if (text.trim()) postMessage({ type: "final", text: tidy(text, true), unsure: unsureWords(res) });
    recognizer.reset(stream); lastPartial = "";
    postMessage({ type: "partial", text: "" });
  } else if (text !== lastPartial) {
    lastPartial = text;
    postMessage({ type: "partial", text: tidy(text, false) });
  }
}

function finish() {
  if (!recognizer || !stream) return;
  const res = recognizer.getResult(stream), text = res.text;
  if (text.trim()) postMessage({ type: "final", text: tidy(text, true), unsure: unsureWords(res) });
  recognizer.reset(stream); lastPartial = "";
  postMessage({ type: "partial", text: "" });
}

// A whole recording (already 16 kHz mono): caption it piece by piece and send back timed sentences for subtitles.
async function captionFile(samples) {
  try { await load(); } catch { postMessage({ type: "fileError", code: "engine-load" }); return; }
  const st = recognizer.createStream();
  const step = 8000; // half a second
  let segStart = 0, n = 0;
  const emit = end => { const t = recognizer.getResult(st).text; if (t.trim()) postMessage({ type: "fileSegment", start: segStart / 16000, end: end / 16000, text: tidy(t, true) }); };
  for (let i = 0; i < samples.length; i += step) {
    const end = Math.min(i + step, samples.length);
    st.acceptWaveform(16000, samples.subarray(i, end));
    while (recognizer.isReady(st)) recognizer.decode(st);
    if (recognizer.isEndpoint(st)) { emit(end); recognizer.reset(st); segStart = end; }
    if (++n % 20 === 0) postMessage({ type: "fileProgress", pct: Math.floor(100 * end / samples.length) });
  }
  st.acceptWaveform(16000, new Float32Array(8000));
  st.inputFinished();
  while (recognizer.isReady(st)) recognizer.decode(st);
  emit(samples.length);
  st.free();
  postMessage({ type: "fileDone" });
}

onmessage = e => {
  const m = e.data;
  if (m.type === "load") load().catch(() => {});
  else if (m.type === "audio") feed(m.samples, m.rate);
  else if (m.type === "stop") finish();
  else if (m.type === "file") captionFile(m.samples);
  else if (m.type === "words") {
    unsureBelow = m.unsure;
    if (m.words !== wordList) { wordList = m.words; if (recognizer) makeRecognizer(); }
  }
};
