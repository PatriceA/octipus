use super::{quote, Launch};
use std::{
    ffi::c_void,
    io::{self, Read, Write},
    mem::{size_of, zeroed},
    net::TcpStream,
    os::windows::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Isolation::*, *},
    Storage::FileSystem::*,
    System::{Console::*, JobObjects::*, Pipes::*, Threading::*, IO::*},
};

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn last(context: &str) -> String {
    format!("{context}: {}", io::Error::last_os_error())
}
fn win(ok: i32, context: &str) -> Result<(), String> {
    if ok == 0 {
        Err(last(context))
    } else {
        Ok(())
    }
}
fn status(code: u32, context: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!(
            "{context}: {}",
            io::Error::from_raw_os_error(code as i32)
        ))
    }
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                LocalFree(self.0);
            }
        }
    }
}
struct Profile {
    name: Vec<u16>,
    sid: PSID,
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
        }
    }
}
impl Profile {
    fn create(identity: &str) -> Result<Self, String> {
        let name = wide(identity);
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result == 0x800700b7u32 as i32 {
            let derived =
                unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
            if derived < 0 {
                return Err(format!("DeriveAppContainerSid: HRESULT {derived:#x}"));
            }
        } else if result < 0 {
            return Err(format!("CreateAppContainerProfile: HRESULT {result:#x}"));
        }
        Ok(Self { name, sid })
    }
    fn sid_text(&self) -> Result<String, String> {
        let mut text = null_mut();
        unsafe {
            win(
                ConvertSidToStringSidW(self.sid, &mut text),
                "ConvertSidToStringSid",
            )?;
            let _free = Local(text.cast());
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
                text, len,
            )))
        }
    }
}

/// Do not let an ACL grant follow a junction/symlink into the server's files.
fn checked_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.starts_with(r"\\") {
        return Err("only local absolute paths are supported".into());
    }
    for parent in path.ancestors() {
        let meta =
            std::fs::symlink_metadata(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("reparse point refused: {}", parent.display()));
        }
    }
    fn tree(path: &Path) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("reparse point refused: {}", path.display()));
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                tree(&entry.map_err(|e| e.to_string())?.path())?;
            }
        }
        Ok(())
    }
    tree(&path)?;
    Ok(path)
}

/// Persistent access is tied to a complete authority identity, never rolled back on stop.
struct Grant {
    path: Vec<u16>,
}
impl Grant {
    fn new(path: &Path, sid: PSID, writable: bool) -> Result<Self, String> {
        let grant = Self { path: wide(path) };
        unsafe {
            let mut old = null_mut();
            let mut sd = null_mut();
            status(
                GetNamedSecurityInfoW(
                    grant.path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                ),
                "read directory ACL",
            )?;
            let _sd = Local(sd);
            let mut entry: EXPLICIT_ACCESS_W = zeroed();
            entry.grfAccessPermissions = if writable {
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE
            } else {
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
            };
            entry.grfAccessMode = GRANT_ACCESS;
            entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            entry.Trustee.ptstrName = sid.cast();
            let mut updated = null_mut();
            status(
                SetEntriesInAclW(1, &entry, old, &mut updated),
                "build directory ACL",
            )?;
            let _updated = Local(updated.cast());
            status(
                SetNamedSecurityInfoW(
                    grant.path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    updated,
                    null(),
                ),
                "apply directory ACL",
            )?;
            if writable {
                // Dedicated plugin data is persistently low integrity. Never
                // restore shared labels on stop: concurrent launches/crashes
                // must not change each other's access. No host home/cache grant.
                let mut sd = null_mut();
                win(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        wide("S:(ML;OICI;NW;;;LW)").as_ptr(),
                        1,
                        &mut sd,
                        null_mut(),
                    ),
                    "low integrity descriptor",
                )?;
                let _sd = Local(sd);
                let mut present = 0;
                let mut defaulted = 0;
                let mut sacl = null_mut();
                win(
                    GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted),
                    "low integrity ACL",
                )?;
                status(
                    SetNamedSecurityInfoW(
                        grant.path.as_ptr(),
                        SE_FILE_OBJECT,
                        LABEL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        null(),
                        sacl,
                    ),
                    "set data integrity label",
                )?;
            }
        }
        Ok(grant)
    }
}

/// Serialize host ACL provisioning across all plugins. Only the server's OS
/// user and SYSTEM can open this mutex; an abandoned lock is safe to recover
/// because setup is additive/idempotent, with no shared ACL rollback.
struct AclLock(Handle);
impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}
fn acl_lock() -> Result<AclLock, String> {
    unsafe {
        let mut token = null_mut();
        win(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
            "open own token",
        )?;
        let _token = Handle(token);
        let mut len = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
        let mut info = vec![0usize; (len as usize).div_ceil(size_of::<usize>())];
        win(
            GetTokenInformation(token, TokenUser, info.as_mut_ptr().cast(), len, &mut len),
            "own token identity",
        )?;
        let user = &*(info.as_ptr().cast::<TOKEN_USER>());
        let mut sid = null_mut();
        win(ConvertSidToStringSidW(user.User.Sid, &mut sid), "own SID")?;
        let _sid = Local(sid.cast());
        let mut end = 0;
        while *sid.add(end) != 0 {
            end += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, end));
        let mut sd = null_mut();
        win(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(format!("D:P(A;;GA;;;SY)(A;;GA;;;{text})")).as_ptr(),
                1,
                &mut sd,
                null_mut(),
            ),
            "ACL mutex descriptor",
        )?;
        let _sd = Local(sd);
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let handle = Handle(CreateMutexW(
            &security,
            0,
            wide(format!("Global\\Octipus.Plugin.ACL.{text}")).as_ptr(),
        ));
        if handle.0.is_null() {
            return Err(last("ACL mutex"));
        }
        let wait = WaitForSingleObject(handle.0, 30000);
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            return Err("timed out acquiring plugin ACL lock".into());
        }
        Ok(AclLock(handle))
    }
}

pub fn probe() -> Result<(), String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let profile = Profile::create(&format!("Probe.{}.{nonce}", std::process::id()))?;
    unsafe {
        let result = DeleteAppContainerProfile(profile.name.as_ptr());
        if result < 0 {
            return Err(format!("probe profile cleanup: {result:#x}"));
        }
    }
    Ok(())
}

fn pipe_handle(
    name: &[u16],
    security: &SECURITY_ATTRIBUTES,
    first: bool,
) -> Result<Handle, String> {
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if first {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            64,
            65536,
            65536,
            0,
            security,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(last("CreateNamedPipe"))
    } else {
        Ok(Handle(handle))
    }
}

fn pipe_connect(handle: HANDLE) -> Result<(), String> {
    unsafe {
        let event = Handle(CreateEventW(null(), 1, 0, null()));
        if event.0.is_null() {
            return Err(last("pipe connect event"));
        }
        let mut overlapped: OVERLAPPED = zeroed();
        overlapped.hEvent = event.0;
        if ConnectNamedPipe(handle, &mut overlapped) != 0 {
            return Ok(());
        }
        match GetLastError() {
            ERROR_PIPE_CONNECTED => Ok(()),
            ERROR_IO_PENDING => {
                let mut count = 0;
                win(
                    GetOverlappedResult(handle, &mut overlapped, &mut count, 1),
                    "broker connect",
                )
            }
            _ => Err(last("broker connect")),
        }
    }
}

fn pipe_io(handle: HANDLE, stop: HANDLE, buffer: &mut [u8], write: bool) -> io::Result<usize> {
    unsafe {
        let event = Handle(CreateEventW(null(), 1, 0, null()));
        if event.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut overlapped: OVERLAPPED = zeroed();
        overlapped.hEvent = event.0;
        let mut count = 0;
        let ok = if write {
            WriteFile(
                handle,
                buffer.as_ptr(),
                buffer.len() as u32,
                &mut count,
                &mut overlapped,
            )
        } else {
            ReadFile(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut count,
                &mut overlapped,
            )
        };
        if ok == 0 {
            let code = GetLastError();
            if code == ERROR_BROKEN_PIPE || code == ERROR_HANDLE_EOF {
                return Ok(0);
            }
            if code != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            // A manual-reset stop event closes the check/submit cancellation
            // race: even a read submitted after shutdown immediately wakes,
            // cancels and drains before its buffer/OVERLAPPED can be dropped.
            let events = [event.0, stop];
            let waited = WaitForMultipleObjects(2, events.as_ptr(), 0, INFINITE);
            if waited != WAIT_OBJECT_0 {
                CancelIoEx(handle, &overlapped);
                GetOverlappedResult(handle, &mut overlapped, &mut count, 1);
                return Err(io::Error::new(io::ErrorKind::Interrupted, "broker closed"));
            }
            if GetOverlappedResult(handle, &mut overlapped, &mut count, 1) == 0 {
                let code = GetLastError();
                if code == ERROR_BROKEN_PIPE || code == ERROR_HANDLE_EOF {
                    return Ok(0);
                }
                return Err(io::Error::from_raw_os_error(code as i32));
            }
        }
        Ok(count as usize)
    }
}

/// The only host network endpoint. The child has no networking capabilities and
/// no loopback exemption. Each pipe stream is relayed to the existing host filter.
fn broker(name: &str, sid: &str, port: u16) -> Result<(), String> {
    let sddl = wide(format!(
        "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;OW)(A;;GRGW;;;{sid})S:(ML;;NW;;;LW)"
    ));
    let mut descriptor = null_mut();
    unsafe {
        win(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            ),
            "broker descriptor",
        )?;
    }
    let sd = Local(descriptor);
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let name = wide(name);
    let first = pipe_handle(&name, &security, true)?;
    // Pass raw values into the thread; they are owned exclusively by it.
    let first_raw = first.0 as usize;
    std::mem::forget(first);
    let sd_raw = sd.0 as usize;
    std::mem::forget(sd);
    std::thread::spawn(move || {
        let _sd = Local(sd_raw as *mut c_void);
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: _sd.0,
            bInheritHandle: 0,
        };
        let mut current = Handle(first_raw as HANDLE);
        loop {
            if let Err(error) = pipe_connect(current.0) {
                eprintln!("octipus-sandbox: {error}");
                break;
            }
            let stream = current.0 as usize;
            std::mem::forget(current);
            std::thread::spawn(move || {
                let pipe =
                    std::sync::Arc::new(unsafe { OwnedHandle::from_raw_handle(stream as HANDLE) });
                let event = unsafe { CreateEventW(null(), 1, 0, null()) };
                if event.is_null() {
                    eprintln!("octipus-sandbox: {}", last("broker stop event"));
                    return;
                }
                let stop = std::sync::Arc::new(unsafe { OwnedHandle::from_raw_handle(event) });
                match TcpStream::connect(("127.0.0.1", port)) {
                    Ok(mut tcp) => match tcp.try_clone() {
                        Ok(mut up) => {
                            let upload_pipe = pipe.clone();
                            let upload_stop = stop.clone();
                            let upload = std::thread::spawn(move || {
                                let mut buffer = vec![0; 65536];
                                loop {
                                    match pipe_io(
                                        upload_pipe.as_raw_handle(),
                                        upload_stop.as_raw_handle(),
                                        &mut buffer,
                                        false,
                                    ) {
                                        Ok(0) | Err(_) => break,
                                        Ok(count) => {
                                            if up.write_all(&buffer[..count]).is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                                let _ = up.shutdown(std::net::Shutdown::Write);
                            });
                            let mut buffer = vec![0; 65536];
                            'download: loop {
                                match tcp.read(&mut buffer) {
                                    Ok(0) | Err(_) => break,
                                    Ok(count) => {
                                        let mut sent = 0;
                                        while sent < count {
                                            match pipe_io(
                                                pipe.as_raw_handle(),
                                                stop.as_raw_handle(),
                                                &mut buffer[sent..count],
                                                true,
                                            ) {
                                                Ok(0) | Err(_) => break 'download,
                                                Ok(written) => sent += written,
                                            }
                                        }
                                    }
                                }
                            }
                            unsafe {
                                SetEvent(stop.as_raw_handle());
                            }
                            let _ = tcp.shutdown(std::net::Shutdown::Both);
                            let _ = upload.join();
                        }
                        Err(error) => eprintln!("octipus-sandbox: broker stream: {error}"),
                    },
                    Err(error) => eprintln!("octipus-sandbox: broker proxy: {error}"),
                }
            });
            match pipe_handle(&name, &security, false) {
                Ok(pipe) => current = pipe,
                Err(error) => {
                    eprintln!("octipus-sandbox: {error}");
                    break;
                }
            }
        }
    });
    Ok(())
}

/// Winsock initializes its protocol catalog through OS registry keys. LPAC
/// needs this non-network capability even when no sockets may leave the
/// container. It grants no internetClient/privateNetwork capability.
fn registry_read_capability() -> Result<Local, String> {
    unsafe {
        let mut groups = null_mut();
        let mut group_count = 0;
        let mut caps = null_mut();
        let mut cap_count = 0;
        win(
            DeriveCapabilitySidsFromName(
                wide("registryRead").as_ptr(),
                &mut groups,
                &mut group_count,
                &mut caps,
                &mut cap_count,
            ),
            "derive registryRead capability",
        )?;
        for i in 0..group_count {
            LocalFree(*groups.add(i as usize));
        }
        LocalFree(groups.cast());
        if cap_count != 1 {
            for i in 0..cap_count {
                LocalFree(*caps.add(i as usize));
            }
            LocalFree(caps.cast());
            return Err("registryRead returned an unexpected capability count".into());
        }
        let capability = Local(*caps);
        LocalFree(caps.cast());
        Ok(capability)
    }
}

struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast());
        }
    }
}

pub fn launch(config: Launch) -> Result<i32, String> {
    let root = checked_path(&config.root)?;
    let scratch = checked_path(&config.scratch)?;
    let exe = checked_path(&config.argv[0])?;
    let ro: Vec<_> = config
        .read_only
        .iter()
        .map(|v| checked_path(v))
        .collect::<Result<_, _>>()?;
    let rw: Vec<_> = config
        .writable
        .iter()
        .map(|v| checked_path(v))
        .collect::<Result<_, _>>()?;
    // Stage the native executable: a standard user cannot change Program Files
    // ACLs. Only the dedicated private copy is ever granted to the plugin.
    let runtime = scratch.join("runtime.exe");
    std::fs::copy(&exe, &runtime).map_err(|e| format!("stage native runtime: {e}"))?;
    let mut argv = config.argv.clone();
    argv[0] = runtime.to_string_lossy().into_owned();
    // Identity includes every persistent grant and the complete authority
    // fingerprint (env/secrets and egress/host scopes supplied by the server).
    use sha2::{Digest, Sha256};
    let mut identity = Sha256::new();
    identity.update(b"lpac/registryRead/v1");
    identity.update(config.authority.as_bytes());
    for path in std::iter::once(&root)
        .chain(ro.iter())
        .chain(rw.iter())
        .chain(std::iter::once(&exe))
    {
        identity.update(path.to_string_lossy().to_lowercase().as_bytes());
        identity.update([0]);
    }
    identity.update(std::fs::read(&runtime).map_err(|e| e.to_string())?);
    let _lock = acl_lock()?;
    // Re-check while serialized, before changing any ACL. Package directories
    // are host-owned; other plugin launches cannot mutate their contents.
    checked_path(&config.root)?;
    for path in &config.writable {
        checked_path(path)?;
    }
    for path in rw.iter().chain(std::iter::once(&scratch)) {
        if root.starts_with(path) || path.starts_with(&root) || path.parent().is_none() {
            return Err(
                "plugin writable roots must be dedicated directories outside the package".into(),
            );
        }
    }
    let profile = Profile::create(&super::profile_name(&format!("{:x}", identity.finalize())))?;
    let mut grants = Vec::new();
    for path in std::iter::once(&root).chain(ro.iter()) {
        grants.push(Grant::new(path, profile.sid, false)?);
    }
    for path in rw.iter().chain(std::iter::once(&scratch)) {
        grants.push(Grant::new(path, profile.sid, true)?);
    }
    drop(_lock);
    unsafe {
        // Job handle is never inherited. Closing it kills every descendant,
        // including when Node terminates this helper before orderly cleanup.
        let job = Handle(CreateJobObjectW(null(), null()));
        if job.0.is_null() {
            return Err(last("CreateJobObject"));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        limits.BasicLimitInformation.ActiveProcessLimit = 32;
        limits.JobMemoryLimit = 2 * 1024 * 1024 * 1024;
        win(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            ),
            "job limits",
        )?;

        let mut bytes = 0;
        InitializeProcThreadAttributeList(null_mut(), 3, 0, &mut bytes);
        let mut attributes = Attributes(vec![0; bytes.div_ceil(size_of::<usize>())]);
        let list = attributes.0.as_mut_ptr().cast();
        win(
            InitializeProcThreadAttributeList(list, 3, 0, &mut bytes),
            "startup attributes",
        )?;
        let registry = registry_read_capability()?;
        let mut registry_entry = SID_AND_ATTRIBUTES {
            Sid: registry.0,
            Attributes: 4, /* SE_GROUP_ENABLED */
        };
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: &mut registry_entry,
            CapabilityCount: 1,
            Reserved: 0,
        };
        win(
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&capabilities as *const SECURITY_CAPABILITIES).cast(),
                size_of_val(&capabilities),
                null_mut(),
                null(),
            ),
            "AppContainer capabilities",
        )?;
        // LPAC: do not inherit read access through ALL APPLICATION PACKAGES.
        let opt_out: u32 = 1;
        win(
            UpdateProcThreadAttribute(
                list,
                0,
                0x2000f,
                (&opt_out as *const u32).cast(),
                size_of_val(&opt_out),
                null_mut(),
                null(),
            ),
            "LPAC policy",
        )?;
        let mut inherited = Vec::new();
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let mut copy = null_mut();
            win(
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetStdHandle(id),
                    GetCurrentProcess(),
                    &mut copy,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                ),
                "stdio duplicate",
            )?;
            inherited.push(Handle(copy));
        }
        let handles: Vec<_> = inherited.iter().map(|h| h.0).collect();
        win(
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles.as_slice()),
                null_mut(),
                null(),
            ),
            "stdio handle list",
        )?;
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = list;
        // The helper receives the transport's isolated environment. Never import
        // workstation variables here; point writable runtime caches at scratch.
        let mut env: std::collections::BTreeMap<_, _> = std::env::vars_os().collect();
        let existing = env
            .get(std::ffi::OsStr::new("NODE_OPTIONS"))
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_default();
        // Node's default realpath walks every ancestor, including drive roots
        // the LPAC must not be granted. Package trees reject reparse points,
        // so preserve-symlinks avoids that metadata walk without widening ACLs.
        let mut node_options = String::from("--preserve-symlinks --preserve-symlinks-main");
        if let (Some(pipe), Some(port)) = (&config.pipe, config.proxy_port) {
            let preload = config
                .preload
                .as_ref()
                .ok_or("missing Node proxy preload")?;
            let preload_path = checked_path(preload)?;
            if !preload_path.starts_with(&scratch) {
                return Err("proxy preload must be in private scratch".into());
            }
            node_options.push(' ');
            node_options.push_str(&super::node_preload_option(preload));
            env.insert("OCTIPUS_EGRESS_PIPE".into(), pipe.into());
            let url = format!("http://127.0.0.1:{port}");
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                env.insert(key.into(), url.clone().into());
            }
            for key in ["NO_PROXY", "no_proxy"] {
                env.insert(key.into(), "".into());
            }
        }
        env.insert(
            "NODE_OPTIONS".into(),
            format!("{node_options} {existing}").into(),
        );
        env.insert("TEMP".into(), scratch.as_os_str().into());
        env.insert("TMP".into(), scratch.as_os_str().into());
        let mut environment = Vec::new();
        let mut entries: Vec<_> = env.into_iter().collect();
        entries.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
        for (key, value) in entries {
            environment.extend(wide(format!(
                "{}={}",
                key.to_string_lossy(),
                value.to_string_lossy()
            )));
        }
        environment.push(0);
        let mut command = wide(argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "));
        if command.len() > 32767 {
            return Err("Windows command line exceeds 32767 UTF-16 units".into());
        }
        let mut process: PROCESS_INFORMATION = zeroed();
        win(
            CreateProcessW(
                wide(runtime).as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | CREATE_NO_WINDOW,
                environment.as_ptr().cast(),
                wide(root).as_ptr(),
                &startup.StartupInfo,
                &mut process,
            ),
            "CreateProcess in AppContainer",
        )?;
        let child = Handle(process.hProcess);
        let thread = Handle(process.hThread);
        // Nothing in the plugin executes until it belongs to the kill-on-close job.
        if AssignProcessToJobObject(job.0, child.0) == 0 {
            let error = last("AssignProcessToJobObject");
            TerminateProcess(child.0, 125);
            return Err(error);
        }
        if let (Some(pipe), Some(port)) = (&config.pipe, config.proxy_port) {
            // LOCAL is expanded by the kernel inside AppContainer, but a
            // full-trust broker must create the corresponding explicit path.
            // Query the child's real namespace only after suspended creation.
            let mut token = null_mut();
            win(
                OpenProcessToken(child.0, TOKEN_QUERY, &mut token),
                "open AppContainer token",
            )?;
            let _token = Handle(token);
            let mut session: u32 = 0;
            let mut len = 0;
            win(
                GetTokenInformation(
                    token,
                    TokenSessionId,
                    (&mut session as *mut u32).cast(),
                    size_of::<u32>() as u32,
                    &mut len,
                ),
                "AppContainer session",
            )?;
            let leaf = pipe
                .strip_prefix(r"\\.\pipe\LOCAL\")
                .ok_or("invalid broker pipe prefix")?;
            let sid = profile.sid_text()?;
            let mut needed = 0;
            GetAppContainerNamedObjectPath(token, null_mut(), 0, null_mut(), &mut needed);
            let mut object_path = vec![0u16; needed as usize];
            win(
                GetAppContainerNamedObjectPath(
                    token,
                    null_mut(),
                    needed,
                    object_path.as_mut_ptr(),
                    &mut needed,
                ),
                "AppContainer object namespace",
            )?;
            let end = object_path
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(object_path.len());
            let namespace = String::from_utf16_lossy(&object_path[..end]);
            // Match Microsoft's CoreCLR pipe builder: session + object path.
            let resolved = super::broker_pipe_name(&namespace, session, leaf)?;
            broker(&resolved, &sid, port)
                .map_err(|error| format!("{error}; broker namespace {resolved}"))?;
        }
        if ResumeThread(thread.0) == u32::MAX {
            return Err(last("ResumeThread"));
        }
        win(
            (WaitForSingleObject(child.0, INFINITE) == WAIT_OBJECT_0) as i32,
            "wait for plugin",
        )?;
        let mut code = 125;
        win(GetExitCodeProcess(child.0, &mut code), "plugin exit status")?;
        // Terminate and wait for ALL descendants before revoking ACLs/profile.
        win(TerminateJobObject(job.0, code), "stop plugin descendants")?;
        loop {
            let mut state: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            win(
                QueryInformationJobObject(
                    job.0,
                    JobObjectBasicAccountingInformation,
                    (&mut state as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of_val(&state) as u32,
                    null_mut(),
                ),
                "wait for job descendants",
            )?;
            if state.ActiveProcesses == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Ok(code as i32)
    }
}
