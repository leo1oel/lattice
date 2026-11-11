//! Durations, spring curves and the motion tiers that pair them.
//!
//! Generated from design-system/tokens.json by src/tokens_codegen.rs. Do not
//! edit: change Paper, re-export design-system/, then run
//! `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
//! The test `generated_tokens_match_the_design_system` fails while these files
//! and the JSON disagree.

use std::time::Duration;

use crate::token_types::{Ease, MotionToken};

// Durations

/// App: `--duration-fast`.
pub const DURATION_FAST: Duration = Duration::from_millis(80);
/// App: `--duration-moderate`.
pub const DURATION_MODERATE: Duration = Duration::from_millis(160);
/// App: `--duration-slow`.
pub const DURATION_SLOW: Duration = Duration::from_millis(240);
/// App: `--duration-pop`.
pub const DURATION_POP: Duration = Duration::from_millis(220);
/// App: `--duration-fast-exit`.
pub const DURATION_FAST_EXIT: Duration = Duration::from_millis(60);
/// App: `--duration-moderate-exit`.
pub const DURATION_MODERATE_EXIT: Duration = Duration::from_millis(120);
/// App: `--duration-slow-exit`.
pub const DURATION_SLOW_EXIT: Duration = Duration::from_millis(160);
/// App: `--duration-pop-exit`.
pub const DURATION_POP_EXIT: Duration = Duration::from_millis(120);
/// App: `--duration-stagger`.
pub const DURATION_STAGGER: Duration = Duration::from_millis(40);
/// App: `--duration-draw`.
pub const DURATION_DRAW: Duration = Duration::from_millis(560);
/// App: `--duration-flourish`.
pub const DURATION_FLOURISH: Duration = Duration::from_millis(720);
/// App: `--duration-linger`.
pub const DURATION_LINGER: Duration = Duration::from_millis(1600);

// Easing

/// App: `--ease-fast`.
pub const EASE_FAST: Ease = Ease::Linear(&[0.0, 0.321, 0.671, 0.86, 0.944, 0.979, 0.992, 0.997, 1.0]);
/// App: `--ease-moderate`.
pub const EASE_MODERATE: Ease = Ease::Linear(&[0.0, 0.114, 0.321, 0.516, 0.671, 0.783, 0.86, 0.911, 0.944, 0.966, 0.979, 0.987, 0.992, 0.995, 0.997, 0.998, 1.0]);
/// App: `--ease-slow`.
pub const EASE_SLOW: Ease = Ease::Linear(&[0.0, 0.052, 0.168, 0.307, 0.446, 0.572, 0.68, 0.767, 0.835, 0.887, 0.925, 0.953, 0.972, 0.985, 0.993, 0.998, 1.001, 1.002, 1.003, 1.003, 1.003, 1.002, 1.002, 1.001, 1.0]);
/// App: `--ease-pop`.
pub const EASE_POP: Ease = Ease::Linear(&[0.0, 0.067, 0.215, 0.387, 0.55, 0.69, 0.8, 0.881, 0.938, 0.975, 0.997, 1.009, 1.014, 1.015, 1.014, 1.011, 1.009, 1.006, 1.004, 1.003, 1.002, 1.001, 1.0]);
/// Fallback curve where linear() is unsupported
///
/// App: `--ease-fast`.
pub const EASE_FAST_CUBIC: Ease = Ease::CubicBezier(0.25, 0.85, 0.35, 1.0);
/// Fallback curve where linear() is unsupported
///
/// App: `--ease-moderate`.
pub const EASE_MODERATE_CUBIC: Ease = Ease::CubicBezier(0.25, 0.85, 0.35, 1.0);
/// Fallback curve where linear() is unsupported
///
/// App: `--ease-slow`.
pub const EASE_SLOW_CUBIC: Ease = Ease::CubicBezier(0.3, 0.8, 0.3, 1.02);
/// Fallback curve where linear() is unsupported
///
/// App: `--ease-pop`.
pub const EASE_POP_CUBIC: Ease = Ease::CubicBezier(0.3, 0.85, 0.3, 1.04);
/// App: `--ease-exit`.
pub const EASE_EXIT: Ease = Ease::EaseOut;

// Motion: duration and curve together

/// App: `--motion-fast`.
pub const MOTION_FAST: MotionToken = MotionToken::new(DURATION_FAST, EASE_FAST);
/// App: `--motion-moderate`.
pub const MOTION_MODERATE: MotionToken = MotionToken::new(DURATION_MODERATE, EASE_MODERATE);
/// App: `--motion-slow`.
pub const MOTION_SLOW: MotionToken = MotionToken::new(DURATION_SLOW, EASE_SLOW);
/// App: `--motion-pop`.
pub const MOTION_POP: MotionToken = MotionToken::new(DURATION_POP, EASE_POP);
/// App: `--motion-fast-exit`.
pub const MOTION_FAST_EXIT: MotionToken = MotionToken::new(DURATION_FAST_EXIT, EASE_EXIT);
/// App: `--motion-moderate-exit`.
pub const MOTION_MODERATE_EXIT: MotionToken = MotionToken::new(DURATION_MODERATE_EXIT, EASE_EXIT);
/// App: `--motion-slow-exit`.
pub const MOTION_SLOW_EXIT: MotionToken = MotionToken::new(DURATION_SLOW_EXIT, EASE_EXIT);
/// App: `--motion-pop-exit`.
pub const MOTION_POP_EXIT: MotionToken = MotionToken::new(DURATION_POP_EXIT, EASE_EXIT);
/// App: `--motion-draw`.
pub const MOTION_DRAW: MotionToken = MotionToken::new(DURATION_DRAW, EASE_MODERATE);
/// App: `--motion-flourish`.
pub const MOTION_FLOURISH: MotionToken = MotionToken::new(DURATION_FLOURISH, EASE_MODERATE);
/// App: `--motion-linger`.
pub const MOTION_LINGER: MotionToken = MotionToken::new(DURATION_LINGER, EASE_EXIT);
