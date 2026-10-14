import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";

/**
 * Natural voice for the device via Amazon Polly. Generative voices sound close to a person talking;
 * neural is the fallback for voices/regions without generative. Enable with BUDDY_TTS=polly
 * (standard AWS credential chain). Without it the browser's own voices are used.
 */

export interface TtsVoice {
  id: VoiceId;
  label: string;
}

/** Generative-capable English voices (Polly). */
export const POLLY_VOICES: TtsVoice[] = [
  { id: "Matthew", label: "Matthew (US, male)" },
  { id: "Ruth", label: "Ruth (US, female)" },
  { id: "Stephen", label: "Stephen (US, male)" },
  { id: "Danielle", label: "Danielle (US, female)" },
  { id: "Joanna", label: "Joanna (US, female)" },
  { id: "Kajal", label: "Kajal (Indian English, female)" },
  { id: "Amy", label: "Amy (UK, female)" },
  { id: "Arthur", label: "Arthur (UK, male)" },
];

export const TTS_ENABLED = process.env.BUDDY_TTS === "polly";

let client: PollyClient | undefined;
const cache = new Map<string, Buffer>();

export async function synthesize(text: string, voice: string, style: "talk" | "story" = "talk"): Promise<Buffer> {
  const id = (POLLY_VOICES.find((v) => v.id === voice)?.id ?? (process.env.BUDDY_VOICE as VoiceId) ?? "Matthew") as VoiceId;
  const key = `${id}|${style}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  client ??= new PollyClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const clean = text.slice(0, 2900);
  const tryEngine = async (engine: Engine) => {
    // Generative voices accept plain text best; neural gets SSML for a slightly slower bedtime pace.
    const ssml = engine === "neural" && style === "story";
    const out = await client!.send(
      new SynthesizeSpeechCommand({
        Engine: engine,
        VoiceId: id,
        OutputFormat: "mp3",
        TextType: ssml ? "ssml" : "text",
        Text: ssml ? `<speak><prosody rate="90%">${escapeXml(clean)}</prosody></speak>` : clean,
      }),
    );
    return Buffer.from(await out.AudioStream!.transformToByteArray());
  };
  let audio: Buffer;
  try {
    audio = await tryEngine("generative");
  } catch {
    audio = await tryEngine("neural");
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, audio);
  return audio;
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}
