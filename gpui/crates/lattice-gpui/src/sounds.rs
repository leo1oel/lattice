//! Interface sounds (Settings › Appearance › Interface sounds), as the Tauri
//! app plays them (`src/telemetry/interface-sounds.ts`): two cues, and only
//! when an operation the writer asked for has finished. A build they asked
//! for (the Build chip, ⌘B / ⌘S, the palette, a clean rebuild) ends in
//! `ready` or `error`, and a notice that showed a running operation settling
//! into success or failure plays the matching one. Routine clicks,
//! navigation, editing and automatic builds stay silent.
//!
//! The Tauri app's cues are not recordings: Cuelume (`node_modules/cuelume`,
//! MIT, `LICENSE-CUELUME` beside this crate's manifest) synthesizes each one
//! live with Web Audio. They are synthesized the
//! same way here, from the same two recipes and through the same graph,
//! then played as a short 16-bit WAV: on macOS through `NSSound`, on Windows
//! through `PlaySound`. The graph, per Cuelume's `engine.js`:
//!
//! - each layer is a tone (sine or triangle, gliding exponentially when the
//!   recipe says so) or white noise through a biquad, under an envelope that
//!   rises exponentially from 0.0001 to its peak over the attack and falls
//!   back to 0.0001 over the decay;
//! - the layers sum into the recipe's master gain (times the volume, which
//!   Lattice sets to 0.5), with the shimmer, a delay whose lowpassed output
//!   feeds back into itself, sent from the master and mixed back in;
//! - all of it goes through Cuelume's output gain (4) and its limiter, Web
//!   Audio's dynamics compressor (threshold −8 dB, knee 6, ratio 12, attack
//!   2 ms, release 80 ms) with the compressor's own make-up gain.
//!
//! A scripted run renders the cue and records it without playing it, so a
//! scenario can check what would have been heard without making a sound.

use std::f32::consts::PI;

use gpui::{App, Global};

/// What happened, as the Tauri app names it (`InterfaceSoundCue`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    /// Cuelume's `ready`: a quick lock-on sweep resolving to a clear tone.
    Success,
    /// Cuelume's `error`: a muted knock and two descending tones.
    Error,
}

/// Lattice's volume for every cue (`setVolume(0.5)`).
const VOLUME: f32 = 0.5;
const SAMPLE_RATE: u32 = 48_000;
/// Cuelume's padding after a layer's envelope before its source stops.
const SOURCE_STOP_PADDING: f32 = 0.05;
const INAUDIBLE_GAIN: f32 = 0.001;
const OUTPUT_GAIN: f32 = 4.;
/// Where an exponential envelope starts and ends.
const SILENT: f32 = 0.0001;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
}

#[derive(Clone, Copy)]
enum Filter {
    /// Web Audio's lowpass, whose Q is a resonance in dB.
    Lowpass,
    /// Web Audio's bandpass, whose Q is linear.
    Bandpass,
}

#[derive(Clone, Copy)]
enum Source {
    Tone {
        wave: Wave,
        frequency: f32,
        /// The frequency it glides to, and over how long.
        glide: Option<(f32, f32)>,
    },
    Noise {
        filter: Filter,
        frequency: f32,
        q: f32,
    },
}

#[derive(Clone, Copy)]
struct Layer {
    source: Source,
    offset: f32,
    attack: f32,
    decay: f32,
    peak: f32,
}

#[derive(Clone, Copy)]
struct Shimmer {
    delay: f32,
    feedback: f32,
    wet: f32,
    lowpass: f32,
}

struct Recipe {
    master_gain: f32,
    layers: &'static [Layer],
    shimmer: Option<Shimmer>,
}

const fn tone(wave: Wave, frequency: f32, glide: Option<(f32, f32)>) -> Source {
    Source::Tone {
        wave,
        frequency,
        glide,
    }
}

const fn noise(filter: Filter, frequency: f32, q: f32) -> Source {
    Source::Noise {
        filter,
        frequency,
        q,
    }
}

const fn layer(source: Source, offset: f32, attack: f32, decay: f32, peak: f32) -> Layer {
    Layer {
        source,
        offset,
        attack,
        decay,
        peak,
    }
}

/// Cuelume's `ready`, as `recipes.js` writes it.
const READY: Recipe = Recipe {
    master_gain: 0.48,
    layers: &[
        layer(noise(Filter::Bandpass, 3600., 1.8), 0., 0.001, 0.02, 0.11),
        layer(
            tone(Wave::Triangle, 330., Some((660., 0.12))),
            0.012,
            0.004,
            0.16,
            0.055,
        ),
        layer(tone(Wave::Sine, 990., None), 0.13, 0.004, 0.22, 0.06),
    ],
    shimmer: Some(Shimmer {
        delay: 0.1,
        feedback: 0.16,
        wet: 0.1,
        lowpass: 4200.,
    }),
};

/// Cuelume's `error`.
const ERROR: Recipe = Recipe {
    master_gain: 0.42,
    layers: &[
        layer(noise(Filter::Bandpass, 850., 1.1), 0., 0.001, 0.035, 0.13),
        layer(tone(Wave::Triangle, 440., None), 0.025, 0.004, 0.09, 0.045),
        layer(tone(Wave::Triangle, 349.23, None), 0.1, 0.004, 0.14, 0.04),
    ],
    shimmer: None,
};

impl Cue {
    fn recipe(self) -> &'static Recipe {
        match self {
            Cue::Success => &READY,
            Cue::Error => &ERROR,
        }
    }
}

/// A biquad as Web Audio computes its coefficients (the Audio EQ Cookbook).
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn new(filter: Filter, frequency: f32, q: f32) -> Self {
        let w0 = 2. * PI * frequency / SAMPLE_RATE as f32;
        let (sin, cos) = w0.sin_cos();
        let (b, a0, a) = match filter {
            Filter::Lowpass => {
                let alpha = sin / (2. * 10f32.powf(q / 20.));
                (
                    [(1. - cos) / 2., 1. - cos, (1. - cos) / 2.],
                    1. + alpha,
                    [-2. * cos, 1. - alpha],
                )
            }
            Filter::Bandpass => {
                let alpha = sin / (2. * q);
                ([alpha, 0., -alpha], 1. + alpha, [-2. * cos, 1. - alpha])
            }
        };
        Self {
            b: b.map(|b| b / a0),
            a: a.map(|a| a / a0),
            x: [0.; 2],
            y: [0.; 2],
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// An exponential ramp's value `t` seconds in, from `from` to `to` over
/// `length` (Web Audio's `exponentialRampToValueAtTime`).
fn ramp(from: f32, to: f32, t: f32, length: f32) -> f32 {
    from * (to / from).powf((t / length).clamp(0., 1.))
}

/// A layer's envelope `t` seconds after it starts.
fn envelope(layer: &Layer, t: f32) -> f32 {
    if t < layer.attack {
        ramp(SILENT, layer.peak, t, layer.attack)
    } else {
        ramp(layer.peak, SILENT, t - layer.attack, layer.decay)
    }
}

/// A small, fast noise source; the noise only has to be white.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        // xorshift32
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f32 / u32::MAX as f32 * 2. - 1.
    }
}

/// One layer's samples, into `out` from its offset.
fn render_layer(layer: &Layer, out: &mut [f32], seed: u32) {
    let rate = SAMPLE_RATE as f32;
    let start = (layer.offset * rate).round() as usize;
    let length = ((layer.attack + layer.decay + SOURCE_STOP_PADDING) * rate).ceil() as usize;
    let mut phase = 0f32;
    let mut noise = Noise(seed.max(1));
    let mut filter = match layer.source {
        Source::Noise {
            filter,
            frequency,
            q,
        } => Some(Biquad::new(filter, frequency, q)),
        Source::Tone { .. } => None,
    };
    for (n, sample) in out.iter_mut().skip(start).take(length).enumerate() {
        let t = n as f32 / rate;
        let value = match layer.source {
            Source::Tone {
                wave,
                frequency,
                glide,
            } => {
                let frequency = match glide {
                    Some((to, time)) => ramp(frequency, to, t, time),
                    None => frequency,
                };
                // Both start at zero, rising, as Web Audio's periodic waves do.
                let value = match wave {
                    Wave::Sine => (2. * PI * phase).sin(),
                    Wave::Triangle => 1. - 4. * ((phase + 0.25).fract() - 0.5).abs(),
                };
                phase = (phase + frequency / rate).fract();
                value
            }
            Source::Noise { .. } => {
                let white = noise.next();
                filter
                    .as_mut()
                    .map_or(white, |filter| filter.process(white))
            }
        };
        *sample += value * envelope(layer, t);
    }
}

/// How long the shimmer rings on after the sources stop (`shimmerTail`).
fn shimmer_tail(shimmer: Option<Shimmer>) -> f32 {
    match shimmer {
        Some(shimmer) if shimmer.feedback > 0. => {
            if shimmer.feedback >= 1. {
                shimmer.delay
            } else {
                shimmer.delay * (1. + (INAUDIBLE_GAIN.ln() / shimmer.feedback.ln()).ceil())
            }
        }
        _ => 0.,
    }
}

/// Web Audio's dynamics compressor as Cuelume configures it, with the
/// make-up gain Chromium and WebKit apply: the full-range gain's inverse to
/// the 0.6.
struct Limiter {
    envelope_db: f32,
    attack: f32,
    release: f32,
    makeup: f32,
}

impl Limiter {
    const THRESHOLD: f32 = -8.;
    const KNEE: f32 = 6.;
    const RATIO: f32 = 12.;

    fn new() -> Self {
        let rate = SAMPLE_RATE as f32;
        let coefficient = |seconds: f32| (-1. / (seconds * rate)).exp();
        let full_range = Self::curve(0.);
        Self {
            envelope_db: -120.,
            attack: coefficient(0.002),
            release: coefficient(0.08),
            makeup: 10f32.powf(-full_range * 0.6 / 20.),
        }
    }

    /// The compressor's static curve: the level out for a level in, in dB,
    /// its knee starting at the threshold.
    fn curve(level: f32) -> f32 {
        let (threshold, knee, slope) = (Self::THRESHOLD, Self::KNEE, 1. / Self::RATIO);
        if level <= threshold {
            level
        } else if level <= threshold + knee {
            let over = level - threshold;
            level + (slope - 1.) * over * over / (2. * knee)
        } else {
            let top = threshold + knee + (slope - 1.) * knee / 2.;
            top + (level - threshold - knee) * slope
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let level = 20. * x.abs().max(1e-6).log10();
        let coefficient = if level > self.envelope_db {
            self.attack
        } else {
            self.release
        };
        self.envelope_db = level + coefficient * (self.envelope_db - level);
        let gain_db = Self::curve(self.envelope_db) - self.envelope_db;
        x * 10f32.powf(gain_db / 20.) * self.makeup
    }
}

/// The cue's samples at [`SAMPLE_RATE`], mono, as the speakers get them.
pub fn render(cue: Cue, seed: u32) -> Vec<f32> {
    let recipe = cue.recipe();
    let rate = SAMPLE_RATE as f32;
    let sources = recipe
        .layers
        .iter()
        .map(|layer| layer.offset + layer.attack + layer.decay + SOURCE_STOP_PADDING)
        .fold(0f32, f32::max);
    let length = ((sources + shimmer_tail(recipe.shimmer) + 0.05) * rate).ceil() as usize;

    let mut master = vec![0f32; length];
    for (ix, layer) in recipe.layers.iter().enumerate() {
        render_layer(layer, &mut master, seed.wrapping_add(ix as u32 * 7919));
    }
    let gain = recipe.master_gain * VOLUME;
    for sample in &mut master {
        *sample *= gain;
    }

    // The shimmer: the master into a delay, whose lowpassed output feeds back
    // into it and, at `wet`, into the output beside the master.
    let mut out = master.clone();
    if let Some(shimmer) = recipe.shimmer {
        let delay = (shimmer.delay * rate).round() as usize;
        let mut lowpass = Biquad::new(Filter::Lowpass, shimmer.lowpass, 1.);
        let mut line = vec![0f32; length];
        for n in 0..length {
            let delayed = if n >= delay { line[n - delay] } else { 0. };
            let filtered = lowpass.process(delayed);
            line[n] = master[n] + filtered * shimmer.feedback;
            out[n] += filtered * shimmer.wet;
        }
    }

    let mut limiter = Limiter::new();
    out.into_iter()
        .map(|sample| limiter.process(sample * OUTPUT_GAIN))
        .collect()
}

/// `samples` as a 16-bit mono WAV file.
fn wav(samples: &[f32]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1., 1.) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// The cues a scripted run would have played, in order.
#[derive(Default)]
pub struct Played(pub Vec<(Cue, f32)>);

impl Global for Played {}

/// Play `cue`, if the writer has interface sounds on. Optional feedback
/// never fails what it reports: a cue that cannot play is dropped.
pub fn play(cue: Cue, cx: &mut App) {
    if !crate::settings::get(cx).appearance.interface_sounds {
        return;
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(1, |now| now.subsec_nanos());
    let samples = render(cue, seed);
    if crate::settings::scripted(cx) {
        let peak = samples.iter().fold(0f32, |peak, s| peak.max(s.abs()));
        cx.default_global::<Played>().0.push((cue, peak));
        return;
    }
    platform::play(wav(&samples));
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use objc2::{class, msg_send, runtime::AnyObject};

    thread_local! {
        /// The sounds playing, kept until they are done: `NSSound` plays
        /// asynchronously and stops if released.
        static PLAYING: RefCell<Vec<*mut AnyObject>> = const { RefCell::new(Vec::new()) };
    }

    pub fn play(wav: Vec<u8>) {
        unsafe {
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: wav.as_ptr().cast::<std::ffi::c_void>(),
                length: wav.len()
            ];
            if data.is_null() {
                return;
            }
            let sound: *mut AnyObject = msg_send![class!(NSSound), alloc];
            let sound: *mut AnyObject = msg_send![sound, initWithData: data];
            if sound.is_null() {
                return;
            }
            let _: bool = msg_send![sound, play];
            PLAYING.with_borrow_mut(|playing| {
                // A cue lasts under a second; let go of the ones done since.
                playing.retain(|&old| {
                    let still: bool = msg_send![old, isPlaying];
                    if !still {
                        let _: () = msg_send![old, release];
                    }
                    still
                });
                playing.push(sound);
            });
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::Mutex;

    use windows::{
        Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT, SND_PURGE},
        core::PCWSTR,
    };

    /// The sound playing: `PlaySound` reads it from memory while it plays.
    static PLAYING: Mutex<Vec<u8>> = Mutex::new(Vec::new());

    pub fn play(wav: Vec<u8>) {
        let Ok(mut playing) = PLAYING.lock() else {
            return;
        };
        unsafe {
            let _ = PlaySoundW(PCWSTR::null(), None, SND_PURGE);
        }
        *playing = wav;
        unsafe {
            let _ = PlaySoundW(
                PCWSTR(playing.as_ptr().cast()),
                None,
                SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn play(_: Vec<u8>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn each_cue_lasts_as_long_as_its_recipe_and_its_shimmer() {
        let ready = render(Cue::Success, 1);
        // The sweep's last tone ends 0.13 + 0.004 + 0.22 + 0.05 s in, and the
        // shimmer (feedback 0.16) rings five more 0.1 s delays.
        let expected =
            (0.404 + 0.1 * (1. + (0.001f32.ln() / 0.16f32.ln()).ceil()) + 0.05) * 48_000.;
        // Within a sample: the render sums its seconds in another order.
        let close = |samples: usize, at: f32| samples.abs_diff(at.ceil() as usize) <= 1;
        assert!(close(ready.len(), expected), "{}", ready.len());
        let error = render(Cue::Error, 1);
        let expected = (0.1 + 0.144 + 0.05 + 0.05) * 48_000f32;
        assert!(close(error.len(), expected), "{}", error.len());
    }

    #[test]
    fn the_cues_are_audible_soft_and_never_clip() {
        for cue in [Cue::Success, Cue::Error] {
            let samples = render(cue, 7);
            let peak = samples.iter().fold(0f32, |peak, s| peak.max(s.abs()));
            assert!(peak > 0.05 && peak < 0.6, "{cue:?} peaks at {peak}");
            assert!(rms(&samples) > 0.005, "{cue:?} is silent");
        }
    }

    #[test]
    fn ready_rises_and_error_falls() {
        // `ready` resolves upward to 990 Hz; `error` steps down from 440 Hz
        // to 349 Hz: its second half is lower than its first.
        let zero_crossings = |samples: &[f32]| {
            samples
                .windows(2)
                .filter(|pair| pair[0] <= 0. && pair[1] > 0.)
                .count()
        };
        let error = render(Cue::Error, 3);
        let at = |seconds: f32| (seconds * 48_000.) as usize;
        let first = zero_crossings(&error[at(0.05)..at(0.1)]);
        let second = zero_crossings(&error[at(0.15)..at(0.2)]);
        assert!(second < first, "{first} then {second}");
        let ready = render(Cue::Success, 3);
        let early = zero_crossings(&ready[at(0.02)..at(0.07)]);
        let late = zero_crossings(&ready[at(0.2)..at(0.25)]);
        assert!(late > early * 2, "{early} then {late}");
    }

    #[test]
    fn the_wav_is_16_bit_mono_at_48_khz() {
        let samples = render(Cue::Error, 1);
        let file = wav(&samples);
        assert_eq!(&file[0..4], b"RIFF");
        assert_eq!(&file[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(file[24..28].try_into().unwrap()), 48_000);
        assert_eq!(file.len(), 44 + samples.len() * 2);
    }
}
