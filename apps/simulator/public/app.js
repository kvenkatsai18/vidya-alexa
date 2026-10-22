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

// Short labels on the chips; each sends the full sentence.
const SUGGESTIONS = [
  { label: "Introduce Priya", text: "Hi, I'm Priya. I'm in 10th grade and I love cricket and cooking. My biology test is in 5 days." },
  { label: "Sample biology notes", text: "Use the sample biology notes", sample: true },
  { label: "Explain meiosis", text: "Explain meiosis" },
  { label: "Explain it differently", text: "Explain it differently" },
  { label: "Quiz me", text: "Quiz me" },
  { label: "Teach it back", text: "Let me teach it back" },
  { label: "Study plan", text: "What's my study plan?" },
  { label: "Homework", text: "What homework do I have?" },
  { label: "Focus 25 min", text: "Help me focus for 25 minutes" },
  { label: "Online quiz battle", text: "Let's play an online quiz battle with my friend" },
  { label: "Bedtime story for Leo", text: "Tell Leo a bedtime story about why stealing is wrong. He's 6 and loves dinosaurs." },
];

// Things to try, on the home screen's sticky note.
const TIPS_NEW = ["“Alexa, help me study”", "“I'm Leo's mom. He's 6 and loves dinosaurs.”", "“I'm in 10th grade and I love cricket”"];
const TIPS = ["“Quiz me”", "“What homework do I have?”", "“Explain it differently”", "“What's my study plan?”", "“Let's play an online quiz battle”", "“Help me focus for 25 minutes”"];

// ------------------------------------------------------------------ boot

async function boot() {
  initTheme();
  renderChips();
  setInterval(rotateTip, 9000);
  tickClock();
  setInterval(tickClock, 1000);
  syncServerClock();
  setInterval(syncServerClock, 30_000);

  try {
    const cfg = await (await fetch("/api/config")).json();
    voiceCfg.engine = cfg.tts?.engine ?? "browser";
    voiceCfg.serverVoices = cfg.tts?.voices ?? [];
    voiceCfg.defaultVoice = cfg.tts?.default ?? "Joanna";
    renderVoiceOptions();
    $("fSkill").textContent = cfg.skills.map((s) => s.name).join(", ");
    $("fSkill").title = "Loaded at runtime from skills/*/SKILL.md";
    $("fSkill").classList.add("okv");
  } catch {}

  const home = new URLSearchParams(location.search).get("home") ?? "";
  const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ home, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  const data = await res.json();
  if (!res.ok && data.needsAi) {
    $("fServer").textContent = "Waiting for an AI connection";
    $("fAgent").textContent = "None connected";
    $("ambient").hidden = true;
    $("needsAi").hidden = false;
    $("talkbar").querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    $("chips").hidden = true;
    return;
  }
  if (!res.ok) {
    $("fServer").textContent = "Not connected";
    setCaption(data.error ?? "Couldn't connect to the Vidya MCP server.");
    return;
  }
  state.session = data;
  $("fServer").textContent = `${data.server?.title ?? data.server?.name} ${data.server?.version ?? ""}`;
  $("fServer").classList.add("okv");
  $("fProto").textContent = data.protocolVersion;
  $("fSession").textContent = data.mcpSessionId ? `${data.mcpSessionId.slice(0, 8)}…` : "–";
  $("fSession").title = data.mcpSessionId ?? "";
  $("fHome").textContent = data.home === "home" ? "home (default)" : data.home;
  $("fHome").title = "Open another tab with ?home=friend to play Study Together across homes";
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
      // The question being read out, so an answer said over it can be recognized (buzzing in).
      state.question = /quiz_question|flashcard|group_question|online_game/.test(state.lastCardKind ?? "") ? e.result?.structuredContent?.question ?? null : null;
      showCard(e);
      break;
    case "speech":
      // The reply to a request they cancelled with "stop": don't speak it.
      if (state.awaitingReply && state.cancelledAt > state.turnAt) {
        state.awaitingReply = false;
        setCaption("");
        break;
      }
      state.awaitingReply = false;
      // Don't talk over them: if they're mid-sentence, hold the reply until they finish.
      if (listening && Date.now() - ear.lastHeardAt < 1500) {
        state.heldSpeech = e.text;
        break;
      }
      say(e.text);
      break;
    case "elicit":
      openSheet(e);
      break;
    case "audio":
      state.pendingAudio = [...(state.pendingAudio ?? []), ...e.items];
      break;
    case "alert": {
      const who = e.guardian ? e.guardian : "the parent";
      const what = { self_harm: "may be unsafe and needs you now", abuse: "may be unsafe and needs you now", danger: "may be unsafe and needs you now", bullying: "mentioned being bullied", distress: "seems to be feeling low" }[e.category] ?? "said something you should know about";
      showToast(`Alert sent to ${who}'s phone`, `${e.learner ?? "Your child"} ${what}. Open the parent view for details.`);
      addNote(`Safety alert sent to ${who} (simulated Alexa app notification): ${e.category}`, true);
      break;
    }
    case "voice_ready":
      addNote("Out-of-band step finished (notifications/elicitation/complete).");
      break;
    case "elicit_done": {
      // Accepted by voice: the browser won't open a page without a tap, so keep a button to open it.
      const p = state.pendingElicit;
      if (p && p.id === e.id && e.action === "accept" && p.url) showLinkSheet(p);
      else closeSheet(e.id);
      break;
    }
    case "error":
      addNote(`Agent error: ${e.message}`, true);
      break;
    case "learner":
      $("learner").hidden = false;
      $("learner").textContent = e.name;
      $("learner").title = e.level ?? "";
      state.learnerName = e.name;
      tickClock();
      break;
    case "learned":
      showLearned(e.lesson);
      addNote(`Learned from a correction: ${e.lesson}`);
      break;
    case "sampling":
      addNote(`Sampling answered by the client's model (${e.purpose}, ${(e.ms / 1000).toFixed(1)}s)`);
      break;
  }
}

async function sendTurn(text, source = "text") {
  if (!state.session || !text.trim()) return;
  stopSpeaking();
  state.turnAt = Date.now();
  state.awaitingReply = true;
  const interrupted = state.interrupted && Date.now() - state.interrupted.at < 30_000 ? { said: state.interrupted.said, unsaid: state.interrupted.unsaid, answering: !!state.interrupted.answering } : undefined;
  state.interrupted = null;
  // Tests of the ear (window.__ear.dry): record what would be sent instead of sending it.
  if (window.__ear?.dry) return void window.__ear.sent.push({ text, interrupted });
  state.pendingAudio = [];
  state.lastInput = source;
  armFiller();
  await fetch(`/api/sessions/${state.session.id}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source, interrupted }),
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
/** How far through the current reply the device got, so an interruption keeps its context. */
const progress = { full: "", done: [] };
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
  rememberSaid(spoken);
  if (!opts.filler) {
    progress.full = spoken;
    progress.done = [];
  }
  const story = state.lastCardKind === "story" && !opts.filler;
  setState("speaking");
  try {
    if (voiceCfg.engine === "polly" && voiceCfg.choice?.startsWith("polly:")) await speakPolly(spoken, token, story, !opts.filler);
    else await speakBrowser(spoken, token, story, !opts.filler);
  } catch (err) {
    console.warn("speech failed", err);
  }
  if (token !== speakToken) return;
  if (!opts.filler && state.pendingAudio?.length) return playPendingAudio(token);
  if (screen.dataset.state === "speaking") setState("idle");
  lastSpokeAt = Date.now();
  if (!opts.filler) {
    // Drop anything the mic picked up of the device's own voice before listening for the answer.
    flushEar();
    afterSpeech(spoken);
  }
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

function speakBrowser(text, token, story, track = false) {
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
      u.onstart = () => timeWords(parts[i], wordsOf(parts[i]).length / 2.6 / u.rate);
      u.onend = u.onerror = () => {
        if (track && token === speakToken) progress.done.push(parts[i]);
        setTimeout(() => next(i + 1), story ? 320 : /[?!]$/.test(parts[i]) ? 220 : 140);
      };
      speechSynthesis.speak(u);
    };
    next(0);
  });
}

async function speakPolly(text, token, story, track = false) {
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
      const a = currentAudio;
      a.onplaying = () => timeWords(parts[i], Number.isFinite(a.duration) ? a.duration : 0);
      currentAudio.onended = currentAudio.onerror = resolve;
      currentAudio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
    if (track && token === speakToken) progress.done.push(parts[i]);
  }
}

/**
 * When the device says each word (estimated across the audio). The mic hears the device's own voice
 * a moment after it speaks, so only words it said in the last few seconds can be its echo: an answer
 * it hasn't read out yet, or read out a while ago, is the learner's.
 */
const timeline = [];
function timeWords(text, seconds) {
  const w = wordsOf(text);
  const span = (seconds || w.length / 2.6) * 1000;
  const start = Date.now();
  w.forEach((x, i) => timeline.push({ w: x, at: start + ((i + 0.5) / w.length) * span }));
  while (timeline.length && timeline[0].at < Date.now() - 60_000) timeline.shift();
}
const ECHO_LAG = 3000;
const justSaid = (w) => timeline.some((x) => x.w === w && x.at <= Date.now() + 300 && x.at >= Date.now() - ECHO_LAG);
/** Share of the heard words the device said in the last few seconds. */
const timedEchoRatio = (t) => {
  const w = wordsOf(t);
  return w.length ? w.filter(justSaid).length / w.length : 1;
};

function stopSpeaking() {
  if (screen.dataset.state === "speaking") lastSpokeAt = Date.now();
  ducked = false;
  clearTimeout(duckTimer);
  speakToken++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

/** Conversation, not commands: after a question, keep listening for the answer (like Alexa follow-up mode). */
/**
 * Conversation mode: after every reply to something you said, keep listening for a few seconds
 * without the wake word (the blue light stays on), so a conversation doesn't need "Alexa" each time.
 */
function afterSpeech() {
  if ($("handsFree").checked && state.lastInput === "voice" && ear.rec && !listening) {
    // Give the recognizer a moment to restart cleanly after the flush.
    setTimeout(() => {
      if (!listening && !deviceTalking()) startListening({ auto: true, quiet: true });
    }, 450);
  }
}

/** If the answer takes a moment, say something a person would say instead of going silent. */
const FILLERS = ["Hmm, one sec.", "Let me think.", "Okay, give me a second.", "Good one. Let me see."];
function armFiller() {
  clearTimeout(fillerTimer);
  if (!state.speak) return;
  fillerTimer = setTimeout(() => say(FILLERS[Math.floor(Math.random() * FILLERS.length)], { filler: true }), 2200);
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
  screen.dataset.mood = e.result?.structuredContent?.kind === "story" ? "story" : "";
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
          theme: cardTheme(),
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
    $("sheetYes").textContent = "Open the secure page";
    $("sheetHint").textContent = "It opens in a new tab, like a page on your phone. Or just say “yes”.";
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

function showLinkSheet(e) {
  state.pendingElicit = null;
  state.linkOnly = e;
  $("sheetForm").hidden = true;
  $("sheetTitle").textContent = "Open the secure page";
  $("sheetMsg").textContent = e.message;
  $("sheetYes").textContent = "Open page";
  $("sheetHint").textContent = "On a real Alexa+ device, this link would go to your phone.";
  $("sheet").hidden = false;
}

async function answerElicit(action) {
  if (state.linkOnly) {
    if (action === "accept") window.open(state.linkOnly.url, "_blank", "noopener");
    state.linkOnly = null;
    $("sheet").hidden = true;
    return;
  }
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
    b.textContent = s.label;
    b.title = s.text;
    b.onclick = () => (s.sample ? shareNotes({ sample: true }) : sendTurn(s.text, "text"));
    $("chips").appendChild(b);
  }
}

// ------------------------------------------------------------------ the ear: wake word, barge-in, follow-up, hold-to-talk
//
// One continuous recognizer, like an Echo's microphones:
//  - waits for "Alexa" (or "Hey Alexa"), then captures the request and sends it when you stop talking;
//  - while the device is talking, "Alexa…" interrupts it and listens, "stop"/"cancel"/"wait" just stops it;
//  - after the device asks a question, it listens for a few seconds without the wake word (follow-up mode);
//  - ignores anything that matches what the device itself is saying (its own voice through the speakers).
// Holding the mic button or the space bar still works, with or without the wake word.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /\b(?:hey |ok |okay )?alexa\b[,.!?]?\s*/i;
const STOP = /^(?:stop|cancel|wait|pause|be quiet|quiet|shush|enough|never ?mind|that'?s enough)\b/i;
// mode: "idle" = waiting for the wake word; "wake" / "follow" / "ptt" = capturing a request.
const ear = { rec: null, on: false, wanted: false, mode: "idle", buffer: "", started: 0, silence: null, gestureRetry: false };
let listening = false; // capturing a request right now
let rec = null; // kept for older checks

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
// Chrome mishears the device's own voice a little ("meiosis" -> "meiosis's"), so compare word stems.
const stem = (w) => w.replace(/'s$/, "").slice(0, 5);
const wordsOf = (t) => norm(t).split(" ").filter((w) => w.length > 1).map(stem);

/** What the device said recently (replies and fillers), to recognize its own voice coming back. */
const deviceSaid = [];
function rememberSaid(text) {
  deviceSaid.push({ words: new Set(wordsOf(text)), at: Date.now() });
  while (deviceSaid.length > 4) deviceSaid.shift();
}
/** Share of the heard words that the device itself just said (0 = all new, 1 = all its own). */
function echoRatio(t) {
  const w = wordsOf(t);
  if (!w.length) return 1;
  let best = 0;
  for (const d of deviceSaid) if (Date.now() - d.at < 90_000) best = Math.max(best, w.filter((x) => d.words.has(x)).length / w.length);
  return best;
}
let lastSpokeAt = 0;
const deviceTalking = () => screen.dataset.state === "speaking";
/** The device's own voice: while it talks, and for a moment after (recognition lags behind). */
const isEcho = (t) => !norm(t) || ((deviceTalking() || Date.now() - lastSpokeAt < 1200) && echoRatio(t) >= 0.5);
/** Just "stop" (or "wait", "cancel"…): the device stops by itself, like Alexa. It's never sent to the AI. */
const STOP_ONLY = /^(?:(?:hey |ok |okay )?alexa[,!.]?\s*)?(?:ok(?:ay)? |no |please )?(stop|stop it|stop talking|stop that|wait|hold on|cancel|cancel that|never ?mind|quiet|be quiet|shush|enough|that'?s enough)(?: please| now)?[.!]?$/i;
function cancelReply() {
  clearTimeout(fillerTimer);
  if (state.awaitingReply) state.cancelledAt = Date.now();
}
const STOP_ANY = /\b(stop|wait|cancel|pause|hold on|be quiet|shut up|enough|never ?mind)\b/i;
/** Did the device itself just say this word? ("we'll stop here" shouldn't stop it.) */
/** Does this sound like an answer to the question being read? "letter" ("B"), "ordinal" ("the second one"), "yesno", "option" (names one option), "open" (a short answer to an open question), or null. */
function answerKind(t) {
  const q = state.question;
  const a = norm(t).replace(/^(it'?s|is it|i think( it'?s)?|the answer is|answer|um+|uh+)\s+/, "");
  if (!a || a.split(" ").length > 6) return null;
  if (/^(option |letter )?[a-d]$/.test(a)) return "letter";
  if (/^(the )?(first|second|third|fourth|last) one$/.test(a)) return "ordinal";
  if (/^(true|false|yes|no)$/.test(a)) return "yesno";
  const named = (q?.options ?? []).filter((o) => {
    const ow = wordsOf(o);
    return ow.length && ow.every((w) => wordsOf(a).includes(w));
  });
  if (named.length === 1) return "option";
  return !q?.options?.length && a.split(" ").length <= 4 ? "open" : null;
}
const deviceSaidWord = (w) => deviceSaid.some((d) => Date.now() - d.at < 90_000 && d.words.has(stem(norm(w))));
/** A person goes quiet the moment you start talking: dip (or pause) the voice on the first sign of you. */
let ducked = false;
let duckTimer = null;
function duck() {
  if (ducked) return;
  ducked = true;
  // Polly: lower the volume. (Chrome's own voices can't pause reliably: pausing ends them. They just stop when you do interrupt.)
  if (currentAudio) currentAudio.volume = 0.2;
  clearTimeout(duckTimer);
  duckTimer = setTimeout(unduck, 1600); // it was noise after all: carry on
}
function unduck() {
  if (!ducked) return;
  ducked = false;
  if (currentAudio) currentAudio.volume = 1;
}
/** Remember what it had said and not yet said, so it can carry on from the correction. */
function noteInterruption() {
  if (!progress.full) return;
  const said = progress.done.join(" ").trim();
  const unsaid = progress.full.slice(progress.full.indexOf(said) + said.length).trim();
  state.interrupted = { said, unsaid, at: Date.now() };
}

/** Throw away whatever the recognizer heard while the device was talking. */
function flushEar() {
  if (!ear.on) return;
  try {
    ear.rec.abort(); // onend restarts it a moment later, clean
  } catch {}
}
const wakeOn = () => $("wakeWord")?.checked && !!SR;

if (!SR) {
  $("micnote").hidden = false;
  $("mic").disabled = true;
} else {
  rec = ear.rec = new SR();
  ear.rec.lang = "en-US";
  ear.rec.continuous = true;
  ear.rec.interimResults = true;
  ear.rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) heard(r[0].transcript, true);
      else interim += r[0].transcript;
    }
    if (interim) heard(interim, false);
  };
  // Chrome stops continuous recognition after a while; keep the ear open while it's wanted.
  ear.rec.onend = () => {
    ear.on = false;
    if (ear.wanted) setTimeout(startEar, 200);
  };
  ear.rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      // Usually: no click on the page yet. Try again on the first click.
      if (!ear.gestureRetry) {
        ear.gestureRetry = true;
        document.addEventListener("pointerdown", () => wakeOn() && setEar(true), { once: true });
        updateEarNote("Click anywhere to let Alexa listen");
      } else {
        $("wakeWord").checked = false;
        setEar(false);
        addNote("Microphone blocked. Allow it in the address bar to use the wake word.", true);
      }
    } else if (ev.error !== "no-speech" && ev.error !== "aborted") addNote(`Microphone: ${ev.error}`, true);
  };
}

function startEar() {
  if (!ear.rec || ear.on || !ear.wanted) return;
  try {
    ear.rec.start();
    ear.on = true;
  } catch {}
}
function setEar(on) {
  ear.wanted = on;
  if (on) startEar();
  else {
    try {
      ear.rec?.stop();
    } catch {}
  }
  updateEarNote();
}
function updateEarNote(text) {
  const el = $("earNote");
  if (!el) return;
  el.hidden = !SR;
  el.textContent = text ?? (wakeOn() ? "Listening for “Alexa”" : "Wake word off: hold the mic or the space bar to talk");
  el.classList.toggle("on", !!wakeOn() && !text);
}

function heard(text, final) {
  const t = text.trim();
  if (!t) return;

  // Interrupting while the device is talking (barge-in), like Alexa:
  //  "Alexa..." -> stop and listen;  "stop" / "wait" / "hold on" (anywhere, not its own word) -> stop;
  //  clearly saying something else (3+ words that aren't its own) -> stop, and that's the new request.
  if (deviceTalking()) {
    const wake = WAKE.test(t);
    const stopWord = STOP_ANY.exec(t);
    const stopIsYours = !!stopWord && !deviceSaidWord(stopWord[1]);
    // Its own voice comes back through the mic, sometimes seconds late: anything it said recently
    // doesn't count as you (so it doesn't dip its volume at random).
    const ratio = echoRatio(t);
    // For quiz answers only: when it said each word, so an option it read a while ago (or hasn't
    // read yet) can still be your answer.
    const timed = timeline.length ? timedEchoRatio(t) : ratio;
    const yours = wordsOf(t).length >= 1 && ratio < 0.35;
    // Reading out a quiz question: they can answer over it, like buzzing in on a quiz show.
    const quiz = !!state.question;
    // Mostly the device's own words? Then only an answer that names one option counts (they repeated
    // the option they heard); "First one." coming back through the mic is not an answer.
    const kind = quiz && final ? answerKind(t) : null;
    const buzz = !!kind && (kind === "letter" || timed < 0.5 || (kind === "option" && !/^[a-d] /.test(norm(t))));
    if (wake || stopIsYours || yours || buzz) {
      ear.lastHeardAt = Date.now();
      duck();
      console.debug("[ear] heard you while talking:", JSON.stringify(t), { final, echo: ratio.toFixed(2), timed: timed.toFixed(2) });
    }
    // Stop on "Alexa", on "wait"/"stop", on an answer, or once it's clear you're saying something else.
    const interrupting = wake || stopIsYours || buzz || (final && wordsOf(t).length >= (quiz ? 1 : 2) && ratio < 0.35);
    if (!interrupting) return; // its own voice, or not sure yet: keep going (quietly, if ducked)
    noteInterruption();
    if (state.interrupted && quiz && !wake && !stopIsYours) state.interrupted.answering = true;
    stopSpeaking();
    setState("idle");
    cancelReply();
    // Keep listening: "wait..." is usually followed by what they actually mean ("not this, that").
    beginCapture("barge");
    const said = (wake ? t.replace(/^.*?\b(?:hey |ok |okay )?alexa\b[,.!?]?\s*/i, "") : t).trim();
    if (final && said) ear.buffer = said;
    $("capUser").classList.add("interim");
    $("capUser").textContent = said || "…";
    if (final && said) {
      clearTimeout(ear.silence);
      ear.silence = setTimeout(finishCapture, STOP_ONLY.test(said) ? 4000 : endOfSpeechWait(said, true));
    }
    return;
  }

  // Waiting: only the wake word starts a request (once, however many partial results repeat it).
  if (ear.mode === "idle") {
    if (WAKE.test(t)) beginCapture("wake");
    else return;
  }
  if (isEcho(t) && ear.mode !== "ptt") return;
  ear.lastHeardAt = Date.now();

  const said = t.replace(/^.*?\b(?:hey |ok |okay )?alexa\b[,.!?]?\s*/i, "").trim();
  if (final && said) ear.buffer = `${ear.buffer} ${said}`.trim();
  $("capUser").classList.add("interim");
  $("capUser").textContent = (final ? ear.buffer : `${ear.buffer} ${said}`.trim()) || "…";
  // Only start the "you've stopped talking" countdown once they've said something after the wake word;
  // until then, keep waiting for the request (like an Echo after "Alexa").
  if (ear.mode !== "ptt" && (said || ear.buffer)) {
    clearTimeout(ear.silence);
    ear.silence = setTimeout(finishCapture, endOfSpeechWait(final ? ear.buffer : `${ear.buffer} ${said}`, final));
  }
}

/**
 * How long a pause means "done". Chrome finalizes text at every natural pause, so a fixed short
 * timer cuts people off mid-sentence. Wait longer when the words so far sound unfinished.
 */
const TRAILING = /\b(and|or|but|so|then|the|a|an|to|of|for|from|with|about|my|your|our|is|are|was|be|um+|uh+|er+|like|because|what|how|when|where|which|who|that|if|can|could|would|should|will|do|does|also|in|on|at|me)$/i;
function endOfSpeechWait(text, final) {
  if (!final) return 2800; // still talking
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (Date.now() - ear.started > 25_000) return 300; // long enough; send it
  // Quick replies: answer right away, like Alexa does for "yes".
  if (/^(yes|yeah|yep|no|nope|sure|okay|ok|true|false|right|correct|[a-d]|option [a-d]|\d+|one|two|three|four|five|stop|next|skip|hint|repeat)( please| thanks| thank you)?$/i.test(t)) return 900;
  if (TRAILING.test(t) || /[,-]$/.test(t)) return 2600;
  if (words <= 2) return 1800;
  return 1500;
}

function beginCapture(mode) {
  clearTimeout(ear.silence);
  ear.mode = mode;
  ear.buffer = "";
  ear.started = Date.now();
  listening = true;
  if (mode !== "follow" && mode !== "barge") {
    chime(true);
    ear.chimes = (ear.chimes ?? 0) + 1;
  }
  $("mic").classList.add("live");
  setState("listening");
  $("capUser").textContent = "";
  // Nothing said after the wake word, or no answer to a follow-up: go back to waiting.
  ear.silence = setTimeout(finishCapture, mode === "follow" ? 7000 : 6000);
  if (mode === "barge") ear.fromInterrupt = true;
}

function finishCapture() {
  clearTimeout(ear.silence);
  // Drop thinking sounds ("um", "uh"), like a person listening would.
  const text = ear.buffer.replace(/\b(um+|uh+|er+|hmm+)\b[,.]?\s*/gi, "").replace(/\s+/g, " ").trim();
  const fromInterrupt = !!ear.fromInterrupt;
  ear.fromInterrupt = false;
  ear.mode = "idle";
  ear.buffer = "";
  listening = false;
  $("mic").classList.remove("live");
  if (screen.dataset.state === "listening") setState("idle");
  if (!wakeOn()) setEar(false);
  if (!text) {
    if ($("capUser").textContent === "…") $("capUser").textContent = "";
    // They went quiet: say the reply that was held while they were talking.
    if (state.heldSpeech) {
      const held = state.heldSpeech;
      state.heldSpeech = null;
      say(held);
    }
    return;
  }
  state.heldSpeech = null; // they asked something new: the held reply is out of date
  chime(false);
  $("capUser").classList.remove("interim");
  $("capUser").textContent = text;
  // "Stop" while it's talking (or just finished, or still preparing a reply) means "stop talking":
  // handled right here, never sent to the AI. When it's quiet, "stop" ends the activity (a quiz, a timer).
  // An interruption that was only "wait"/"stop": they've been heard; stay quiet and ready.
  if (STOP_ONLY.test(text) && (fromInterrupt || deviceTalking() || Date.now() - lastSpokeAt < 3000 || state.awaitingReply)) {
    state.interrupted = null;
    stopSpeaking();
    setState("idle");
    cancelReply();
    return;
  }
  if (state.pendingElicit?.isConfirm && /^(yes|yeah|yep|sure|confirm|do it|go ahead|no|nope|cancel)\b/i.test(text)) {
    state.lastInput = "voice";
    answerElicit(/^(no|nope|cancel)/i.test(text) ? "decline" : "accept");
    return;
  }
  sendTurn(text, "voice");
}

/** Hold-to-talk (mic button or space bar). Also interrupts the device if it's talking. */
function startListening(opts = {}) {
  if (!ear.rec || listening) return;
  if (!opts.quiet) stopSpeaking();
  if (!ear.on) {
    ear.wanted = true;
    startEar();
  }
  beginCapture(opts.auto ? "follow" : "ptt");
}
function stopListening() {
  if (ear.mode !== "ptt") return;
  clearTimeout(ear.silence);
  // Give the recognizer a moment to deliver the last words.
  setTimeout(finishCapture, 600);
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
  if (e.key === "Escape") {
    if (state.pendingElicit) answerElicit("decline");
    else if (screen.dataset.state === "speaking") {
      stopSpeaking();
      setState("idle");
    }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement !== $("text")) stopListening();
});

// For automated checks: feed the ear text as if it had been heard.
window.__ear = { heard, timeWords, rememberSaid, dry: false, sent: [], question: (q) => (state.question = q), talking: () => deviceTalking(), say: (t) => say(t), lastInput: (v) => (state.lastInput = v), audio: () => (currentAudio ? { volume: currentAudio.volume, paused: currentAudio.paused } : null), state: () => ({ ducked, mode: ear.mode, buffer: ear.buffer, listening, on: ear.on, wanted: ear.wanted, chimes: ear.chimes ?? 0 }) };

if ($("wakeWord")) {
  try {
    const saved = localStorage.getItem("wakeWord");
    if (saved !== null) $("wakeWord").checked = saved === "on";
  } catch {}
  $("wakeWord").addEventListener("change", () => {
    try {
      localStorage.setItem("wakeWord", $("wakeWord").checked ? "on" : "off");
    } catch {}
    setEar(wakeOn());
  });
  setEar(wakeOn());
}

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
  const h = d.getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("ambientGreet").textContent = state.learnerName ? `${part}, ${state.learnerName}.` : `${part}.`;
  if (state.themeChoice === "auto") applyTheme();
}

function rotateTip() {
  const list = state.learnerName ? TIPS : TIPS_NEW;
  state.tip = ((state.tip ?? 0) + 1) % list.length;
  $("ambientHint").textContent = list[state.tip];
}

// ------------------------------------------------------------------ screen theme: day, night (bedtime), or auto by the home clock

function initTheme() {
  // Night (Alexa's dark look) by default, like an Echo Show at home.
  state.themeChoice = store.get("sb.theme") ?? "night";
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    b.addEventListener("click", () => {
      state.themeChoice = b.dataset.themeChoice;
      store.set("sb.theme", state.themeChoice);
      applyTheme();
    });
  });
  applyTheme();
}

function resolvedTheme() {
  if (state.themeChoice !== "auto") return state.themeChoice;
  const h = now().getHours();
  return h >= 19 || h < 7 ? "night" : "day";
}

/** MCP Apps theme for the cards: light by day, dark at night. */
function cardTheme() {
  return resolvedTheme() === "night" ? "dark" : "light";
}

function applyTheme() {
  const t = resolvedTheme();
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === state.themeChoice)));
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  try {
    state.card?.iframe.contentWindow?.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: cardTheme() } }, "*");
  } catch {}
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
    b.disabled = true;
    addNote(`Demo clock: moving ahead ${b.dataset.advance} day${b.dataset.advance === "1" ? "" : "s"} and running the overnight routine…`);
    const r = await (await fetch("/api/admin/advance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: Number(b.dataset.advance) }) })).json().catch(() => ({}));
    b.disabled = false;
    await syncServerClock();
    addNote(r.routines ? `Overnight routine done for ${r.routines} learner${r.routines === 1 ? "" : "s"}. Say "Good morning".` : `It's now the next day. Say "Good morning".`);
  });
});
$("resetHome").addEventListener("click", async () => {
  await fetch("/api/admin/reset", { method: "POST" });
  await syncServerClock();
  $("cardwrap").innerHTML = "";
  $("cardwrap").hidden = true;
  $("ambient").hidden = false;
  screen.dataset.mood = "";
  state.card = null;
  $("capUser").textContent = "";
  setCaption("");
  $("learner").hidden = true;
  state.learnerName = null;
  tickClock();
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

// ------------------------------------------------------------------ parent alert (simulates a push notification to the parent's phone)

function showToast(title, body) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "alert");
  el.innerHTML = `<b></b><span></span>`;
  el.querySelector("b").textContent = title;
  el.querySelector("span").textContent = body;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("out"), 9000);
  setTimeout(() => el.remove(), 9600);
}

/** A small note on the device when Vidya learns from a correction. */
function showLearned(lesson) {
  const el = document.createElement("div");
  el.className = "learned";
  el.setAttribute("role", "status");
  el.innerHTML = `<b>Learned</b> <span></span>`;
  el.querySelector("span").textContent = lesson;
  $("screen").appendChild(el);
  setTimeout(() => el.classList.add("out"), 4500);
  setTimeout(() => el.remove(), 5200);
}
