use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// Features of one prompt, computed on this computer. The prompt text itself is
/// dropped as soon as these are computed; only counts, flags and word hashes remain.
pub struct PromptInfo {
    pub chars: usize,
    pub words: usize,
    pub images: usize,
    /// Count of concrete references: file names, paths, identifiers, numbers, code.
    pub specific: u32,
    /// The prompt reports what happened when the human tried something.
    pub observation: bool,
    /// Short, generic prompts like "continue" or "fix it".
    pub generic: bool,
    word_hashes: HashSet<u64>,
}

const GENERIC: &[&str] = &[
    "continue", "go", "go on", "go ahead", "yes", "y", "yep", "yeah", "ok", "okay", "k",
    "do it", "fix it", "fix", "fix this", "keep going", "proceed", "try again", "again",
    "next", "sure", "lgtm", "looks good", "retry", "more", "same", "please", "pls",
];

const OBSERVATION: &[&str] = &[
    "when i", "it shows", "it says", "doesn't", "doesnt", "does not", "didn't", "didnt",
    "not working", "isn't", "isnt", "broken", "broke", "i clicked", "i tried", "i see",
    "i get", "i got", "instead of", "still", "now it", "works now", "it works", "crash",
    "error", "fails", "failed", "freez", "stuck", "wrong", "nothing happens", "blank",
    "undefined", "exception", "traceback", "warning", "bug", "glitch", "flicker", "lag",
];

impl PromptInfo {
    pub fn analyze(text: &str, images: usize) -> Self {
        let lower = text.to_lowercase();
        let normalized: String = lower
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
            .collect();
        let norm_words: Vec<&str> = normalized.split_whitespace().collect();
        let joined = norm_words.join(" ");

        let mut specific = text.split_whitespace().filter(|w| is_specific(w)).count() as u32;
        if text.contains('`') {
            specific += 1;
        }
        if text.lines().filter(|l| !l.trim().is_empty()).count() > 3 {
            specific += 1;
        }
        let observation = images > 0 || OBSERVATION.iter().any(|p| lower.contains(p));
        let generic = images == 0
            && (GENERIC.contains(&joined.as_str())
                || (norm_words.len() <= 3 && specific == 0 && !observation));

        Self {
            chars: text.chars().count(),
            words: text.split_whitespace().count(),
            images,
            specific,
            observation,
            generic,
            word_hashes: norm_words.iter().filter(|w| w.len() > 2).map(|w| hash(w)).collect(),
        }
    }

    /// Rough time to type the prompt, at about 48 words per minute.
    pub fn typing_secs(&self) -> i64 {
        ((self.chars as f64) / 4.0).round().clamp(5.0, 300.0) as i64
    }

    /// Word-overlap similarity (0 to 1) with another prompt.
    pub fn similarity(&self, other: &Self) -> f64 {
        if self.word_hashes.is_empty() || other.word_hashes.is_empty() {
            return 0.0;
        }
        let shared = self.word_hashes.intersection(&other.word_hashes).count() as f64;
        let total = self.word_hashes.union(&other.word_hashes).count() as f64;
        shared / total
    }
}

fn hash(word: &str) -> u64 {
    let mut h = DefaultHasher::new();
    word.hash(&mut h);
    h.finish()
}

fn is_specific(raw: &str) -> bool {
    let w = raw
        .trim_matches(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '/' | '.' | ':' | '(' | ')')))
        .trim_end_matches('.');
    if w.chars().count() < 2 {
        return false;
    }
    let digit = w.chars().any(|c| c.is_ascii_digit());
    let path = w.contains('/') || has_extension(w);
    let ident = w.contains('_') || w.contains("::") || w.ends_with("()") || is_camel(w);
    digit || path || ident
}

fn has_extension(w: &str) -> bool {
    match w.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && ext.chars().any(|c| c.is_ascii_alphabetic())
        }
        None => false,
    }
}

fn is_camel(w: &str) -> bool {
    let cs: Vec<char> = w.chars().collect();
    cs.windows(2).any(|p| p[0].is_lowercase() && p[1].is_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_prompts() {
        assert!(PromptInfo::analyze("continue", 0).generic);
        assert!(PromptInfo::analyze("Fix it.", 0).generic);
        assert!(!PromptInfo::analyze("the jump in player.rs feels floaty, lower gravity to 20", 0).generic);
    }

    #[test]
    fn observations() {
        assert!(PromptInfo::analyze("when i click play nothing happens", 0).observation);
        assert!(PromptInfo::analyze("", 1).observation);
        assert!(!PromptInfo::analyze("add a settings page", 0).observation);
    }

    #[test]
    fn similarity() {
        let a = PromptInfo::analyze("make the button bigger and blue", 0);
        let b = PromptInfo::analyze("make the button bigger and blue please", 0);
        let c = PromptInfo::analyze("write tests for the parser", 0);
        assert!(a.similarity(&b) > 0.6);
        assert!(a.similarity(&c) < 0.2);
    }
}
