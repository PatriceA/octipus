//! Native plugin boundary. Never execute an unconfined child on failure.
use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Launch {
    version: u32,
    authority: String,
    #[serde(default)]
    bridge: bool,
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
        if self.bridge
            && (self.pipe.is_none()
                || self.argv.len() < 6
                || self.argv[3] != "--"
                || Some(&self.argv[4]) != self.pipe.as_ref())
        {
            return Err("invalid broker bridge argv".into());
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
