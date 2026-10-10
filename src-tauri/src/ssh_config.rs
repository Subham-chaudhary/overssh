//! Minimal `~/.ssh/config` parser. See docs/GUIDE.md §6 for the rules.
//! Owned by task T1. The public API below is a fixed contract used by session.rs.

use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Fully resolved settings for one alias (mirrors `HostEntry` in src/lib/types.ts).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub alias: String,
    /// `HostName`, or the alias itself when absent.
    pub hostname: String,
    pub user: Option<String>,
    /// Default 22.
    pub port: u16,
    /// `~` expanded, in config order, may be empty.
    pub identity_files: Vec<String>,
    pub proxy_jump: Option<String>,
    /// `ProxyCommand` (unsupported; only recorded so connect can say so clearly).
    pub proxy_command: Option<String>,
}

#[derive(Debug, Clone)]
struct HostBlock {
    patterns: Vec<String>,
    settings: BTreeMap<String, Vec<String>>,
}

/// Parsed config: ordered `Host` blocks (Includes already inlined).
#[derive(Debug, Clone, Default)]
pub struct SshConfig {
    global_settings: BTreeMap<String, Vec<String>>,
    host_blocks: Vec<HostBlock>,
}

/// `%USERPROFILE%\.ssh\config` (or `$HOME/.ssh/config`).
pub fn default_config_path() -> Option<PathBuf> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".ssh").join("config"))
}

/// Parse a file, following `Include` directives. Missing file → `Ok(SshConfig::default())`.
pub fn parse_file(path: &Path) -> io::Result<SshConfig> {
    match read_text(path) {
        Ok(content) => {
            let ssh_dir = path.parent().unwrap_or(Path::new("."));
            Ok(parse_str(&content, ssh_dir))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(SshConfig::default()),
        Err(e) => Err(e),
    }
}

/// Reads a config file as text. Lossy (one stray non-UTF-8 byte, e.g. a
/// Latin-1 comment, must not hide every host) and without a UTF-8 BOM
/// (Notepad adds one, which used to turn the first `Host` into an unknown key).
fn read_text(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Parse text. Relative `Include` paths resolve against `ssh_dir` (normally `~/.ssh`).
pub fn parse_str(text: &str, ssh_dir: &Path) -> SshConfig {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut stack = Vec::new();
    let expanded_text = preprocess_includes(text, ssh_dir, 0, &mut stack);
    let mut config = SshConfig::default();
    parse_expanded(&expanded_text, &mut config);
    config
}

/// Preprocess the config text to expand all Include directives.
/// `stack` holds the files currently being expanded: a file that (directly or
/// through a glob) includes itself is skipped instead of being expanded again
/// at every level up to the depth limit.
fn preprocess_includes(text: &str, ssh_dir: &Path, depth: usize, stack: &mut Vec<PathBuf>) -> String {
    if depth > 16 {
        return text.to_string();
    }

    let mut result = String::new();

    for line in text.lines() {
        let trimmed = line.trim_start();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let (key, value) = parse_line(line);
        if key.to_lowercase() == "include" {
            // Expand Include directive - can have multiple paths
            for path_spec in value.split_whitespace() {
                let include_paths = resolve_include_path(path_spec, ssh_dir);
                for include_path in include_paths {
                    let key = fs::canonicalize(&include_path).unwrap_or_else(|_| include_path.clone());
                    if stack.contains(&key) || include_path.is_dir() {
                        continue; // include cycle, or a directory matched by a glob
                    }
                    if let Ok(content) = read_text(&include_path) {
                        stack.push(key);
                        let expanded = preprocess_includes(&content, ssh_dir, depth + 1, stack);
                        stack.pop();
                        result.push_str(&expanded);
                    }
                    // Missing files are ignored
                }
            }
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }

    result
}

/// Parse a config text without Include directives (already expanded).
fn parse_expanded(text: &str, config: &mut SshConfig) {
    let mut current_block: Option<HostBlock> = None;
    let mut in_match_block = false;

    for line in text.lines() {
        let trimmed = line.trim_start();

        // Skip comments and blank lines
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let (key, value) = parse_line(line);

        if key.is_empty() {
            continue;
        }

        let key_lower = key.to_lowercase();

        if key_lower == "host" {
            // Save the previous block if any
            if let Some(block) = current_block.take() {
                config.host_blocks.push(block);
            }
            in_match_block = false;

            // Create a new Host block with patterns
            let patterns: Vec<String> = value
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            current_block = Some(HostBlock {
                patterns,
                settings: BTreeMap::new(),
            });
        } else if key_lower == "match" {
            // Save the previous Host block if any
            if let Some(block) = current_block.take() {
                config.host_blocks.push(block);
            }
            // Mark that we're in a Match block to skip lines
            in_match_block = true;
        } else if in_match_block {
            // Skip lines inside Match blocks
            continue;
        } else {
            // Regular setting
            if let Some(ref mut block) = current_block {
                block
                    .settings
                    .entry(key_lower)
                    .or_insert_with(Vec::new)
                    .push(value);
            } else {
                // Global settings (before first Host)
                config
                    .global_settings
                    .entry(key_lower)
                    .or_default()
                    .push(value);
            }
        }
    }

    // Save the last block if any
    if let Some(block) = current_block {
        config.host_blocks.push(block);
    }
}

/// Parse a single line into (key, value).
/// Handles both `Key value` and `Key=value` (and `Key = value`) formats.
/// Removes quotes from values.
fn parse_line(line: &str) -> (String, String) {
    let trimmed = line.trim();

    // The key ends at the first whitespace or `=` (OpenSSH semantics). An `=`
    // further right belongs to the value: `ProxyCommand ssh -o A=b host` used
    // to be split at that `=`, losing the key.
    let key_end = trimmed
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(trimmed.len());
    let key = trimmed[..key_end].to_string();
    let mut rest = trimmed[key_end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    (key, unquote(rest).to_string())
}

/// Remove surrounding double quotes if present.
fn unquote(s: &str) -> &str {
    let s = s.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() > 1 {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Resolve include paths, handling globs in the final filename component.
fn resolve_include_path(path_spec: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let expanded = expand_path_simple(path_spec);
    let path = if Path::new(&expanded).is_absolute() {
        PathBuf::from(expanded)
    } else {
        ssh_dir.join(&expanded)
    };

    // Check if the filename contains glob characters
    if let Some(filename) = path.file_name() {
        if let Some(filename_str) = filename.to_str() {
            if filename_str.contains('*') || filename_str.contains('?') {
                // Glob matching
                if let Some(parent) = path.parent() {
                    if let Ok(entries) = fs::read_dir(parent) {
                        let mut matches = Vec::new();
                        for entry in entries.flatten() {
                            if let Some(name) = entry.file_name().to_str() {
                                if wildcard_match(name, filename_str) {
                                    matches.push(entry.path());
                                }
                            }
                        }
                        matches.sort();
                        return matches;
                    }
                }
                return Vec::new();
            }
        }
    }

    // No glob, just return the path if it exists
    if path.exists() {
        vec![path]
    } else {
        Vec::new()
    }
}

/// Expand ~ and %d in paths (used for Include paths).
fn expand_path_simple(path: &str) -> String {
    if path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = get_home_dir() {
            return format!("{}{}", home, &path[1..]);
        }
    } else if path == "~" {
        if let Some(home) = get_home_dir() {
            return home;
        }
    }

    if path.starts_with("%d/") || path.starts_with("%d\\") {
        if let Some(home) = get_home_dir() {
            return format!("{}{}", home, &path[2..]);
        }
    } else if path == "%d" {
        if let Some(home) = get_home_dir() {
            return home;
        }
    }

    path.to_string()
}

/// Expand ~ and %d in config values (used for HostName, IdentityFile, etc).
fn expand_path(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = get_home_dir() {
            return format!("{}{}", home, &path[1..]);
        }
    } else if path.starts_with("~") && path.len() > 1 {
        // ~/ or ~user (but we don't expand ~user)
        if path.starts_with("~/") {
            if let Some(home) = get_home_dir() {
                return format!("{}{}", home, &path[1..]);
            }
        }
    }

    if path.starts_with("%d/") {
        if let Some(home) = get_home_dir() {
            return format!("{}{}", home, &path[2..]);
        }
    } else if path == "%d" {
        if let Some(home) = get_home_dir() {
            return home;
        }
    }

    path.to_string()
}

/// Get the home directory.
fn get_home_dir() -> Option<String> {
    env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .ok()
}

/// Match a text against a wildcard pattern (* and ? supported).
fn wildcard_match(text: &str, pattern: &str) -> bool {
    match_recursive(text.as_bytes(), pattern.as_bytes())
}

/// Recursive wildcard matching logic.
fn match_recursive(text: &[u8], pattern: &[u8]) -> bool {
    let mut ti = 0;
    let mut pi = 0;

    while pi < pattern.len() {
        match pattern[pi] {
            b'*' => {
                if pi + 1 >= pattern.len() {
                    return true; // `*` at end matches everything
                }
                // Try matching the rest of the pattern at each position
                while ti <= text.len() {
                    if match_recursive(&text[ti..], &pattern[pi + 1..]) {
                        return true;
                    }
                    ti += 1;
                }
                return false;
            }
            b'?' => {
                if ti >= text.len() {
                    return false; // ? must match exactly one character
                }
                ti += 1;
                pi += 1;
            }
            c => {
                if ti >= text.len() || text[ti] != c {
                    return false;
                }
                ti += 1;
                pi += 1;
            }
        }
    }

    ti == text.len()
}

/// Check if a Host block matches the given alias.
fn host_block_matches(alias: &str, block: &HostBlock) -> bool {
    let mut has_match = false;

    for pattern in &block.patterns {
        if let Some(inner_pattern) = pattern.strip_prefix('!') {
            // Negated pattern: if it matches, exclude the entire block
            if wildcard_match(alias, inner_pattern) {
                return false;
            }
        } else {
            // Non-negated pattern
            if wildcard_match(alias, pattern) {
                has_match = true;
            }
        }
    }

    has_match
}

impl SshConfig {
    /// Resolve an alias with OpenSSH first-match-wins semantics (IdentityFile accumulates).
    pub fn resolve(&self, alias: &str) -> HostConfig {
        let mut config = HostConfig {
            alias: alias.to_string(),
            hostname: alias.to_string(),
            user: None,
            port: 22,
            identity_files: Vec::new(),
            proxy_jump: None,
            proxy_command: None,
        };

        // OpenSSH reads top to bottom and keeps the first value obtained, so the
        // pre-`Host` section behaves like a leading block that matches everything.
        let mut seen = HashSet::new();
        apply_settings(&self.global_settings, &mut config, &mut seen);
        for block in &self.host_blocks {
            if host_block_matches(alias, block) {
                apply_settings(&block.settings, &mut config, &mut seen);
            }
        }

        config
    }

    /// Concrete (no `*`, `?`, `!`) host aliases in file order, de-duplicated.
    pub fn concrete_hosts(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut result = Vec::new();

        for block in &self.host_blocks {
            for pattern in &block.patterns {
                // Only include patterns with no wildcards or negation
                if !pattern.contains('*')
                    && !pattern.contains('?')
                    && !pattern.starts_with('!')
                    && seen.insert(pattern.clone()) {
                        result.push(pattern.clone());
                    }
            }
        }

        result
    }
}

/// Apply one section's settings: first value obtained wins, except `IdentityFile`
/// which accumulates (de-duplicated). `seen` tracks keys already set.
fn apply_settings(
    settings: &BTreeMap<String, Vec<String>>,
    config: &mut HostConfig,
    seen: &mut HashSet<String>,
) {
    for (key, values) in settings {
        if key == "identityfile" {
            for val in values {
                let expanded = expand_path(val);
                if !config.identity_files.contains(&expanded) {
                    config.identity_files.push(expanded);
                }
            }
            continue;
        }
        let Some(val) = values.first() else { continue };
        let applied = match key.as_str() {
            "hostname" if !seen.contains(key) => {
                // `%h` is the host name given on the command line (the alias);
                // `%%` is a literal `%`.
                config.hostname = val.replace("%%", "\u{0}").replace("%h", &config.alias).replace('\u{0}', "%");
                true
            }
            "user" if !seen.contains(key) => {
                config.user = Some(val.clone());
                true
            }
            "port" if !seen.contains(key) => match val.parse::<u16>() {
                Ok(port) => {
                    config.port = port;
                    true
                }
                Err(_) => false,
            },
            "proxyjump" if !seen.contains(key) => {
                config.proxy_jump = Some(val.clone());
                true
            }
            "proxycommand" if !seen.contains(key) => {
                config.proxy_command = Some(val.clone());
                true
            }
            _ => false,
        };
        if applied {
            seen.insert(key.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn test_basic_host() {
        let config_text = r#"
Host example.com
    HostName 192.168.1.1
    User alice
    Port 2222
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("example.com");

        assert_eq!(resolved.alias, "example.com");
        assert_eq!(resolved.hostname, "192.168.1.1");
        assert_eq!(resolved.user, Some("alice".to_string()));
        assert_eq!(resolved.port, 2222);
    }

    #[test]
    fn test_key_equals_value_format() {
        let config_text = r#"Host test
HostName=10.0.0.1
User=bob
Port=3333"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.hostname, "10.0.0.1");
        assert_eq!(resolved.user, Some("bob".to_string()));
        assert_eq!(resolved.port, 3333);
    }

    #[test]
    fn test_key_space_equals_value() {
        let config_text = r#"Host test
HostName = 10.0.0.1
User = bob"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.hostname, "10.0.0.1");
        assert_eq!(resolved.user, Some("bob".to_string()));
    }

    #[test]
    fn test_quoted_values() {
        let config_text = r#"Host test
    HostName "10.0.0.1"
    User "alice with space"
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.hostname, "10.0.0.1");
        assert_eq!(resolved.user, Some("alice with space".to_string()));
    }

    #[test]
    fn test_case_insensitivity() {
        let config_text = r#"Host test
    HOSTNAME 10.0.0.1
    user alice
    pOrT 2222
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.hostname, "10.0.0.1");
        assert_eq!(resolved.user, Some("alice".to_string()));
        assert_eq!(resolved.port, 2222);
    }

    #[test]
    fn test_comments_and_blank_lines() {
        let config_text = r#"# This is a comment
Host test
    # Another comment
    HostName 10.0.0.1

    User alice
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.hostname, "10.0.0.1");
        assert_eq!(resolved.user, Some("alice".to_string()));
    }

    #[test]
    fn test_first_wins() {
        let config_text = r#"Host *
    User default
    HostName default.example.com
Host example.com
    User specific
    HostName 10.0.0.1
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("example.com");

        // Global (Host *) is processed first, then specific Host
        // But first-wins means the first value wins
        assert_eq!(resolved.user, Some("default".to_string()));
        assert_eq!(resolved.hostname, "default.example.com");
    }

    #[test]
    fn test_identity_file_accumulation() {
        let config_text = r#"Host *
    IdentityFile ~/.ssh/id_rsa
Host example.com
    IdentityFile ~/.ssh/id_ed25519
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("example.com");

        assert_eq!(resolved.identity_files.len(), 2);
        assert!(resolved.identity_files[0].ends_with("id_rsa"));
        assert!(resolved.identity_files[1].ends_with("id_ed25519"));
    }

    #[test]
    fn test_identity_file_no_duplicates() {
        let config_text = r#"Host *
    IdentityFile ~/.ssh/id_rsa
Host example.com
    IdentityFile ~/.ssh/id_rsa
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("example.com");

        assert_eq!(resolved.identity_files.len(), 1);
    }

    #[test]
    fn test_wildcard_pattern_star() {
        let config_text = r#"Host *.example.com
    User alice
Host *
    HostName default.example.com
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test.example.com");

        assert_eq!(resolved.user, Some("alice".to_string()));
    }

    #[test]
    fn test_wildcard_pattern_question() {
        let config_text = r#"Host test?
    User alice
"#;
        let config = parse_str(config_text, Path::new("."));

        let resolved1 = config.resolve("test1");
        assert_eq!(resolved1.user, Some("alice".to_string()));

        let resolved2 = config.resolve("test12");
        assert_eq!(resolved2.user, None);
    }

    #[test]
    fn test_negation() {
        let config_text = r#"Host *.example.com
    User alice
Host !staging.example.com
    User bob
"#;
        let config = parse_str(config_text, Path::new("."));

        let resolved1 = config.resolve("test.example.com");
        assert_eq!(resolved1.user, Some("alice".to_string()));

        let resolved2 = config.resolve("staging.example.com");
        // staging.example.com matches *.example.com but is negated by !staging.example.com
        // So it doesn't match the second block
        assert_eq!(resolved2.user, Some("alice".to_string()));
    }

    #[test]
    fn test_equals_inside_value_keeps_key() {
        let config = parse_str("Host a\n    ProxyCommand ssh -o Foo=bar -W %h:%p jump\n    Port=2222\n", Path::new("."));
        let a = config.resolve("a");
        assert_eq!(a.proxy_command.as_deref(), Some("ssh -o Foo=bar -W %h:%p jump"));
        assert_eq!(a.port, 2222);
        assert_eq!(parse_line("  User = bob  "), ("User".into(), "bob".into()));
        assert_eq!(parse_line("HostName\t\"10.0.0.1\""), ("HostName".into(), "10.0.0.1".into()));
    }

    #[test]
    fn test_bom_and_hostname_token() {
        let config = parse_str("\u{feff}Host web\n    HostName %h.example.com\n", Path::new("."));
        assert_eq!(config.resolve("web").hostname, "web.example.com");
        assert_eq!(config.concrete_hosts(), vec!["web".to_string()]);
    }

    #[test]
    fn test_self_include_does_not_loop() {
        let dir = std::env::temp_dir().join(format!("overssh-cfg-loop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config");
        std::fs::write(&f, "Include config\nHost x\n    HostName 1.2.3.4\n").unwrap();
        let c = parse_file(&f).unwrap();
        assert_eq!(c.resolve("x").hostname, "1.2.3.4");
        assert_eq!(c.host_blocks.len(), 2); // the file once + one self-include, not 17 levels
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_negation_excludes_block() {
        let config_text = r#"Host test staging !debug
    User alice
"#;
        let config = parse_str(config_text, Path::new("."));

        let resolved1 = config.resolve("test");
        assert_eq!(resolved1.user, Some("alice".to_string()));

        let resolved2 = config.resolve("staging");
        assert_eq!(resolved2.user, Some("alice".to_string()));

        let resolved3 = config.resolve("debug");
        assert_eq!(resolved3.user, None);
    }

    #[test]
    fn test_match_block_skipping() {
        let config_text = r#"Host example.com
    User alice
    HostName 10.0.0.1
Match host example.com
    User bob
    Port 2222
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("example.com");

        assert_eq!(resolved.user, Some("alice".to_string()));
        assert_eq!(resolved.port, 22); // Match block is skipped, port not set
    }

    #[test]
    fn test_tilde_expansion() {
        let config_text = r#"Host test
    IdentityFile ~/.ssh/id_rsa
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.identity_files.len(), 1);
        assert!(resolved.identity_files[0].contains("id_rsa"));
        assert!(resolved.identity_files[0].contains(".ssh"));
    }

    #[test]
    fn test_percent_d_expansion() {
        let config_text = r#"Host test
    IdentityFile %d/.ssh/id_rsa
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.identity_files.len(), 1);
        assert!(resolved.identity_files[0].contains("id_rsa"));
    }

    #[test]
    fn test_default_port() {
        let config_text = r#"Host test
    HostName 10.0.0.1
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.port, 22);
    }

    #[test]
    fn test_concrete_hosts_filters_patterns() {
        let config_text = r#"Host *.example.com
    User alice
Host test1
    HostName 10.0.0.1
Host test2
    HostName 10.0.0.2
Host !excluded
    User bob
Host test?
    User charlie
"#;
        let config = parse_str(config_text, Path::new("."));
        let concrete = config.concrete_hosts();

        assert!(!concrete.contains(&"*.example.com".to_string()));
        assert!(!concrete.contains(&"!excluded".to_string()));
        assert!(!concrete.contains(&"test?".to_string()));
        assert!(concrete.contains(&"test1".to_string()));
        assert!(concrete.contains(&"test2".to_string()));
    }

    #[test]
    fn test_concrete_hosts_deduplication() {
        let config_text = r#"Host test1
    HostName 10.0.0.1
Host test1
    User alice
Host test2
    HostName 10.0.0.2
"#;
        let config = parse_str(config_text, Path::new("."));
        let concrete = config.concrete_hosts();

        assert_eq!(concrete.len(), 2);
        assert!(concrete.contains(&"test1".to_string()));
        assert!(concrete.contains(&"test2".to_string()));
    }

    #[test]
    fn test_global_settings() {
        let config_text = r#"User global_user
HostName default.example.com
Host test
    HostName specific.example.com
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        // Matches `ssh -G test`: lines before the first Host are read first and win.
        assert_eq!(resolved.user, Some("global_user".to_string()));
        assert_eq!(resolved.hostname, "default.example.com");
    }

    #[test]
    fn test_real_world_example() {
        let config_text = r#"Host sherlock-vm-stg
    HostName 10.0.0.1
    User azureuser
    IdentityFile S:/github/sherlock/secret.pem
Host chalkdoor-vm-dev
	HostName 10.0.0.2
	User azureuser
	IdentityFile ~/.ssh/chalkdoor_dev.pub
"#;
        let config = parse_str(config_text, Path::new("."));

        let resolved1 = config.resolve("sherlock-vm-stg");
        assert_eq!(resolved1.alias, "sherlock-vm-stg");
        assert_eq!(resolved1.hostname, "10.0.0.1");
        assert_eq!(resolved1.user, Some("azureuser".to_string()));
        assert_eq!(resolved1.identity_files.len(), 1);
        assert_eq!(resolved1.identity_files[0], "S:/github/sherlock/secret.pem");

        let resolved2 = config.resolve("chalkdoor-vm-dev");
        assert_eq!(resolved2.hostname, "10.0.0.2");
        assert_eq!(resolved2.user, Some("azureuser".to_string()));
        assert_eq!(resolved2.identity_files.len(), 1);
        assert!(resolved2.identity_files[0].ends_with("chalkdoor_dev.pub"));
    }

    #[test]
    fn test_missing_file_returns_default() {
        let result = parse_file(Path::new("/nonexistent/path/to/config"));
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(config.concrete_hosts().len(), 0);
    }

    #[test]
    fn test_include_with_glob() {
        let temp_dir = std::env::temp_dir().join(format!(
            "overssh_test_{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        // Create included files
        let file1_path = temp_dir.join("config.1");
        let mut file1 = File::create(&file1_path).unwrap();
        writeln!(file1, "Host host1\n    HostName 10.0.0.1").unwrap();

        let file2_path = temp_dir.join("config.2");
        let mut file2 = File::create(&file2_path).unwrap();
        writeln!(file2, "Host host2\n    HostName 10.0.0.2").unwrap();

        // Create main config with glob Include
        let config_text = format!(
            "Include {}/config.*",
            temp_dir.display()
        );

        let config = parse_str(&config_text, &temp_dir);
        let concrete = config.concrete_hosts();

        assert!(concrete.contains(&"host1".to_string()));
        assert!(concrete.contains(&"host2".to_string()));

        // Cleanup
        let _ = fs::remove_file(&file1_path);
        let _ = fs::remove_file(&file2_path);
        let _ = fs::remove_dir(&temp_dir);
    }

    #[test]
    fn test_include_relative_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "overssh_test_rel_{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        // Create included file
        let include_file = temp_dir.join("included.conf");
        let mut f = File::create(&include_file).unwrap();
        writeln!(f, "Host included_host\n    HostName 10.0.0.100").unwrap();

        // Create main config with relative Include
        let config_text = "Include included.conf";
        let config = parse_str(config_text, &temp_dir);
        let concrete = config.concrete_hosts();

        assert!(concrete.contains(&"included_host".to_string()));

        // Cleanup
        let _ = fs::remove_file(&include_file);
        let _ = fs::remove_dir(&temp_dir);
    }

    #[test]
    fn test_wildcard_matching_star() {
        assert!(wildcard_match("test.example.com", "*.example.com"));
        assert!(wildcard_match("foo.example.com", "*.example.com"));
        assert!(!wildcard_match("example.com", "*.example.com"));
        assert!(wildcard_match("anything", "*"));
    }

    #[test]
    fn test_wildcard_matching_question() {
        assert!(wildcard_match("test1", "test?"));
        assert!(wildcard_match("testA", "test?"));
        assert!(!wildcard_match("test12", "test?"));
        assert!(!wildcard_match("test", "test?"));
    }

    #[test]
    fn test_wildcard_matching_combined() {
        assert!(wildcard_match("test.example.com", "*.example.*"));
        assert!(wildcard_match("a.b.c", "?.*.*"));
        assert!(!wildcard_match("abc.d.e", "?.*.*"));
    }

    #[test]
    fn test_proxy_jump() {
        let config_text = r#"Host test
    HostName 10.0.0.1
    ProxyJump bastion
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        assert_eq!(resolved.proxy_jump, Some("bastion".to_string()));
    }

    #[test]
    fn test_proxy_command_recorded() {
        let config = parse_str("Host t
    ProxyCommand ssh -W %h:%p gw
", Path::new("."));
        let resolved = config.resolve("t");
        assert!(resolved.proxy_command.is_some());
        assert_eq!(resolved.proxy_jump, None);
    }

    #[test]
    fn test_parse_file_success() {
        let temp_dir = std::env::temp_dir().join(format!(
            "overssh_test_file_{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let config_file = temp_dir.join("config");
        let mut f = File::create(&config_file).unwrap();
        writeln!(f, "Host test\n    HostName 10.0.0.1").unwrap();

        let result = parse_file(&config_file).unwrap();
        let concrete = result.concrete_hosts();

        assert!(concrete.contains(&"test".to_string()));

        // Cleanup
        let _ = fs::remove_file(&config_file);
        let _ = fs::remove_dir(&temp_dir);
    }

    #[test]
    fn test_default_config_path() {
        let path = default_config_path();
        assert!(path.is_some());
        let p = path.unwrap();
        assert!(p.to_string_lossy().contains(".ssh"));
        assert!(p.to_string_lossy().contains("config"));
    }

    #[test]
    fn test_hostname_fallback_to_alias() {
        let config_text = r#"Host myhost
    User alice
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("myhost");

        assert_eq!(resolved.hostname, "myhost");
    }

    #[test]
    fn test_multiple_patterns_in_host_line() {
        let config_text = r#"Host alias1 alias2 alias3
    User alice
    HostName 10.0.0.1
"#;
        let config = parse_str(config_text, Path::new("."));

        let resolved1 = config.resolve("alias1");
        assert_eq!(resolved1.user, Some("alice".to_string()));

        let resolved2 = config.resolve("alias2");
        assert_eq!(resolved2.user, Some("alice".to_string()));

        let resolved3 = config.resolve("alias3");
        assert_eq!(resolved3.user, Some("alice".to_string()));
    }

    #[test]
    fn test_port_not_first_wins() {
        let config_text = r#"Host *
    Port 1234
Host test
    Port 5678
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        // First wins: global setting comes first
        assert_eq!(resolved.port, 1234);
    }

    #[test]
    fn test_invalid_port() {
        let config_text = r#"Host test
    Port notanumber
    HostName 10.0.0.1
"#;
        let config = parse_str(config_text, Path::new("."));
        let resolved = config.resolve("test");

        // Invalid port should be ignored, default to 22
        assert_eq!(resolved.port, 22);
    }
}
