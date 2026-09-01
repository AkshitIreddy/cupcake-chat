//! Windows 10/11 x64 generated-code sandbox.
//!
//! The process is created as an AppContainer with no capabilities, which gives
//! it a lowbox token and denies network/credential/user-profile access by
//! default. Only the executable and exact staging directory receive temporary
//! ACL entries for that principal. A Job Object is attached before the primary
//! thread is resumed so no unbounded process can escape the broker's ownership.

use super::{NetworkPolicy, ProcessState, ResolvedProcessPlan, SandboxBackend, SandboxOutput};
use crate::{BrokerError, Result};
use std::collections::HashMap;
use std::ffi::{c_void, OsStr};
use std::fs;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_BROKEN_PIPE, HANDLE,
    HANDLE_FLAG_INHERIT, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_PROCESS_TIME, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

const TERMINATED_EXIT_CODE: u32 = 0xC0C0_0001;
const WAIT_SLICE_MS: u32 = 20;
const MAX_STAGED_FILES: usize = 20_000;
const MAX_STAGED_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug)]
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, what: &str) -> Result<Self> {
        if handle.is_null() {
            Err(last_io(what))
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = null_mut();
        handle
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this type has unique ownership of a valid Windows handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[derive(Debug)]
struct ExecutionControl {
    job: WindowsJob,
    cancelled: AtomicBool,
}

impl ExecutionControl {
    fn terminate(&self, cancelled: bool) -> Result<()> {
        if cancelled {
            self.cancelled.store(true, Ordering::Release);
        }
        // SAFETY: the Job handle stays alive through the Arc held by this call.
        self.job.terminate(TERMINATED_EXIT_CODE)
    }
}

/// Broker-owned process-tree containment primitive shared by sandboxed native
/// supervisors. A process must be created suspended, assigned, and only then
/// resumed; callers that cannot guarantee that ordering must fail closed.
#[derive(Debug)]
pub struct WindowsJob {
    handle: OwnedHandle,
}

impl WindowsJob {
    pub fn new(limits: &crate::registry::ResourceLimits, process_limit: u32) -> Result<Self> {
        if process_limit == 0 || process_limit > 64 {
            return Err(BrokerError::InvalidConfig(
                "Job Object process limit must be between 1 and 64".into(),
            ));
        }
        // SAFETY: configure_job returns sole ownership of a configured handle.
        unsafe { configure_job(limits, process_limit) }
    }

    pub fn assign(&self, process: BorrowedHandle<'_>) -> Result<()> {
        // SAFETY: both borrowed process and owned Job handles are valid for the
        // duration of the call.
        if unsafe { AssignProcessToJobObject(self.handle.raw(), process.as_raw_handle() as HANDLE) }
            == 0
        {
            return Err(last_io("assign process to broker Job Object"));
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        // SAFETY: the Job handle is owned by this value.
        if unsafe { TerminateJobObject(self.handle.raw(), exit_code) } == 0 {
            return Err(last_io("terminate broker Job Object"));
        }
        Ok(())
    }
}

/// Native backend for the sole supported CUPCAKEAGI 2.0 platform.
///
/// A backend instance owns the cancellation registry. Execution IDs must be
/// unique while a process is active; duplicates fail before any child starts.
#[derive(Debug, Default)]
pub struct WindowsSandbox {
    active: Mutex<HashMap<String, Arc<ExecutionControl>>>,
    // Stage export is a directory transaction. Serializing it prevents two
    // runs from writing through the same opaque grant concurrently.
    stage_transaction: Mutex<()>,
}

impl SandboxBackend for WindowsSandbox {
    fn execute(&self, plan: &ResolvedProcessPlan) -> Result<SandboxOutput> {
        plan.validate_paths()?;
        if plan.network != NetworkPolicy::Denied || !plan.network_origins.is_empty() {
            return Err(BrokerError::SandboxUnavailable(
                "the Windows sandbox currently supports only capability-free denied networking"
                    .into(),
            ));
        }
        if !plan.environment.is_empty() {
            return Err(BrokerError::SandboxUnavailable(
                "classic AppContainer launch cannot safely accept custom environment bindings"
                    .into(),
            ));
        }
        if std::env::vars_os().any(|(name, _)| credential_like_environment_name(&name)) {
            return Err(BrokerError::SandboxUnavailable(
                "broker environment contains a credential-like binding; refusing AppContainer inheritance"
                    .into(),
            ));
        }

        {
            let active = self.active.lock().map_err(poisoned)?;
            if active.contains_key(&plan.execution_id) {
                return Err(BrokerError::Duplicate(plan.execution_id.clone()));
            }
        }

        let _stage_transaction = self.stage_transaction.lock().map_err(poisoned)?;

        // SAFETY: every raw resource created in this block is immediately moved
        // into an RAII owner, and all pointers remain live for the documented
        // duration of the corresponding Windows call.
        unsafe { self.execute_inner(plan) }
    }

    fn cancel(&self, execution_id: &str) -> Result<()> {
        let control = self
            .active
            .lock()
            .map_err(poisoned)?
            .get(execution_id)
            .cloned()
            .ok_or_else(|| BrokerError::NotFound(execution_id.into()))?;
        control.terminate(true)
    }
}

impl WindowsSandbox {
    unsafe fn execute_inner(&self, plan: &ResolvedProcessPlan) -> Result<SandboxOutput> {
        let appcontainer = AppContainerSid::acquire()?;
        let job = WindowsJob::new(&plan.limits, 1)?;
        let control = Arc::new(ExecutionControl {
            job,
            cancelled: AtomicBool::new(false),
        });
        {
            let mut active = self.active.lock().map_err(poisoned)?;
            if active
                .insert(plan.execution_id.clone(), Arc::clone(&control))
                .is_some()
            {
                return Err(BrokerError::Duplicate(plan.execution_id.clone()));
            }
        }
        let _registration = ActiveRegistration {
            active: &self.active,
            execution_id: &plan.execution_id,
        };

        let internal_working_directory = appcontainer.folder().join("LocalState").join("work");
        let internal_bin_directory = appcontainer.folder().join("LocalState").join("bin");
        fs::create_dir_all(&internal_working_directory)?;
        fs::create_dir_all(&internal_bin_directory)?;
        copy_tree_bounded(&plan.working_directory, &internal_working_directory)?;
        let executable_name = plan.executable.file_name().ok_or_else(|| {
            BrokerError::InvalidConfig("sandbox executable has no file name".into())
        })?;
        let internal_executable = internal_bin_directory.join(executable_name);
        fs::copy(&plan.executable, &internal_executable)?;
        if control.cancelled.load(Ordering::Acquire) {
            return Ok(SandboxOutput {
                state: ProcessState::Cancelled,
                exit_code: None,
                stdout: Vec::new(),
                stderr: Vec::new(),
            });
        }

        let (stdin_read, stdin_write) = anonymous_pipe()?;
        let (stdout_read, stdout_write) = anonymous_pipe()?;
        let (stderr_read, stderr_write) = anonymous_pipe()?;
        make_non_inheritable(stdin_write.raw())?;
        make_non_inheritable(stdout_read.raw())?;
        make_non_inheritable(stderr_read.raw())?;
        // Closing the sole write end gives generated code deterministic EOF.
        drop(stdin_write);

        let inherited_handles = [stdin_read.raw(), stdout_write.raw(), stderr_write.raw()];
        let security_capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: appcontainer.sid(),
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let mut attributes = AttributeList::new(2)?;
        attributes.update(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &security_capabilities as *const _ as *mut c_void,
            size_of::<SECURITY_CAPABILITIES>(),
        )?;
        attributes.update(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited_handles.as_ptr() as *mut c_void,
            size_of_val(&inherited_handles),
        )?;

        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_read.raw();
        startup.StartupInfo.hStdOutput = stdout_write.raw();
        startup.StartupInfo.hStdError = stderr_write.raw();
        startup.lpAttributeList = attributes.as_ptr();

        let executable = wide(internal_executable.as_os_str());
        let working_directory = wide(internal_working_directory.as_os_str());
        let mut command_line = command_line_for(&internal_executable, &plan.arguments);
        let mut process: PROCESS_INFORMATION = zeroed();

        if CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            working_directory.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        ) == 0
        {
            return Err(last_io("create AppContainer process"));
        }
        let process_handle = OwnedHandle::new(process.hProcess, "own sandbox process")?;
        let thread_handle = OwnedHandle::new(process.hThread, "own sandbox thread")?;

        // The child is still suspended: assigning the Job cannot race process
        // creation, descendant creation, output, or user code.
        // SAFETY: process_handle owns this process for the duration of assign.
        let borrowed_process = BorrowedHandle::borrow_raw(process_handle.raw() as _);
        if let Err(error) = control.job.assign(borrowed_process) {
            let _ = control.terminate(false);
            return Err(error);
        }

        let total = Arc::new(AtomicUsize::new(0));
        let exceeded = Arc::new(AtomicBool::new(false));
        let stdout_thread = spawn_reader(
            stdout_read.into_raw(),
            plan.limits.max_output_bytes,
            Arc::clone(&total),
            Arc::clone(&exceeded),
        );
        let stderr_thread = spawn_reader(
            stderr_read.into_raw(),
            plan.limits.max_output_bytes,
            Arc::clone(&total),
            Arc::clone(&exceeded),
        );

        // Parent copies must close before waiting or pipe EOF is impossible.
        drop(stdin_read);
        drop(stdout_write);
        drop(stderr_write);

        if ResumeThread(thread_handle.raw()) == u32::MAX {
            let _ = control.terminate(false);
            return Err(last_io("resume sandbox primary thread"));
        }
        drop(thread_handle);

        let deadline = Instant::now() + Duration::from_millis(plan.limits.timeout_ms);
        let mut timed_out = false;
        loop {
            if exceeded.load(Ordering::Acquire) {
                control.terminate(false)?;
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                timed_out = true;
                control.terminate(false)?;
                break;
            }
            let remaining_ms = deadline
                .saturating_duration_since(now)
                .as_millis()
                .min(WAIT_SLICE_MS as u128) as u32;
            match WaitForSingleObject(process_handle.raw(), remaining_ms.max(1)) {
                WAIT_OBJECT_0 => break,
                WAIT_TIMEOUT => continue,
                WAIT_FAILED => return Err(last_io("wait for sandbox process")),
                value => {
                    return Err(BrokerError::SandboxUnavailable(format!(
                        "unexpected sandbox wait result {value}"
                    )))
                }
            }
        }

        // Ensure Job termination has propagated before reader handles are joined.
        if WaitForSingleObject(process_handle.raw(), 5_000) != WAIT_OBJECT_0 {
            return Err(BrokerError::SandboxUnavailable(
                "sandbox process did not terminate after its Job was stopped".into(),
            ));
        }
        let mut exit_code = 0_u32;
        if GetExitCodeProcess(process_handle.raw(), &mut exit_code) == 0 {
            return Err(last_io("read sandbox exit code"));
        }
        drop(process_handle);

        let stdout = stdout_thread
            .join()
            .map_err(|_| BrokerError::SandboxUnavailable("stdout reader panicked".into()))??;
        let stderr = stderr_thread
            .join()
            .map_err(|_| BrokerError::SandboxUnavailable("stderr reader panicked".into()))??;

        if !plan.read_only_root {
            copy_tree_bounded(&internal_working_directory, &plan.working_directory)?;
        }

        let output_exceeded = exceeded.load(Ordering::Acquire);
        let cancelled = control.cancelled.load(Ordering::Acquire);
        let state = if cancelled {
            ProcessState::Cancelled
        } else if output_exceeded {
            ProcessState::OutputLimitExceeded
        } else if timed_out {
            ProcessState::TimedOut
        } else if exit_code == 0 {
            ProcessState::Completed
        } else {
            ProcessState::Failed
        };
        Ok(SandboxOutput {
            state,
            exit_code: Some(exit_code as i32),
            stdout,
            stderr,
        })
    }
}

struct ActiveRegistration<'a> {
    active: &'a Mutex<HashMap<String, Arc<ExecutionControl>>>,
    execution_id: &'a str,
}

impl Drop for ActiveRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(self.execution_id);
        }
    }
}

struct AppContainerSid {
    sid: PSID,
    name: Vec<u16>,
    folder: std::path::PathBuf,
}

impl AppContainerSid {
    unsafe fn acquire() -> Result<Self> {
        // A fresh profile gives every run a different lowbox SID. Even if
        // generated code guesses another stage path, its token cannot open it.
        let profile_name = format!(
            "CupcakeAGI.GeneratedCode.v2.{}",
            uuid::Uuid::now_v7().simple()
        );
        let name = wide(OsStr::new(&profile_name));
        let display = wide(OsStr::new("CupcakeAI generated-code sandbox"));
        let description = wide(OsStr::new(
            "Capability-free identity for staged generated-code execution",
        ));
        let mut sid: PSID = null_mut();
        let created = CreateAppContainerProfile(
            name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        );
        if created < 0 || sid.is_null() {
            return Err(BrokerError::SandboxUnavailable(format!(
                "cannot create one-shot AppContainer identity (HRESULT 0x{:08x})",
                created as u32
            )));
        }
        let mut sid_string = null_mut();
        if ConvertSidToStringSidW(sid, &mut sid_string) == 0 {
            FreeSid(sid);
            let _ = DeleteAppContainerProfile(name.as_ptr());
            return Err(last_io("format AppContainer SID"));
        }
        let mut sid_text = wide_pointer_to_vec(sid_string);
        sid_text.push(0);
        LocalFree(sid_string as *mut c_void);
        let mut folder_pointer = null_mut();
        let folder_result = GetAppContainerFolderPath(sid_text.as_ptr(), &mut folder_pointer);
        if folder_result < 0 || folder_pointer.is_null() {
            FreeSid(sid);
            let _ = DeleteAppContainerProfile(name.as_ptr());
            return Err(BrokerError::SandboxUnavailable(format!(
                "cannot resolve AppContainer folder (HRESULT 0x{:08x})",
                folder_result as u32
            )));
        }
        let folder = std::path::PathBuf::from(String::from_utf16_lossy(&wide_pointer_to_vec(
            folder_pointer,
        )));
        CoTaskMemFree(folder_pointer as *const c_void);
        Ok(Self { sid, name, folder })
    }

    fn sid(&self) -> PSID {
        self.sid
    }

    fn folder(&self) -> &std::path::Path {
        &self.folder
    }
}

impl Drop for AppContainerSid {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            // SAFETY: Userenv returns a SID released by FreeSid.
            unsafe {
                FreeSid(self.sid);
                // Profile deletion removes the private ACL namespace and staged
                // files. A crash can leave an inert orphan profile, never reused.
                let _ = DeleteAppContainerProfile(self.name.as_ptr());
            }
        }
    }
}

struct AttributeList {
    storage: Vec<usize>,
}

impl AttributeList {
    unsafe fn new(count: u32) -> Result<Self> {
        let mut bytes = 0_usize;
        InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        if bytes == 0 {
            return Err(last_io("size process attribute list"));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; words];
        if InitializeProcThreadAttributeList(storage.as_mut_ptr() as _, count, 0, &mut bytes) == 0 {
            return Err(last_io("initialize process attribute list"));
        }
        Ok(Self { storage })
    }

    unsafe fn update(&mut self, attribute: usize, value: *mut c_void, bytes: usize) -> Result<()> {
        if UpdateProcThreadAttribute(
            self.as_ptr(),
            0,
            attribute,
            value,
            bytes,
            null_mut(),
            null_mut(),
        ) == 0
        {
            return Err(last_io("update process attribute list"));
        }
        Ok(())
    }

    fn as_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            // SAFETY: list was initialized and storage remains live.
            unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
        }
    }
}

unsafe fn configure_job(
    limits: &crate::registry::ResourceLimits,
    process_limit: u32,
) -> Result<WindowsJob> {
    let job = OwnedHandle::new(
        CreateJobObjectW(null(), null()),
        "create sandbox Job Object",
    )?;
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    info.BasicLimitInformation.ActiveProcessLimit = process_limit;
    if let Some(memory) = limits.max_memory_bytes {
        let memory = usize::try_from(memory).map_err(|_| {
            BrokerError::InvalidConfig("memory limit does not fit this platform".into())
        })?;
        info.BasicLimitInformation.LimitFlags |=
            JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.ProcessMemoryLimit = memory;
        info.JobMemoryLimit = memory;
    }
    if let Some(cpu_seconds) = limits.max_cpu_seconds {
        let ticks = cpu_seconds.checked_mul(10_000_000).ok_or_else(|| {
            BrokerError::InvalidConfig("CPU time limit overflows Job Object units".into())
        })? as i64;
        info.BasicLimitInformation.LimitFlags |=
            JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_JOB_TIME;
        info.BasicLimitInformation.PerProcessUserTimeLimit = ticks;
        info.BasicLimitInformation.PerJobUserTimeLimit = ticks;
    }
    if SetInformationJobObject(
        job.raw(),
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const c_void,
        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    ) == 0
    {
        return Err(last_io("apply Job Object resource limits"));
    }

    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
            | JOB_OBJECT_UILIMIT_READCLIPBOARD
            | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
            | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
            | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
            | JOB_OBJECT_UILIMIT_GLOBALATOMS
            | JOB_OBJECT_UILIMIT_DESKTOP
            | JOB_OBJECT_UILIMIT_EXITWINDOWS,
    };
    if SetInformationJobObject(
        job.raw(),
        JobObjectBasicUIRestrictions,
        &ui as *const _ as *const c_void,
        size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
    ) == 0
    {
        return Err(last_io("apply Job Object UI restrictions"));
    }
    Ok(WindowsJob { handle: job })
}

unsafe fn anonymous_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if CreatePipe(&mut read, &mut write, &attributes, 0) == 0 {
        return Err(last_io("create sandbox pipe"));
    }
    Ok((
        OwnedHandle::new(read, "own sandbox pipe reader")?,
        OwnedHandle::new(write, "own sandbox pipe writer")?,
    ))
}

unsafe fn make_non_inheritable(handle: HANDLE) -> Result<()> {
    if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0 {
        return Err(last_io("restrict inherited sandbox handles"));
    }
    Ok(())
}

fn spawn_reader(
    handle: HANDLE,
    maximum: usize,
    total: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<Vec<u8>>> {
    // Convert the raw handle back to RAII ownership inside the worker.
    let handle = OwnedHandle(handle);
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let mut read = 0_u32;
            // SAFETY: buffer is writable and the handle is an owned pipe reader.
            let result = unsafe {
                ReadFile(
                    handle.raw(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    null_mut(),
                )
            };
            if result == 0 {
                // SAFETY: GetLastError has no preconditions.
                let error = unsafe { GetLastError() };
                if error == ERROR_BROKEN_PIPE {
                    break;
                }
                return Err(win32_code("read sandbox output", error));
            }
            if read == 0 {
                break;
            }
            let requested = read as usize;
            let prior = total.fetch_add(requested, Ordering::AcqRel);
            let allowed = maximum.saturating_sub(prior).min(requested);
            output.extend_from_slice(&buffer[..allowed]);
            if allowed != requested {
                exceeded.store(true, Ordering::Release);
                break;
            }
        }
        Ok(output)
    })
}

fn command_line_for(executable: &std::path::Path, arguments: &[String]) -> Vec<u16> {
    let mut command = quote_windows_argument(&executable.to_string_lossy());
    for argument in arguments {
        command.push(' ');
        command.push_str(&quote_windows_argument(argument));
    }
    wide(OsStr::new(&command))
}

fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0_usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            quoted.push(character);
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

fn credential_like_environment_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name.contains("SECRET")
        || name.contains("TOKEN")
        || name.contains("PASSWORD")
        || name.contains("CREDENTIAL")
        || name.contains("COOKIE")
        || name.ends_with("_KEY")
        || name == "CUPCAKE_BROKER_AUTH"
        || name == "CUPCAKE_RUNTIME_AUTH"
        || name == "CUPCAKE_PROFILE_KEY"
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

unsafe fn wide_pointer_to_vec(pointer: *const u16) -> Vec<u16> {
    let mut length = 0_usize;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    std::slice::from_raw_parts(pointer, length).to_vec()
}

fn copy_tree_bounded(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
    let source_root = source.canonicalize()?;
    if destination.exists() && fs::symlink_metadata(destination)?.file_type().is_symlink() {
        return Err(BrokerError::PathEscape);
    }
    fs::create_dir_all(destination)?;
    let destination_root = destination.canonicalize()?;
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    copy_tree_entry(
        &source_root,
        &source_root,
        destination,
        &destination_root,
        &mut files,
        &mut bytes,
    )
}

fn copy_tree_entry(
    source_root: &std::path::Path,
    source: &std::path::Path,
    destination: &std::path::Path,
    destination_root: &std::path::Path,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(BrokerError::PathEscape);
    }
    let canonical = source.canonicalize()?;
    if !canonical.starts_with(source_root) {
        return Err(BrokerError::PathEscape);
    }
    if metadata.is_dir() {
        if destination.exists() && fs::symlink_metadata(destination)?.file_type().is_symlink() {
            return Err(BrokerError::PathEscape);
        }
        fs::create_dir_all(destination)?;
        if !destination.canonicalize()?.starts_with(destination_root) {
            return Err(BrokerError::PathEscape);
        }
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree_entry(
                source_root,
                &entry.path(),
                &destination.join(entry.file_name()),
                destination_root,
                files,
                bytes,
            )?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(BrokerError::InvalidConfig(
            "sandbox stage contains a non-file filesystem object".into(),
        ));
    }
    *files = files.saturating_add(1);
    *bytes = bytes.saturating_add(metadata.len());
    if *files > MAX_STAGED_FILES || *bytes > MAX_STAGED_BYTES {
        return Err(BrokerError::InvalidConfig(
            "sandbox stage exceeds file-count or byte limits".into(),
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    if destination.exists() {
        let destination_metadata = fs::symlink_metadata(destination)?;
        if destination_metadata.file_type().is_symlink()
            || !destination.canonicalize()?.starts_with(destination_root)
        {
            return Err(BrokerError::PathEscape);
        }
    }
    fs::copy(source, destination)?;
    Ok(())
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> BrokerError {
    BrokerError::SandboxUnavailable("sandbox cancellation registry is poisoned".into())
}

fn last_io(action: &str) -> BrokerError {
    BrokerError::SandboxUnavailable(format!("{action}: {}", std::io::Error::last_os_error()))
}

fn win32_code(action: &str, code: u32) -> BrokerError {
    BrokerError::SandboxUnavailable(format!(
        "{action}: {}",
        std::io::Error::from_raw_os_error(code as i32)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::ResourceLimits;
    use std::collections::{BTreeMap, BTreeSet};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::Arc;

    fn plan(id: &str, arguments: Vec<String>, stage: PathBuf) -> ResolvedProcessPlan {
        ResolvedProcessPlan {
            execution_id: id.into(),
            executable: std::env::current_exe().unwrap(),
            arguments,
            working_directory: stage,
            environment: BTreeMap::new(),
            network: NetworkPolicy::Denied,
            network_origins: BTreeSet::new(),
            limits: ResourceLimits {
                timeout_ms: 5_000,
                max_output_bytes: 1024 * 1024,
                max_memory_bytes: Some(256 * 1024 * 1024),
                max_cpu_seconds: Some(5),
            },
            read_only_root: false,
        }
    }

    fn probe_arguments() -> Vec<String> {
        vec![
            "--ignored".into(),
            "--exact".into(),
            "sandbox::windows::tests::appcontainer_probe".into(),
            "--nocapture".into(),
        ]
    }

    #[test]
    fn windows_argument_quoting_preserves_boundaries() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(quote_windows_argument("ends\\"), "ends\\");
        assert_eq!(quote_windows_argument("x\"y"), "\"x\\\"y\"");
        assert_eq!(quote_windows_argument("two words\\"), "\"two words\\\\\"");
    }

    #[test]
    fn appcontainer_denies_network_and_credential_environment() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stage = tempfile::tempdir().unwrap();
        let execution = plan(
            "windows-isolation-probe",
            probe_arguments(),
            stage.path().into(),
        );
        fs::write(stage.path().join("probe-port.txt"), port.to_string()).unwrap();
        let output = WindowsSandbox::default().execute(&execution).unwrap();
        assert_eq!(output.state, ProcessState::Completed, "{:?}", output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("CUPCAKE_SANDBOX_NETWORK=denied"),
            "{stdout}"
        );
        assert!(
            stdout.contains("CUPCAKE_SANDBOX_CREDENTIAL_ENV=absent"),
            "{stdout}"
        );
        assert_eq!(
            fs::read_to_string(stage.path().join("probe-result.txt")).unwrap(),
            "contained"
        );
        drop(listener);
    }

    #[test]
    fn timeout_terminates_the_owned_job() {
        let stage = tempfile::tempdir().unwrap();
        let mut execution = plan(
            "windows-timeout-probe",
            probe_arguments(),
            stage.path().into(),
        );
        fs::write(stage.path().join("probe-sleep-ms.txt"), "5000").unwrap();
        execution.limits.timeout_ms = 100;
        let output = WindowsSandbox::default().execute(&execution).unwrap();
        assert_eq!(output.state, ProcessState::TimedOut);
    }

    #[test]
    fn cancellation_terminates_the_owned_job() {
        let stage = tempfile::tempdir().unwrap();
        let execution = plan(
            "windows-cancel-probe",
            probe_arguments(),
            stage.path().into(),
        );
        fs::write(stage.path().join("probe-sleep-ms.txt"), "5000").unwrap();
        let backend = Arc::new(WindowsSandbox::default());
        let worker_backend = Arc::clone(&backend);
        let worker = thread::spawn(move || worker_backend.execute(&execution).unwrap());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match backend.cancel("windows-cancel-probe") {
                Ok(()) => break,
                Err(BrokerError::NotFound(_)) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                result => panic!("cancellation did not become available: {result:?}"),
            }
        }
        assert_eq!(worker.join().unwrap().state, ProcessState::Cancelled);
    }

    #[test]
    fn output_limit_terminates_the_owned_job_and_truncates_capture() {
        let stage = tempfile::tempdir().unwrap();
        let mut execution = plan(
            "windows-output-probe",
            probe_arguments(),
            stage.path().into(),
        );
        fs::write(stage.path().join("probe-output-bytes.txt"), "131072").unwrap();
        execution.limits.max_output_bytes = 1024;
        let output = WindowsSandbox::default().execute(&execution).unwrap();
        assert_eq!(output.state, ProcessState::OutputLimitExceeded);
        assert!(output.stdout.len() + output.stderr.len() <= 1024);
    }

    #[test]
    fn capability_bearing_network_plans_fail_closed() {
        let stage = tempfile::tempdir().unwrap();
        let mut execution = plan("windows-network-fail-closed", vec![], stage.path().into());
        execution.network = NetworkPolicy::LoopbackOnly;
        assert!(matches!(
            WindowsSandbox::default().execute(&execution),
            Err(BrokerError::SandboxUnavailable(_))
        ));
    }

    #[test]
    fn custom_environment_bindings_fail_closed() {
        let stage = tempfile::tempdir().unwrap();
        let mut execution = plan("windows-env-fail-closed", vec![], stage.path().into());
        execution
            .environment
            .insert("CUPCAKE_MODE".into(), "probe".into());
        assert!(matches!(
            WindowsSandbox::default().execute(&execution),
            Err(BrokerError::SandboxUnavailable(_))
        ));
    }

    /// Executed only by the parent tests through the sandbox backend.
    #[test]
    #[ignore]
    fn appcontainer_probe() {
        if let Ok(milliseconds) = fs::read_to_string("probe-sleep-ms.txt") {
            thread::sleep(Duration::from_millis(milliseconds.parse().unwrap()));
        }
        if let Ok(bytes) = fs::read_to_string("probe-output-bytes.txt") {
            println!("{}", "x".repeat(bytes.parse().unwrap()));
        }
        if let Ok(port) = fs::read_to_string("probe-port.txt") {
            let address = format!("127.0.0.1:{}", port.trim()).parse().unwrap();
            let result = TcpStream::connect_timeout(&address, Duration::from_millis(250));
            println!(
                "CUPCAKE_SANDBOX_NETWORK={}",
                if result.is_err() {
                    "denied"
                } else {
                    "available"
                }
            );
        }
        let ambient_present =
            std::env::vars_os().any(|(name, _)| credential_like_environment_name(&name));
        println!(
            "CUPCAKE_SANDBOX_CREDENTIAL_ENV={}",
            if ambient_present { "present" } else { "absent" }
        );
        fs::write("probe-result.txt", "contained").unwrap();
    }
}
