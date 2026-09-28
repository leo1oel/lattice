//! The on-device sentence embedding provider and vector arithmetic.
//!
//! Vectors are unit-normalized, then stored as int8 (`round(component * 127)`
//! loses far less than the ranking needs) in both the index and the cache.

use super::MAX_EMBEDDING_DIMENSION;

/// int8 range used to quantize unit-normalized components.
const QUANTIZATION_SCALE: f32 = 127.0;

#[derive(Debug)]
pub(super) enum ProviderFailure {
    /// The model cannot run at all on this Mac.
    Unavailable(String),
    /// The model could not embed this particular text.
    Text(String),
}

impl ProviderFailure {
    pub(super) fn detail(&self) -> &str {
        match self {
            Self::Unavailable(detail) | Self::Text(detail) => detail,
        }
    }
}

pub(super) trait LocalEmbeddingProvider {
    fn model_version(&self) -> &str;
    fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure>;
}

pub(super) struct SystemEmbeddingProvider {
    embedding: objc2::rc::Retained<objc2_natural_language::NLEmbedding>,
    model_version: String,
    dimension: usize,
}

impl SystemEmbeddingProvider {
    pub(super) fn load() -> Result<Self, ProviderFailure> {
        use objc2::rc::autoreleasepool;
        use objc2_natural_language::{NLEmbedding, NLLanguageEnglish};

        let unavailable = || {
            ProviderFailure::Unavailable(
                "Apple's English sentence embedding is not available on this Mac.".to_string(),
            )
        };
        autoreleasepool(|_| {
            let language = unsafe { NLLanguageEnglish }.ok_or_else(unavailable)?;
            let embedding = unsafe { NLEmbedding::sentenceEmbeddingForLanguage(language) }
                .ok_or_else(unavailable)?;
            let dimension = unsafe { embedding.dimension() };
            let revision = unsafe { embedding.revision() };
            if dimension == 0 || dimension > MAX_EMBEDDING_DIMENSION {
                return Err(ProviderFailure::Unavailable(
                    "Apple's sentence embedding reported an invalid vector size.".to_string(),
                ));
            }
            Ok(Self {
                embedding,
                model_version: format!("apple-nl-sentence-en-r{revision}"),
                dimension,
            })
        })
    }
}

impl LocalEmbeddingProvider for SystemEmbeddingProvider {
    fn model_version(&self) -> &str {
        &self.model_version
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure> {
        use objc2::rc::autoreleasepool;
        use objc2_foundation::NSString;
        use std::ptr::NonNull;

        autoreleasepool(|_| {
            let input = NSString::from_str(text);
            let mut vector = vec![0.0_f32; self.dimension];
            let output = NonNull::new(vector.as_mut_ptr()).ok_or_else(|| {
                ProviderFailure::Unavailable("Could not allocate an embedding vector.".to_string())
            })?;
            // SAFETY: `output` points to exactly `self.dimension` writable f32s,
            // which is the size reported by this immutable NLEmbedding instance.
            // `input` and the allocation remain alive for the duration of the call.
            if unsafe { self.embedding.getVector_forString(output, &input) } {
                Ok(vector)
            } else {
                Err(ProviderFailure::Text(
                    "Apple's sentence model could not embed this text.".to_string(),
                ))
            }
        })
    }
}

pub(super) fn normalize_vector(mut vector: Vec<f32>) -> Result<Vec<f32>, ProviderFailure> {
    if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
        return Err(ProviderFailure::Text(
            "The sentence model returned an invalid vector.".to_string(),
        ));
    }
    let magnitude =
        vector.iter().map(|value| f64::from(*value) * f64::from(*value)).sum::<f64>().sqrt();
    if !magnitude.is_finite() || magnitude <= f64::EPSILON {
        return Err(ProviderFailure::Text(
            "The sentence model returned an empty vector.".to_string(),
        ));
    }
    for value in &mut vector {
        *value = (f64::from(*value) / magnitude) as f32;
    }
    Ok(vector)
}

/// Unit-normalized components live in [-1, 1], so a symmetric int8 scale keeps
/// the full dynamic range at a quarter of the memory and disk of f32.
pub(super) fn quantize_vector(vector: &[f32]) -> Vec<i8> {
    vector
        .iter()
        .map(|value| {
            (value * QUANTIZATION_SCALE).round().clamp(-QUANTIZATION_SCALE, QUANTIZATION_SCALE)
                as i8
        })
        .collect()
}

/// The query stays in f32: only the stored side is quantized, which halves the
/// quantization error compared with comparing two quantized vectors.
pub(super) fn quantized_score(query: &[f32], stored: &[i8]) -> f32 {
    query.iter().zip(stored).map(|(query, stored)| query * f32::from(*stored)).sum::<f32>()
        / QUANTIZATION_SCALE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantized_scores_track_float_cosine_closely() {
        let left = normalize_vector((0..64).map(|index| (index as f32).sin()).collect()).unwrap();
        let right =
            normalize_vector((0..64).map(|index| (index as f32 * 0.7).cos()).collect()).unwrap();
        let exact = left.iter().zip(&right).map(|(left, right)| left * right).sum::<f32>();
        let approximate = quantized_score(&left, &quantize_vector(&right));
        assert!(
            (exact - approximate).abs() < 0.01,
            "quantized {approximate} drifted from exact {exact}"
        );
        // A vector still scores highest against itself, which is what ranking needs.
        assert!(quantized_score(&left, &quantize_vector(&left)) > approximate);
    }

    /// Manual, model-real benchmark. Run on either supported Mac architecture:
    /// `cargo test --release semantic_search::embedding::tests::apple_sentence_embedding_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore = "requires Apple's on-device English sentence model"]
    fn apple_sentence_embedding_benchmark() {
        let provider = SystemEmbeddingProvider::load().expect("Apple sentence embedding");
        let passages = (0..200)
            .map(|index| {
                format!(
                    "Section {index}. We evaluate a local retrieval method on scientific manuscripts and report reproducible measurements."
                )
            })
            .collect::<Vec<_>>();
        let started = std::time::Instant::now();
        for passage in &passages {
            provider.embed(passage).expect("embed passage");
        }
        let elapsed = started.elapsed().as_secs_f64();
        let count = passages.len();
        eprintln!(
            "Apple NLEmbedding: {count} chunks in {elapsed:.3}s ({:.1} chunks/s)",
            count as f64 / elapsed
        );
    }
}
