// Builds the built-in reading sounds (media/sounds/*.ogg) from public-domain recordings on
// Freesound (Creative Commons 0, see the README's credits): downloads each recording's
// high-quality preview (the MP3 Freesound makes of every upload), cuts a few minutes out of it,
// crossfades the end into the start so the file loops without a seam, evens out the loudness and
// encodes it as Ogg Vorbis (VS Code's webviews play Vorbis, MP3, FLAC and WAV, but not Opus or AAC).
//
// The loops are part of the repository, so this is only needed to change or rebuild them. The
// list of sounds the extension offers is in src/shared/sounds.ts; keep the ids in step.
//
// Needs an ffmpeg with libvorbis, on PATH or given through the FFMPEG environment variable.
// Downloads are cached in SOUNDS_WORK_DIR (default: a folder in the system temp directory), so
// running the script again only re-encodes.
//
// Usage: npm run sounds [-- --force] [-- --download-only] [-- <sound id>…]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(root, 'media', 'sounds');
const WORK_DIR = process.env.SOUNDS_WORK_DIR || join(tmpdir(), 'markdown-pdf-viewer-sounds');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const args = process.argv.slice(2);
const force = args.includes('--force');
const downloadOnly = args.includes('--download-only');
const only = args.filter((a) => !a.startsWith('--'));

const RATE = 48_000;
/**
 * The limiter catches the peaks the gain pushes up (a fireplace's crackles stand 30 dB and more
 * above its average level). Its ceiling (0.7, about -3 dBFS, unless a sound sets `limit`) leaves
 * room for the Vorbis encoder, which adds a little to sharp peaks. The fast release (20 ms) keeps
 * the quiet sound between crackles from dipping after each one.
 */
const limiter = (limit = 0.7) => `alimiter=limit=${limit}:attack=1:release=20:level=false:latency=true`;
/** Every loop's integrated loudness (LUFS), i.e. how loud it is at full volume: all the same, so switching sounds keeps the loudness. */
const LOUDNESS = -16;
/** Seconds of the end of each stretch blended into its start. */
const CROSSFADE = 8;
/** Vorbis VBR quality (3 is about 112 kbit/s). */
const QUALITY = 3;

/**
 * id:      file name in media/sounds/ (and the id in src/shared/sounds.ts)
 * page:    the recording on Freesound
 * preview: Freesound's high-quality MP3 preview of it
 * from:    where the loop starts in the recording (seconds), a steady stretch without thunder,
 *          cars, voices or handling noise
 * loop:    length of the finished loop (seconds)
 * limit:   a lower limiter ceiling, for crackles that Vorbis would otherwise push past full scale
 */
const SOUNDS = [
  {
    id: 'rain-half-open-window',
    title: 'Rain from Half Open Window 1 by RutgerMuller',
    page: 'https://freesound.org/people/RutgerMuller/sounds/158690/',
    preview: 'https://cdn.freesound.org/previews/158/158690_179538-hq.mp3',
    from: 45,
    loop: 240,
  },
  {
    id: 'rain-mountain-downpour',
    title: 'Rain in Albanian Mountains (White Noise) by SignatureSoundsOrg',
    page: 'https://freesound.org/people/SignatureSoundsOrg/sounds/872734/',
    preview: 'https://cdn.freesound.org/previews/872/872734_19205925-hq.mp3',
    from: 693,
    loop: 240,
  },
  {
    id: 'rain-hotel-window',
    title: 'Dharamshala Rain by AugustSandberg',
    page: 'https://freesound.org/people/AugustSandberg/sounds/508527/',
    preview: 'https://cdn.freesound.org/previews/508/508527_1934171-hq.mp3',
    from: 937,
    loop: 240,
  },
  {
    id: 'rain-roof-window',
    title: 'Rain on the House Roof Window #001 by bassimat',
    page: 'https://freesound.org/people/bassimat/sounds/833924/',
    preview: 'https://cdn.freesound.org/previews/833/833924_15636277-hq.mp3',
    from: 572,
    loop: 240,
  },
  {
    id: 'rain-countryside',
    title: 'Rain heavy 1 (rural) by jmbphilmes',
    page: 'https://freesound.org/people/jmbphilmes/sounds/200270/',
    preview: 'https://cdn.freesound.org/previews/200/200270_2322692-hq.mp3',
    from: 105,
    loop: 240,
  },
  {
    id: 'fire-home-fireplace',
    title: 'Fireplace by inchadney',
    page: 'https://freesound.org/people/inchadney/sounds/132534/',
    preview: 'https://cdn.freesound.org/previews/132/132534_28867-hq.mp3',
    from: 11,
    loop: 240,
  },
  {
    id: 'fire-close-fireplace',
    title: 'Fireplace for Six Minutes (Stereo) by petebuchwald',
    page: 'https://freesound.org/people/petebuchwald/sounds/496130/',
    preview: 'https://cdn.freesound.org/previews/496/496130_2367139-hq.mp3',
    from: 116,
    loop: 240,
  },
  {
    id: 'fire-living-room',
    title: 'Aachen Burning Fireplace Crackling Fire Sounds by visionear',
    page: 'https://freesound.org/people/visionear/sounds/501417/',
    preview: 'https://cdn.freesound.org/previews/501/501417_10869493-hq.mp3',
    from: 302,
    loop: 240,
    limit: 0.5,
  },
  {
    id: 'fire-log-cabin',
    title: '(binaural) fire crackling by yfjesse',
    page: 'https://freesound.org/people/yfjesse/sounds/734248/',
    preview: 'https://cdn.freesound.org/previews/734/734248_2391840-hq.mp3',
    from: 3,
    loop: 240,
    limit: 0.5,
  },
  {
    id: 'fire-wet-log',
    title: 'fireplace-jim by hovercraft',
    page: 'https://freesound.org/people/hovercraft/sounds/66412/',
    preview: 'https://cdn.freesound.org/previews/66/66412_131669-hq.mp3',
    from: 3,
    loop: 240,
  },
];

function run(cmd, args, { input, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found. Install ffmpeg or set the FFMPEG environment variable.`) : e));
    proc.on('close', (code) => {
      const stderr = Buffer.concat(err).toString();
      if (code !== 0) reject(new Error(`${cmd} exited with ${code}:\n${stderr.slice(-2000)}`));
      else resolve({ stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), stderr });
    });
    if (input) {
      proc.stdin.on('error', () => undefined);
      proc.stdin.end(input);
    }
  });
}

const CHUNK = 2 * 1024 * 1024;
const CONNECTIONS = 16;

/** Runs `tasks` (functions returning promises) with at most `limit` running at once. */
async function pool(tasks, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function fetchRange(url, start, end) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length !== end - start + 1) throw new Error(`got ${data.length} of ${end - start + 1} bytes`);
      return data;
    } catch (err) {
      if (attempt >= 4) throw new Error(`downloading ${url} (bytes ${start}-${end}) failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/**
 * Downloads the previews of `sounds` (cached between runs). The server sends each connection
 * slowly, so every file comes in 2 MB pieces over several connections at once.
 */
async function download(sounds) {
  const files = new Map(sounds.map((s) => [s.id, join(WORK_DIR, `${s.preview.split('/').pop()}`)]));
  const missing = sounds.filter((s) => !existsSync(files.get(s.id)));
  if (missing.length === 0) return files;
  const sizes = await Promise.all(
    missing.map(async (s) => {
      const response = await fetch(s.preview, { method: 'HEAD' });
      const size = Number(response.headers.get('content-length'));
      if (!response.ok || !size) throw new Error(`${s.preview}: HTTP ${response.status}`);
      return size;
    }),
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  console.log(`Downloading ${missing.length} preview(s), ${(total / 1048576).toFixed(1)} MB…`);
  const parts = missing.map((s, i) => {
    const pieces = [];
    for (let start = 0; start < sizes[i]; start += CHUNK) pieces.push([start, Math.min(sizes[i], start + CHUNK) - 1]);
    return { sound: s, pieces, data: new Array(pieces.length) };
  });
  let done = 0;
  const tasks = parts.flatMap((part) =>
    part.pieces.map(([start, end], k) => async () => {
      part.data[k] = await fetchRange(part.sound.preview, start, end);
      done += end - start + 1;
      process.stdout.write(`\r  ${((100 * done) / total).toFixed(0)} %`);
    }),
  );
  await pool(tasks, CONNECTIONS);
  process.stdout.write('\n');
  for (const part of parts) {
    const file = files.get(part.sound.id);
    writeFileSync(`${file}.part`, Buffer.concat(part.data));
    renameSync(`${file}.part`, file);
  }
  return files;
}

/** Integrated loudness (LUFS) and true peak (dBTP) of `seconds` of audio starting at `offset`. */
async function measure(file, offset, seconds, filter = 'anull') {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(offset), '-t', String(seconds), '-i', file, '-af', `${filter},ebur128=peak=true`, '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  if (!match) throw new Error(`could not measure the loudness of ${file}`);
  const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
  return { loudness: Number(match[1]), truePeak: peak ? Number(peak[1]) : Number.NaN };
}

async function decode(file, offset, seconds, filter) {
  const { stdout } = await run(
    FFMPEG,
    ['-v', 'error', '-ss', String(offset), '-t', String(seconds), '-i', file, '-af', filter, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-'],
    { binary: true },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

/**
 * A loop of `loop` seconds from `loop + crossfade` seconds of audio: the last `crossfade` seconds
 * are blended (equal power) into the first ones, so the loop's end runs straight into its start.
 */
export function makeLoop(pcm, loopSeconds, crossfadeSeconds, channels = 2) {
  const loopFrames = Math.round(loopSeconds * RATE);
  const fadeFrames = Math.round(crossfadeSeconds * RATE);
  if (pcm.length < (loopFrames + fadeFrames) * channels) throw new Error('not enough audio for the loop');
  const out = pcm.slice(0, loopFrames * channels);
  for (let i = 0; i < fadeFrames; i++) {
    const t = (i + 0.5) / fadeFrames;
    const fadeIn = Math.sin((t * Math.PI) / 2);
    const fadeOut = Math.cos((t * Math.PI) / 2);
    for (let c = 0; c < channels; c++) {
      const k = i * channels + c;
      out[k] = pcm[k] * fadeIn + pcm[(loopFrames + i) * channels + c] * fadeOut;
    }
  }
  return out;
}

function peakOf(pcm) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  return peak;
}

async function build(sound, source) {
  const target = join(OUT_DIR, `${sound.id}.ogg`);
  if (existsSync(target) && !force) {
    console.log(`${sound.id}: ${target} exists (use --force to rebuild)`);
    return;
  }
  const seconds = sound.loop + CROSSFADE;
  const measured = (await measure(source, sound.from, seconds)).loudness;
  // The limiter takes some loudness away (most from spiky sounds such as crackles), so adjust the
  // gain until the limited audio reaches the target.
  let gainDb = LOUDNESS - measured;
  for (let i = 0; i < 4; i++) {
    const reached = (await measure(source, sound.from, seconds, `volume=${gainDb.toFixed(2)}dB,${limiter(sound.limit)}`)).loudness;
    if (Math.abs(reached - LOUDNESS) < 0.15) break;
    gainDb += LOUDNESS - reached;
  }
  const filter = `volume=${gainDb.toFixed(2)}dB,${limiter(sound.limit)}`;
  const pcm = await decode(source, sound.from, seconds, filter);
  const loop = makeLoop(pcm, sound.loop, CROSSFADE);
  const peak = peakOf(loop);
  // Two limited peaks meeting in the crossfade add up to at most 0.7 × √2 ≈ 0.99.
  if (peak > 0.995) throw new Error(`${sound.id}: the loop peaks at ${peak.toFixed(3)}; lower its loudness target`);
  mkdirSync(OUT_DIR, { recursive: true });
  const pcmBytes = Buffer.from(loop.buffer, loop.byteOffset, loop.byteLength);
  await run(
    FFMPEG,
    [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-i', '-',
      '-c:a', 'libvorbis', '-q:a', String(QUALITY),
      '-map_metadata', '-1',
      '-metadata', `title=${sound.title} (reading sound loop)`,
      '-metadata', `comment=From ${sound.page} (Creative Commons 0)`,
      target,
    ],
    { input: pcmBytes },
  );
  const result = await measure(target, 0, sound.loop + 1);
  const size = statSync(target).size;
  console.log(
    `${sound.id}: ${sound.loop} s from ${sound.from} s, ${(size / 1048576).toFixed(2)} MB, ${result.loudness.toFixed(1)} LUFS, true peak ${result.truePeak.toFixed(1)} dBTP (source ${measured.toFixed(1)} LUFS, gain ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`,
  );
  if (result.truePeak > -0.5) console.warn(`  warning: ${sound.id} peaks at ${result.truePeak.toFixed(1)} dBTP and may clip at full volume; lower its loudness`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sounds = only.length ? SOUNDS.filter((s) => only.includes(s.id)) : SOUNDS;
  if (only.length && sounds.length !== only.length) throw new Error(`unknown sound id; known: ${SOUNDS.map((s) => s.id).join(', ')}`);
  mkdirSync(WORK_DIR, { recursive: true });
  const files = await download(sounds);
  if (!downloadOnly) {
    // Encoding is CPU-bound and ffmpeg runs on one core per file, so build a few at once.
    await pool(
      sounds.map((s) => () => build(s, files.get(s.id))),
      4,
    );
  }
}
