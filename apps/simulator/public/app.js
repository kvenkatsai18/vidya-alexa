// Alexa+ experience simulator: device UI, voice I/O, MCP Apps host bridge and developer panel.

const $ = (id) => document.getElementById(id);
const screen = $("screen");
const state = {
  session: null,
  clockOffset: 0,
  speak: true,
  pendingElicit: null,
  traffic: 0,
  card: null, // { iframe, input, result, toolName, initialized }
};

const SUGGESTIONS = [
  { text: "Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days." },
  { text: "Use the sample biology notes", sample: true },
  { text: "Explain meiosis" },
  { text: "Explain it differently" },
  { text: "Quiz me" },
  { text: "Let me teach it back" },
  { text: "What's my study plan?" },
  { text: "Help me focus for 25 minutes" },
  { text: "Tell Leo a bedtime story about why stealing is wrong. He's 6 and loves dinosaurs." },
];

// ------------------------------------------------------------------ boot

async function boot() {
  renderChips();
  tickClock();
  setInterval(tickClock, 1000);
  syncServerClock();
  setInterval(syncServerClock, 30_000);

  try {
    const cfg = await (await fetch("/api/config")).json();
    voiceCfg.engine = cfg.tts?.engine ?? "browser";
    voiceCfg.serverVoices = cfg.tts?.voices ?? [];
    voiceCfg.defaultVoice = cfg.tts?.default ?? "Matthew";
    renderVoiceOptions();
    $("fSkill").textContent = cfg.skills.map((s) => s.name).join(", ");
    $("fSkill").title = "Loaded at runtime from skills/*/SKILL.md";
    $("fSkill").classList.add("okv");
  } catch {}

  const res = await fetch("/api/sessions", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    $("fServer").textContent = "Not connected";
    setCaption(data.error ?? "Couldn't connect to the Study Buddy MCP server.");
    return;
  }
  state.session = data;
  $("fServer").textContent = `${data.server?.title ?? data.server?.name} ${data.server?.version ?? ""}`;
  $("fServer").classList.add("okv");
  $("fProto").textContent = data.protocolVersion;
  $("fSession").textContent = data.mcpSessionId ? `${data.mcpSessionId.slice(0, 8)}…` : "–";
  $("fSession").title = data.mcpSessionId ?? "";
  $("fAgent").textContent = data.agent;
  $("fAgent").title = data.agent;
  $("addon").hidden = false;

  const es = new EventSource(`/api/sessions/${data.id}/events`);
  es.onmessage = (ev) => onEvent(JSON.parse(ev.data));
  es.onerror = () => addNote("Event stream interrupted. Reload if it doesn't recover.");
}

// ------------------------------------------------------------------ server events

function onEvent(e) {
  switch (e.type) {
    case "trace":
      addTrace(e.frame);
      break;
    case "status":
      if (e.state === "thinking") setState("thinking");
      else if (screen.dataset.state === "thinking") setState("idle");
      break;
    case "user":
      $("capUser").classList.remove("interim");
      $("capUser").textContent = e.text;
      $("capAssistant").textContent = "";
      break;
    case "card":
      state.lastCardKind = e.result?.structuredContent?.kind;
      showCard(e);
      break;
    case "speech":
      say(e.text);
      break;
    case "elicit":
      openSheet(e);
      break;
    case "audio":
      state.pendingAudio = [...(state.pendingAudio ?? []), ...e.items];
      break;
    case "voice_ready":
      addNote("Parent story voice created (notifications/elicitation/complete).");
      break;
    case "elicit_done":
      closeSheet(e.id);
      break;
    case "error":
      addNote(`Agent error: ${e.message}`, true);
      break;
    case "learner":
      $("learner").hidden = false;
      $("learner").textContent = e.name;
      $("learner").title = e.level ?? "";
      break;
    case "sampling":
      addNote(`Sampling answered by the client's model (${e.purpose}, ${(e.ms / 1000).toFixed(1)}s)`);
      break;
  }
}

async function sendTurn(text, source = "text") {
  if (!state.session || !text.trim()) return;
  stopSpeaking();
  state.pendingAudio = [];
  state.lastInput = source;
  armFiller();
  await fetch(`/api/sessions/${state.session.id}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source }),
  });
}

// ------------------------------------------------------------------ device state, captions, speech

function setState(s) {
  screen.dataset.state = s;
}

function setCaption(text) {
  $("capAssistant").textContent = text;
}

// ------------------------------------------------------------------ voice: sound like someone talking, not a screen reader

const voiceCfg = { engine: "browser", serverVoices: [], choice: null };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// macOS/Chrome novelty and legacy formant voices sound robotic; never pick them.
const ROBOTIC = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/;
function rankVoice(v) {
  let r = 0;
  if (/\(Natural\)|Neural/i.test(v.name)) r += 100; // Edge online neural voices
  if (/Premium/i.test(v.name)) r += 95;
  if (/Enhanced/i.test(v.name)) r += 80;
  if (/^Google/.test(v.name)) r += 50;
  if (/^(Samantha|Daniel|Ava|Evan|Zoe|Nathan|Allison|Tom|Susan|Rishi|Moira|Karen|Tessa)\b/.test(v.name)) r += 35;
  if (v.lang === "en-US") r += 5;
  return r;
}
function browserVoices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en") && !ROBOTIC.test(v.name)).sort((a, b) => rankVoice(b) - rankVoice(a));
}

function renderVoiceOptions() {
  const sel = $("voiceSelect");
  const saved = store.get("sb.voice");
  sel.innerHTML = "";
  const opts = voiceCfg.engine === "polly"
    ? voiceCfg.serverVoices.map((v) => ({ value: `polly:${v.id}`, label: `${v.label}, natural` }))
    : browserVoices().map((v) => ({ value: `browser:${v.name}`, label: `${v.name.replace(/\s*\(English.*\)$/, "")} (${v.lang})` }));
  for (const o of opts) sel.add(new Option(o.label, o.value));
  const fallback = voiceCfg.engine === "polly" ? `polly:${voiceCfg.defaultVoice}` : opts[0]?.value;
  sel.value = opts.some((o) => o.value === saved) ? saved : fallback ?? "";
  voiceCfg.choice = sel.value;
  const best = browserVoices()[0];
  $("voiceNote").textContent =
    voiceCfg.engine === "polly"
      ? "Amazon Polly generative voice."
      : best && rankVoice(best) >= 80
        ? "Using a high-quality system voice."
        : "Browser voices sound robotic. For a natural voice, run with BUDDY_TTS=polly (AWS), or install a Premium voice in macOS Settings > Accessibility > Spoken Content.";
}
$("voiceSelect").addEventListener("change", (e) => {
  voiceCfg.choice = e.target.value;
  store.set("sb.voice", e.target.value);
});
$("voiceTest").addEventListener("click", () => say("Hey! This is how I'll sound when we study together. Pretty good, right?"));
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = renderVoiceOptions;

/** Rewrite card-style text into something that sounds natural out loud. */
function forSpeech(text) {
  return text
    .replace(/\s*\(([^)]{1,60})\)/g, ", $1,")
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/\s&\s/g, " and ")
    .replace(/:\s/g, ", ")
    .replace(/;\s/g, ". ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.?!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
function sentences(text) {
  return (text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
}
/** Small first chunk so speech starts fast, then ~400-char chunks. */
function chunks(text) {
  const out = [];
  let cur = "";
  for (const sn of sentences(text)) {
    if (!out.length && !cur) {
      out.push(sn);
      continue;
    }
    if ((cur + " " + sn).length > 400 && cur) {
      out.push(cur);
      cur = sn;
    } else cur = cur ? `${cur} ${sn}` : sn;
  }
  if (cur) out.push(cur);
  return out;
}

let speakToken = 0;
let currentAudio = null;
let fillerTimer = null;
let lastSpoken = "";

async function say(text, opts = {}) {
  clearTimeout(fillerTimer);
  if (!opts.filler) setCaption(text);
  if (!state.speak) {
    if (screen.dataset.state !== "thinking") setState("idle");
    return;
  }
  stopSpeaking();
  const token = ++speakToken;
  const spoken = forSpeech(text);
  lastSpoken = opts.filler ? lastSpoken : spoken;
  const story = state.lastCardKind === "story" && !opts.filler;
  setState("speaking");
  try {
    if (voiceCfg.engine === "polly" && voiceCfg.choice?.startsWith("polly:")) await speakPolly(spoken, token, story);
    else await speakBrowser(spoken, token, story);
  } catch (err) {
    console.warn("speech failed", err);
  }
  if (token !== speakToken) return;
  if (!opts.filler && state.pendingAudio?.length) return playPendingAudio(token);
  if (screen.dataset.state === "speaking") setState("idle");
  if (!opts.filler) afterSpeech(spoken);
}

/** Parent-voice recordings (stories, goodnight messages) play after the honest spoken intro. */
async function playPendingAudio(token) {
  const items = state.pendingAudio.splice(0);
  for (const item of items) {
    if (token !== speakToken) return;
    if (item.label) setCaption(`${item.label}: ${item.fallbackText}`);
    let ok = false;
    try {
      const r = await fetch(item.url);
      if (r.ok) {
        const url = URL.createObjectURL(await r.blob());
        ok = await new Promise((resolve) => {
          currentAudio = new Audio(url);
          currentAudio.onended = () => resolve(true);
          currentAudio.onerror = () => resolve(false);
          currentAudio.play().catch(() => resolve(false));
        });
        URL.revokeObjectURL(url);
      } else if (r.status === 501) {
        addNote("Voice cloning isn't configured yet (no ELEVENLABS_API_KEY), so this plays in the standard voice.");
      }
    } catch {}
    if (!ok && token === speakToken) {
      state.lastCardKind = "story";
      const myToken = ++speakToken;
      const speak = voiceCfg.engine === "polly" && voiceCfg.choice?.startsWith("polly:") ? speakPolly : speakBrowser;
      await speak(forSpeech(item.fallbackText), myToken, true);
      if (myToken !== speakToken) return;
      token = myToken;
    }
  }
  if (screen.dataset.state === "speaking") setState("idle");
}

function speakBrowser(text, token, story) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  const name = voiceCfg.choice?.replace(/^browser:/, "");
  const voice = browserVoices().find((v) => v.name === name) ?? browserVoices()[0];
  const parts = sentences(text);
  return new Promise((resolve) => {
    const next = (i) => {
      if (token !== speakToken || i >= parts.length) return resolve();
      const u = new SpeechSynthesisUtterance(parts[i]);
      if (voice) u.voice = voice;
      u.rate = story ? 0.88 : 0.98;
      // A touch of variation stops it sounding like one long monotone read-out.
      u.pitch = /\?$/.test(parts[i]) ? 1.06 : 1;
      u.onend = u.onerror = () => setTimeout(() => next(i + 1), story ? 320 : /[?!]$/.test(parts[i]) ? 220 : 140);
      speechSynthesis.speak(u);
    };
    next(0);
  });
}

async function speakPolly(text, token, story) {
  const voice = voiceCfg.choice.replace(/^polly:/, "");
  const fetchAudio = (t) =>
    fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, voice, style: story ? "story" : "talk" }) }).then((r) => {
      if (!r.ok) throw new Error("tts failed");
      return r.blob();
    });
  const parts = chunks(text);
  let pending = fetchAudio(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    const blob = await pending;
    if (token !== speakToken) return;
    if (i + 1 < parts.length) pending = fetchAudio(parts[i + 1]); // prefetch while this plays
    const url = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      currentAudio = new Audio(url);
      currentAudio.onended = currentAudio.onerror = resolve;
      currentAudio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
  }
}

function stopSpeaking() {
  speakToken++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

/** Conversation, not commands: after a question, keep listening for the answer (like Alexa follow-up mode). */
function afterSpeech(spoken) {
  const asked = /\?\s*$/.test(spoken) || state.pendingElicit?.isConfirm;
  if ($("handsFree").checked && state.lastInput === "voice" && asked && rec && !listening) {
    setTimeout(() => startListening({ auto: true }), 250);
  }
}

/** If the answer takes a moment, say something a person would say instead of going silent. */
const FILLERS = ["Hmm, one sec.", "Let me think.", "Okay, give me a second.", "Good one. Let me see."];
function armFiller() {
  clearTimeout(fillerTimer);
  if (!state.speak) return;
  fillerTimer = setTimeout(() => say(FILLERS[Math.floor(Math.random() * FILLERS.length)], { filler: true }), 1400);
}

/** Soft two-note chime when the mic opens, like a smart speaker. */
let audioCtx;
function chime(up = true) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [up ? 660 : 880, up ? 990 : 660].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.07, t + i * 0.09 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.18);
    });
  } catch {}
}

// ------------------------------------------------------------------ MCP Apps host bridge

const HOST_INFO = { name: "alexa-plus-simulator", version: "0.1.0" };

function showCard(e) {
  $("ambient").hidden = true;
  const wrap = $("cardwrap");
  wrap.hidden = false;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("title", `${e.toolName} card`);
  iframe.className = "entering";
  iframe.srcdoc = e.html;
  const card = { iframe, input: e.input, result: e.result, toolName: e.toolName, uri: e.uri, initialized: false };

  const old = state.card;
  state.card = card;
  wrap.appendChild(iframe);
  if (old) {
    teardown(old);
    old.iframe.remove();
  }
  wrap.scrollTop = 0;
}

function teardown(card) {
  try {
    card.iframe.contentWindow?.postMessage({ jsonrpc: "2.0", id: `teardown-${Date.now()}`, method: "ui/resource-teardown", params: {} }, "*");
  } catch {}
}

window.addEventListener("message", async (ev) => {
  const card = state.card;
  if (!card || ev.source !== card.iframe.contentWindow) return;
  const m = ev.data;
  if (!m || m.jsonrpc !== "2.0") return;
  const reply = (result) => card.iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  const replyError = (message) => card.iframe.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } }, "*");
  const notify = (method, params) => card.iframe.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");

  switch (m.method) {
    case "ui/initialize":
      reply({
        protocolVersion: m.params?.protocolVersion ?? "2026-01-26",
        hostInfo: HOST_INFO,
        hostCapabilities: { message: { text: {} }, openLinks: {}, serverTools: {}, logging: {} },
        hostContext: {
          theme: "dark",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          platform: "web",
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          deviceCapabilities: { touch: true, hover: false },
          containerDimensions: { maxHeight: $("cardwrap").clientHeight },
          toolInfo: { tool: { name: card.toolName } },
        },
      });
      break;
    case "ui/notifications/initialized":
      if (card.initialized) break;
      card.initialized = true;
      notify("ui/notifications/tool-input", { arguments: card.input ?? {} });
      notify("ui/notifications/tool-result", card.result);
      requestAnimationFrame(() => card.iframe.classList.remove("entering"));
      break;
    case "ui/notifications/size-changed":
      if (m.params?.height) card.iframe.style.height = `${Math.ceil(m.params.height)}px`;
      break;
    case "ui/message": {
      const text = (m.params?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      reply({});
      if (state.pendingElicit?.isConfirm && /^(yes|no)/i.test(text)) {
        answerElicit(/^yes/i.test(text) ? "accept" : "decline");
      } else {
        sendTurn(text, "tap");
      }
      break;
    }
    case "tools/call": {
      try {
        const r = await fetch(`/api/sessions/${state.session.id}/tool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: m.params?.name, arguments: m.params?.arguments ?? {} }),
        });
        reply(await r.json());
      } catch (err) {
        replyError(String(err));
      }
      break;
    }
    case "ui/open-link":
      if (m.params?.url && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(m.params.url)) window.open(m.params.url, "_blank", "noopener");
      reply({});
      break;
    case "notifications/message":
      console.log("[card]", m.params);
      break;
    default:
      if (m.id !== undefined && m.method) replyError(`Unsupported: ${m.method}`);
  }
});

// ------------------------------------------------------------------ elicitation sheet

function openSheet(e) {
  state.pendingElicit = e;
  const props = Object.entries(e.schema?.properties ?? {});
  const isConfirm = !!e.url || (props.length === 1 && props[0][1].type === "boolean");
  e.isConfirm = isConfirm;
  const form = $("sheetForm");
  form.innerHTML = "";
  form.hidden = isConfirm;
  if (e.url) {
    $("sheetTitle").textContent = "Open a secure page";
    $("sheetYes").textContent = "Open recording page";
    $("sheetHint").textContent = "It opens in a new tab, like a page on your phone.";
  } else if (isConfirm) {
    $("sheetTitle").textContent = "Please confirm";
    $("sheetYes").textContent = props[0][1].title ?? "Confirm";
    $("sheetHint").textContent = "Or just say “yes” or “no”.";
  } else {
    $("sheetTitle").textContent = "Quick setup";
    $("sheetYes").textContent = "Save";
    $("sheetHint").textContent = "Or close this and just tell me out loud.";
    for (const [key, p] of props) {
      const label = document.createElement("label");
      if (/interest|description/.test(key) || props.length % 2 === 1 && key === props[props.length - 1][0]) label.className = "wide";
      const input = document.createElement("input");
      input.name = key;
      input.type = p.type === "integer" || p.type === "number" ? "number" : p.format === "date" ? "date" : p.type === "boolean" ? "checkbox" : "text";
      if (p.minimum !== undefined) input.min = p.minimum;
      if (p.maximum !== undefined) input.max = p.maximum;
      if (e.schema.required?.includes(key)) input.required = true;
      label.append(p.title ?? key, input);
      if (p.description) {
        const small = document.createElement("small");
        small.textContent = p.description;
        label.append(small);
      }
      form.append(label);
    }
  }
  $("sheetMsg").textContent = e.message;
  $("sheet").hidden = false;
  (isConfirm ? $("sheetYes") : form.querySelector("input"))?.focus({ preventScroll: true });
}

function formContent() {
  const out = {};
  for (const input of $("sheetForm").querySelectorAll("input")) {
    if (input.type === "checkbox") out[input.name] = input.checked;
    else if (input.value !== "") out[input.name] = input.type === "number" ? Number(input.value) : input.value;
  }
  return out;
}

function closeSheet(id) {
  if (state.pendingElicit && (!id || state.pendingElicit.id === id)) {
    state.pendingElicit = null;
    $("sheet").hidden = true;
  }
}

async function answerElicit(action) {
  const e = state.pendingElicit;
  if (!e) return;
  let content;
  if (action === "accept" && e.url) window.open(e.url, "_blank", "noopener");
  if (action === "accept") {
    if (e.url) content = undefined;
    else if (e.isConfirm) content = { confirm: true };
    else {
      if (!$("sheetForm").reportValidity()) return;
      content = formContent();
    }
  }
  closeSheet();
  stopSpeaking();
  await fetch(`/api/sessions/${state.session.id}/elicit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: e.id, action, content }),
  });
}
$("sheetYes").onclick = (ev) => {
  ev.preventDefault();
  answerElicit("accept");
};
$("sheetNo").onclick = (ev) => {
  ev.preventDefault();
  answerElicit("decline");
};
$("sheetForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  answerElicit("accept");
});

// ------------------------------------------------------------------ sharing notes (like sharing a document to Alexa from the phone)

async function shareNotes(body) {
  if (!state.session) return;
  $("share").classList.add("busy");
  try {
    const r = await fetch(`/api/sessions/${state.session.id}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) setCaption((await r.json()).error ?? "Couldn't read that file.");
  } finally {
    $("share").classList.remove("busy");
  }
}
$("share").onclick = () => $("file").click();
$("file").addEventListener("change", async () => {
  const f = $("file").files?.[0];
  $("file").value = "";
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) return setCaption("That file is too big. Try a chapter at a time.");
  if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    shareNotes({ title: f.name, pdfBase64: btoa(bin) });
  } else {
    shareNotes({ title: f.name, text: await f.text() });
  }
});

// ------------------------------------------------------------------ input: text, chips, voice

$("talkbar").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("text").value;
  $("text").value = "";
  sendTurn(text, "text");
});

function renderChips() {
  $("chips").innerHTML = "";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.text.length > 48 ? `${s.text.slice(0, 46).replace(/\s\S*$/, "")}…` : s.text;
    b.title = s.text;
    b.onclick = () => (s.sample ? shareNotes({ sample: true }) : sendTurn(s.text, "text"));
    $("chips").appendChild(b);
  }
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;
let finalText = "";

if (!SR) {
  $("micnote").hidden = false;
  $("mic").disabled = true;
} else {
  rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $("capUser").classList.add("interim");
    $("capUser").textContent = (finalText + interim).trim();
  };
  rec.onend = () => {
    listening = false;
    $("mic").classList.remove("live");
    if (finalText.trim()) chime(false);
    if (screen.dataset.state === "listening") setState("idle");
    const text = finalText.trim();
    finalText = "";
    if (!text) return;
    if (state.pendingElicit?.isConfirm && /^(alexa,?\s*)?(yes|yeah|yep|sure|confirm|do it|go ahead|no|nope|cancel)\b/i.test(text)) {
      state.lastInput = "voice";
      answerElicit(/^(alexa,?\s*)?(no|nope|cancel)/i.test(text) ? "decline" : "accept");
      $("capUser").textContent = text;
      return;
    }
    sendTurn(text, "voice");
  };
  rec.onerror = (ev) => {
    if (ev.error !== "no-speech" && ev.error !== "aborted") addNote(`Microphone: ${ev.error}`, true);
  };
}

function startListening(opts = {}) {
  if (!rec || listening) return;
  stopSpeaking();
  chime(true);
  rec.continuous = false;
  finalText = "";
  listening = true;
  $("mic").classList.add("live");
  setState("listening");
  $("capUser").textContent = "";
  try {
    rec.start();
  } catch {}
}
function stopListening() {
  if (rec && listening) rec.stop();
}

$("mic").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startListening();
});
$("mic").addEventListener("pointerup", stopListening);
$("mic").addEventListener("pointerleave", stopListening);

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement === $("text");
  if (e.code === "Space" && !typing && !e.repeat) {
    e.preventDefault();
    startListening();
  }
  if (e.key === "d" && !typing && !e.metaKey && !e.ctrlKey) toggleDev();
  if (e.key === "Escape" && state.pendingElicit) answerElicit("decline");
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement !== $("text")) stopListening();
});

// ------------------------------------------------------------------ clock & demo controls

function now() {
  return new Date(Date.now() + state.clockOffset);
}
function tickClock() {
  const d = now();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  $("clock").textContent = time;
  $("ambientTime").textContent = time.replace(/\s?[AP]M$/, "");
  $("date").textContent = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  $("ambientDate").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
async function syncServerClock() {
  try {
    const h = await (await fetch("/api/admin/now")).json();
    if (h.now) {
      state.clockOffset = Date.parse(h.now) - Date.now();
      $("serverNow").textContent = `Home clock: ${new Date(h.now).toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      tickClock();
    }
  } catch {}
}

document.querySelectorAll("[data-advance]").forEach((b) => {
  b.addEventListener("click", async () => {
    await fetch("/api/admin/advance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: Number(b.dataset.advance) }) });
    await syncServerClock();
    addNote(`Clock moved ahead ${b.dataset.advance} day${b.dataset.advance === "1" ? "" : "s"}.`);
  });
});
$("resetHome").addEventListener("click", async () => {
  await fetch("/api/admin/reset", { method: "POST" });
  await syncServerClock();
  $("cardwrap").innerHTML = "";
  $("cardwrap").hidden = true;
  $("ambient").hidden = false;
  state.card = null;
  $("capUser").textContent = "";
  setCaption("");
  $("learner").hidden = true;
  addNote("Everything reset: no learners, no notes, no memories.");
});

$("speakToggle").addEventListener("change", (e) => {
  state.speak = e.target.checked;
  if (!state.speak) stopSpeaking();
});

function toggleDev() {
  const hidden = document.getElementById("app").classList.toggle("dev-hidden");
  $("devOpen").hidden = !hidden;
  $("devToggle").setAttribute("aria-expanded", String(!hidden));
}
$("devToggle").onclick = toggleDev;
$("devOpen").onclick = toggleDev;

// ------------------------------------------------------------------ traffic log

const pendingNames = new Map();

function describe(frame) {
  const m = frame.message;
  if (m.method) {
    if (m.method === "tools/call") {
      if (m.id !== undefined) pendingNames.set(m.id, `tools/call · ${m.params?.name}`);
      return { label: `tools/call <em>${m.params?.name}</em>`, err: false };
    }
    if (m.id !== undefined) pendingNames.set(m.id, m.method);
    return { label: m.method + (m.method === "elicitation/create" ? " <em>confirm with user</em>" : ""), err: false };
  }
  const name = pendingNames.get(m.id) ?? `#${m.id}`;
  if (m.error) return { label: `error ← ${name}`, err: true };
  const isErr = m.result?.isError;
  let extra = "";
  if (m.result?.protocolVersion) extra = ` <em>${m.result.protocolVersion}</em>`;
  else if (m.result?.tools) extra = ` <em>${m.result.tools.length} tools</em>`;
  else if (m.result?.structuredContent?.kind) extra = ` <em>${m.result.structuredContent.kind}</em>`;
  else if (m.result?.action) extra = ` <em>${m.result.action}</em>`;
  return { label: `result ← ${name.replace(/^tools\/call · /, "")}${extra}`, err: !!isErr };
}

function addTrace(frame) {
  const { label, err } = describe(frame);
  const li = document.createElement("li");
  li.className = `${frame.dir}${err ? " err" : ""}`;
  const t = new Date(frame.at).toLocaleTimeString("en-US", { hour12: false });
  li.innerHTML = `<details><summary><span class="dir">${frame.dir === "out" ? "↑" : "↓"}</span><span class="m">${label}</span><span class="t">${t}</span></summary><pre></pre></details>`;
  li.querySelector("pre").textContent = JSON.stringify(frame.message, (k, v) => (typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}… (${v.length} chars)` : v), 2);
  const list = $("traffic");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.appendChild(li);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function addNote(text, err = false) {
  const li = document.createElement("li");
  li.className = `note${err ? " err" : ""}`;
  li.textContent = text;
  $("traffic").appendChild(li);
  $("traffic").scrollTop = $("traffic").scrollHeight;
}

boot();
