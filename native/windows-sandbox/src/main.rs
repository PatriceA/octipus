//! Native plugin boundary. Never execute an unconfined child on failure.
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Launch {
    version: u32,
    authority: String,
    preload: Option<String>,
    argv: Vec<String>,
    root: String,
    read_only: Vec<String>,
    writable: Vec<String>,
    scratch: String,
    pipe: Option<String>,
    proxy_port: Option<u16>,
}

impl Launch {
    fn validate(&self) -> Result<(), String> {
        if self.authority.len() != 64
            || !self.authority.chars().all(|c| c.is_ascii_hexdigit())
            || self.version != 1
            || self.argv.is_empty()
            || self.argv.iter().any(|v| v.contains('\0'))
        {
            return Err("invalid launch protocol or argv".into());
        }
        if self.pipe.is_some() != self.proxy_port.is_some() || self.proxy_port == Some(0) {
            return Err("pipe and nonzero proxyPort must be supplied together".into());
        }
        if let Some(pipe) = &self.pipe {
            if !pipe.starts_with(r"\\.\pipe\LOCAL\octipus-")
                || !pipe[r"\\.\pipe\LOCAL\octipus-".len()..]
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() || c == '-')
            {
                return Err("invalid private broker pipe".into());
            }
        }
        Ok(())
    }
}

fn main() {
    let result = run();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("octipus-sandbox: {error}");
            std::process::exit(125);
        }
    }
}

fn run() -> Result<i32, String> {
    #[cfg(not(windows))]
    {
        Err("AppContainer requires Windows".into())
    }
    #[cfg(windows)]
    {
        let args: Vec<_> = std::env::args().skip(1).collect();
        if args == ["--probe"] {
            windows::probe()?;
            println!("octipus-sandbox protocol 1");
            return Ok(0);
        }
        if args == ["--version"] {
            println!("octipus-sandbox protocol 1");
            return Ok(0);
        }
        if args.len() != 2 || args[0] != "--config" {
            return Err("expected --config <launch.json>".into());
        }
        let config: Launch =
            serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        config.validate()?;
        windows::launch(config)
    }
}

/// CommandLineToArgvW / CRT quoting, including empty values and trailing backslashes.
fn broker_pipe_name(namespace: &str, session: u32, leaf: &str) -> Result<String, String> {
    let namespace = namespace.trim_matches('\\');
    if namespace.is_empty()
        || namespace
            .split('\\')
            .any(|p| p == "." || p == ".." || p.is_empty())
    {
        return Err("invalid AppContainer namespace".into());
    }
    let prefix = format!("Sessions\\{session}\\");
    if namespace.starts_with("Sessions\\") {
        if !namespace.starts_with(&prefix) {
            return Err("AppContainer session mismatch".into());
        }
        Ok(format!(r"\\.\pipe\{namespace}\{leaf}"))
    } else {
        Ok(format!(r"\\.\pipe\Sessions\{session}\{namespace}\{leaf}"))
    }
}

fn node_preload_option(path: &str) -> String {
    // NODE_OPTIONS has its own parser: unlike CreateProcess/CRT arguments,
    // backslashes inside quoted values are escapes. Windows accepts '/'.
    format!("--require {}", quote(&path.replace('\\', "/")))
}

fn profile_name(identity: &str) -> String {
    // CreateAppContainerProfile limits names to 64 characters.
    format!("Octipus.Plugin.{}", &identity[..48])
}

fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

#[cfg(windows)]
mod windows;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pipe_name_uses_child_session_for_relative_and_absolute_namespaces() {
        let expected = r"\\.\pipe\Sessions\7\AppContainerNamedObjects\SID\name";
        assert_eq!(
            broker_pipe_name(r"AppContainerNamedObjects\SID", 7, "name").unwrap(),
            expected
        );
        assert_eq!(
            broker_pipe_name(r"\Sessions\7\AppContainerNamedObjects\SID\", 7, "name").unwrap(),
            expected
        );
        assert!(broker_pipe_name(r"\Sessions\8\AppContainerNamedObjects\SID", 7, "name").is_err());
    }
    #[test]
    fn node_options_uses_forward_slashes() {
        assert_eq!(
            node_preload_option(r"C:\Users\a b\egress.cjs"),
            "--require \"C:/Users/a b/egress.cjs\""
        );
    }
    #[test]
    fn profile_name_fits_windows_limit() {
        assert_eq!(profile_name(&"a".repeat(64)).len(), 63);
    }
    #[test]
    fn windows_arguments() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote("C:\\a\\"), "\"C:\\a\\\\\"");
    }
    #[test]
    fn reject_protocol_and_arbitrary_pipe() {
        let mut launch: Launch = serde_json::from_str(r#"{"version":1,"authority":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","argv":["node"],"root":"p","readOnly":[],"writable":[],"scratch":"s","pipe":"\\\\.\\pipe\\LOCAL\\octipus-ab12","proxyPort":3000}"#).unwrap();
        assert!(launch.validate().is_ok());
        launch.pipe = Some(r"\\.\pipe\other".into());
        assert!(launch.validate().is_err());
        launch.pipe = None;
        launch.proxy_port = None;
        launch.version = 2;
        assert!(launch.validate().is_err());
    }
}
