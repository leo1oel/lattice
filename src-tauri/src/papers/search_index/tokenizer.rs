//! The paper index's analyzer: jieba word segmentation for runs of Han
//! characters, alphanumeric words for everything else, then lower-casing and
//! English stemming.
//!
//! Indexing segments in jieba's search mode, which emits a compound and its
//! parts (`机器翻译` → `机器`, `翻译`, `机器翻译`); queries segment in the
//! precise mode. So a query for the compound or for one of its parts both
//! find the line, without phrase positions.

use jieba_rs::Jieba;
use std::sync::LazyLock;
use tantivy::tokenizer::{
    Language, LowerCaser, RemoveLongFilter, Stemmer, TextAnalyzer, Token, TokenStream, Tokenizer,
};

/// Loaded on the first Han run any analyzer meets (~50 ms), so a library
/// with no Chinese never pays for the dictionary.
static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);

/// Longer tokens are URLs, hashes or base64, never words a writer searches.
const MAX_TOKEN_BYTES: usize = 40;

fn is_han(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'
            | '\u{20000}'..='\u{2ebef}'
    )
}

#[derive(Clone)]
struct MixedTokenizer {
    search_mode: bool,
    tokens: Vec<Token>,
}

struct MixedTokenStream<'a> {
    tokens: &'a mut Vec<Token>,
    cursor: usize,
}

impl Tokenizer for MixedTokenizer {
    type TokenStream<'a> = MixedTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> MixedTokenStream<'a> {
        self.tokens.clear();
        let mut chars = text.char_indices().peekable();
        while let Some((start, character)) = chars.next() {
            let han = is_han(character);
            if !han && !character.is_alphanumeric() {
                continue;
            }
            let mut end = start + character.len_utf8();
            while let Some(&(offset, next)) = chars.peek() {
                let same_run =
                    if han { is_han(next) } else { next.is_alphanumeric() && !is_han(next) };
                if !same_run {
                    break;
                }
                end = offset + next.len_utf8();
                chars.next();
            }
            if han {
                self.push_han_run(text, start, end);
            } else {
                push(&mut self.tokens, text, start, end);
            }
        }
        MixedTokenStream { tokens: &mut self.tokens, cursor: 0 }
    }
}

impl MixedTokenizer {
    fn push_han_run(&mut self, text: &str, start: usize, end: usize) {
        let run = &text[start..end];
        // jieba reports character offsets; tantivy wants byte offsets.
        let byte_at: Vec<usize> = run.char_indices().map(|(at, _)| at).chain([run.len()]).collect();
        let words =
            if self.search_mode { JIEBA.cut_for_search(run, true) } else { JIEBA.cut(run, true) };
        for word in words {
            push(&mut self.tokens, text, start + byte_at[word.start], start + byte_at[word.end]);
        }
    }
}

fn push(tokens: &mut Vec<Token>, text: &str, from: usize, to: usize) {
    tokens.push(Token {
        offset_from: from,
        offset_to: to,
        position: tokens.len(),
        text: text[from..to].to_string(),
        position_length: 1,
    });
}

impl TokenStream for MixedTokenStream<'_> {
    fn advance(&mut self) -> bool {
        self.cursor += 1;
        self.cursor <= self.tokens.len()
    }

    fn token(&self) -> &Token {
        &self.tokens[self.cursor - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.cursor - 1]
    }
}

fn analyzer(search_mode: bool) -> TextAnalyzer {
    TextAnalyzer::builder(MixedTokenizer { search_mode, tokens: Vec::new() })
        .filter(RemoveLongFilter::limit(MAX_TOKEN_BYTES))
        .filter(LowerCaser)
        .filter(Stemmer::new(Language::English))
        .build()
}

/// What the index's text field is analyzed with.
pub(super) fn index_analyzer() -> TextAnalyzer {
    analyzer(true)
}

/// What a query is analyzed with.
pub(super) fn query_analyzer() -> TextAnalyzer {
    analyzer(false)
}

/// Each token's text and byte range, as `analyzer` produces them.
pub(super) fn tokens(analyzer: &mut TextAnalyzer, text: &str) -> Vec<(String, usize, usize)> {
    let mut stream = analyzer.token_stream(text);
    let mut tokens = Vec::new();
    while stream.advance() {
        let token = stream.token();
        tokens.push((token.text.clone(), token.offset_from, token.offset_to));
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(analyzer: &mut TextAnalyzer, text: &str) -> Vec<String> {
        tokens(analyzer, text).into_iter().map(|(text, _, _)| text).collect()
    }

    #[test]
    fn segments_chinese_and_stems_english_in_one_line() {
        let mut query = query_analyzer();
        assert_eq!(
            texts(&mut query, "Low-Rank 适配的机器翻译 models"),
            ["low", "rank", "适配", "的", "机器翻译", "model"]
        );
        // Indexing also emits the compound's parts, each over its own bytes.
        let mut index = index_analyzer();
        let line = "机器翻译";
        let indexed = tokens(&mut index, line);
        let parts: Vec<&str> = indexed.iter().map(|(_, from, to)| &line[*from..*to]).collect();
        assert_eq!(parts, ["机器", "翻译", "机器翻译"]);
    }
}
