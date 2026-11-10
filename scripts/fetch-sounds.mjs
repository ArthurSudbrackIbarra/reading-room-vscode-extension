// Builds the reading sounds (media/sounds/*.ogg) from short sections of two long YouTube videos:
// downloads each section, cuts a few minutes out of it, crossfades the end into the start so the
// file loops without a seam, evens out the loudness and encodes it as Ogg Vorbis (VS Code's
// webviews play Vorbis, MP3, FLAC and WAV, but not Opus or AAC).
//
// The recordings belong to their YouTube channels (standard YouTube license), so the generated
// files are kept out of git (.gitignore) and only end up in the .vsix you build yourself.
//
// Needs yt-dlp and an ffmpeg with libvorbis, on PATH or given through the YT_DLP / FFMPEG
// environment variables. Downloads are cached in SOUNDS_WORK_DIR (default: a folder in the
// system temp directory), so running the script again only re-encodes.
//
// Usage: npm run sounds [-- --force]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(root, 'media', 'sounds');
const WORK_DIR = process.env.SOUNDS_WORK_DIR || join(tmpdir(), 'markdown-pdf-viewer-sounds');
const YT_DLP = process.env.YT_DLP || 'yt-dlp';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const force = process.argv.includes('--force');

const RATE = 48_000;
/**
 * The limiter's ceiling (about -3 dBFS): it catches the peaks the gain pushes up (a fireplace's
 * crackles stand some 38 dB above its average level) and leaves room for the Vorbis encoder, which
 * adds a little to sharp peaks. The fast release (20 ms) keeps the quiet sound between crackles
 * from dipping after each one.
 */
const LIMITER = 'alimiter=limit=0.7:attack=1:release=20:level=false:latency=true';

/**
 * from:      where the downloaded section starts in the video (seconds)
 * offset:    seconds skipped at the start of the section (cut artifacts)
 * loop:      length of the finished loop (seconds)
 * crossfade: seconds of the section's end blended into its start
 * loudness:  integrated loudness of the loop (LUFS), i.e. how loud it is at full volume. All the
 *            loops share one level, so switching sounds keeps the loudness.
 * quality:   Vorbis VBR quality (3 is about 112 kbit/s)
 */
const SOUNDS = [
  {
    id: 'rain',
    title: 'Rain Sound On Window with Thunder SoundsㅣHeavy Rain for Sleep, Study and Relaxation, Meditation (Relaxing Ambience ASMR)',
    url: 'https://www.youtube.com/watch?v=mPZkdNFkNps',
    from: 93,
    offset: 1,
    loop: 240,
    crossfade: 8,
    loudness: -16,
    quality: 3,
  },
  {
    id: 'fireplace',
    title: '12 HOURS of Relaxing Fireplace Sounds - Burning Fireplace & Crackling Fire Sounds (NO MUSIC) (Cat Trumpet)',
    url: 'https://www.youtube.com/watch?v=UgHKb_7884o',
    from: 33307,
    offset: 1,
    loop: 240,
    crossfade: 8,
    loudness: -16,
    quality: 3,
  },
];

function run(cmd, args, { input, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error(`${cmd} was not found. Install it or set the ${cmd === YT_DLP ? 'YT_DLP' : 'FFMPEG'} environment variable.`) : e),
    );
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

/** Downloads the section of the video the loop is cut from (cached between runs). */
async function download(sound) {
  const seconds = sound.offset + sound.loop + sound.crossfade + 2;
  const file = join(WORK_DIR, `${sound.id}-${sound.from}-${seconds}.webm`);
  if (existsSync(file) && statSync(file).size > 0) return file;
  console.log(`  downloading ${seconds} s of ${sound.url} from ${sound.from} s…`);
  const ffmpegLocation = FFMPEG.includes('/') || FFMPEG.includes('\\') ? ['--ffmpeg-location', FFMPEG] : [];
  await run(YT_DLP, [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--js-runtimes',
    `node:${process.execPath}`,
    ...ffmpegLocation,
    '-f',
    'bestaudio[ext=webm]/bestaudio',
    '--download-sections',
    `*${sound.from}-${sound.from + seconds}`,
    '-o',
    file,
    sound.url,
  ]);
  if (!existsSync(file)) throw new Error(`yt-dlp did not write ${file}`);
  return file;
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

async function build(sound) {
  const target = join(OUT_DIR, `${sound.id}.ogg`);
  if (existsSync(target) && !force) {
    console.log(`${sound.id}: ${target} exists (use --force to rebuild)`);
    return;
  }
  console.log(`${sound.id}: ${sound.title}`);
  const source = await download(sound);
  const seconds = sound.loop + sound.crossfade;
  const measured = (await measure(source, sound.offset, seconds)).loudness;
  // The limiter takes some loudness away (most from spiky sounds such as crackles), so adjust the
  // gain until the limited audio reaches the target.
  let gainDb = sound.loudness - measured;
  for (let i = 0; i < 4; i++) {
    const reached = (await measure(source, sound.offset, seconds, `volume=${gainDb.toFixed(2)}dB,${LIMITER}`)).loudness;
    if (Math.abs(reached - sound.loudness) < 0.15) break;
    gainDb += sound.loudness - reached;
  }
  const filter = `volume=${gainDb.toFixed(2)}dB,${LIMITER}`;
  const pcm = await decode(source, sound.offset, seconds, filter);
  const loop = makeLoop(pcm, sound.loop, sound.crossfade);
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
      '-c:a', 'libvorbis', '-q:a', String(sound.quality),
      '-map_metadata', '-1', '-metadata', `title=${sound.id} (reading sound loop)`,
      target,
    ],
    { input: pcmBytes },
  );
  const result = await measure(target, 0, sound.loop + 1);
  const size = statSync(target).size;
  console.log(
    `  ${target}: ${sound.loop} s loop, ${(size / 1048576).toFixed(2)} MB, ${result.loudness.toFixed(1)} LUFS, true peak ${result.truePeak.toFixed(1)} dBTP (source ${measured.toFixed(1)} LUFS, gain ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`,
  );
  if (result.truePeak > -0.5) console.warn(`  warning: ${sound.id} peaks at ${result.truePeak.toFixed(1)} dBTP and may clip at full volume; lower its loudness`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(WORK_DIR, { recursive: true });
  for (const sound of SOUNDS) await build(sound);
}
