// machine-sys — thin, pure Rust syscalls for the machine aio app.
//
// Design: the host (Deno) owns all I/O — it reads /sys, /proc and runs
// lspci/lsusb/ip/df — and passes the raw bytes into WASM. The Rust layer is
// PURE: it parses, normalizes, and emits compact JSON. No std::process, no
// std::fs inside WASM (wasm32-unknown-unknown has neither). This keeps the
// syscall boundary cheap, cacheable, and testable from Rust tests with plain
// string fixtures.
//
// Memory protocol: every exported syscall takes (ptr, len) byte-slices and
// returns a length-prefixed (4-byte LE length + UTF-8) heap allocation the host
// reads via str_len(ptr) and frees via free_str(ptr).

#![allow(clippy::needless_return, clippy::too_many_lines)]

// (no std imports needed — pure string parsing only)

// ── host-provided imports ────────────────────────────────────────────────
mod ffi {
    use std::os::raw::c_char;
    #[link(wasm_import_module = "env")]
    extern "C" {
        #[link_name = "vmlog"]
        pub fn vmlog(ptr: *const c_char, len: usize);
    }
}

fn log_host(msg: &str) {
    unsafe { ffi::vmlog(msg.as_ptr() as *const std::os::raw::c_char, msg.len()) };
}

// ── memory helpers ────────────────────────────────────────────────────────

fn return_str(s: String) -> *mut u8 {
    let bytes = s.into_bytes();
    let len = bytes.len();
    unsafe {
        let layout = std::alloc::Layout::from_size_align_unchecked(len + 4, 4);
        let base = std::alloc::alloc(layout);
        if base.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        std::ptr::write_unaligned(base as *mut u32, len as u32);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), base.add(4), len);
        // Return pointer to the string DATA; the 4-byte LE length lives 4 bytes
        // before it (at base+0). str_len/free_str use ptr.sub(4) to find it.
        base.add(4)
    }
}

fn read_slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

fn read_str<'a>(ptr: *const u8, len: usize) -> &'a str {
    let bytes = read_slice(ptr, len);
    std::str::from_utf8(bytes).unwrap_or("")
}

// ── escape + tiny json builder ────────────────────────────────────────────

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn json_pair(key: &str, value: &str, is_literal: bool) -> String {
    let mut s = String::new();
    s.push_str(&esc(key));
    s.push(':');
    if is_literal {
        s.push_str(value);
    } else {
        s.push_str(&esc(value));
    }
    s
}

fn join(parts: &[String]) -> String {
    parts.join(",")
}

// ── CPU ──────────────────────────────────────────────────────────────────
// Inputs: cpuinfo (full /proc/cpuinfo), stat_line (first line of /proc/stat),
// hwmon (concatenated name+temp inputs; the host passes a stable textual
// representation). Returns compact JSON.

#[no_mangle]
pub extern "C" fn sys_cpu(cpuinfo: *const u8, cpuinfo_len: usize, stat_full: *const u8, stat_len: usize, hwmon: *const u8, hwmon_len: usize) -> *mut u8 {
    let _ = log_host;
    let cpuinfo = read_str(cpuinfo, cpuinfo_len);
    let stat_full = read_str(stat_full, stat_len);
    let hwmon = read_str(hwmon, hwmon_len);

    let model = cpuinfo.lines().find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1).map(|s| s.trim().to_string()))
        .unwrap_or_default();
    let cores = cpuinfo.matches("processor").count();

    // CPU temps from hwmon block; host passes lines like "name\ntemp1_input\n..."
    let mut cpu_temp: f64 = 0.0;
    let mut lines = hwmon.lines();
    while let Some(name) = lines.next() {
        if !(name.contains("coretemp") || name.contains("k10temp") || name.contains("cpu_thermal") || name.contains("zenpower") || name == "core") {
            continue;
        }
        if let Some(t) = lines.next() {
            if let Ok(v) = t.trim().parse::<f64>() {
                cpu_temp = v / 1000.0;
                break;
            }
        }
    }

    // Per-core stat lines: "cpu0 ...", "cpu1 ...". Return the raw lines so the
    // host can compute per-core utilization deltas across samples.
    let core_stats: Vec<String> = stat_full.lines()
        .filter(|l| l.starts_with("cpu") && l.chars().nth(3).map_or(false, |c| c.is_ascii_digit()))
        .map(|l| l.to_string())
        .collect();
    let aggregate = stat_full.lines().next().unwrap_or("").to_string();

    let mut m: Vec<(String, String, bool)> = Vec::new();
    m.push(("model".into(), model, false));
    m.push(("cores".into(), cores.to_string(), true));
    m.push(("stat".into(), aggregate, false));
    m.push(("core_stats".into(), format!("[{}]", core_stats.iter().map(|s| esc(s)).collect::<Vec<_>>().join(",")), true));
    m.push(("temp_c".into(), format!("{:.1}", cpu_temp), true));
    // util_pct + cores_util: the host computes from deltas of two samples.
    // Default 0 here; the cell stamps real values after parsing.
    m.push(("util_pct".into(), "0".to_string(), true));
    m.push(("cores_util".into(), "[]".to_string(), true));
    return_str(json_obj(&m))
}

// ── Memory ───────────────────────────────────────────────────────────────
// Input: /proc/meminfo contents.

#[no_mangle]
pub extern "C" fn sys_mem(meminfo: *const u8, len: usize) -> *mut u8 {
    let info = read_str(meminfo, len);
    let mut total_kb: u64 = 0;
    let mut avail_kb: u64 = 0;
    for line in info.lines() {
        if line.starts_with("MemTotal:") {
            total_kb = line.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        } else if line.starts_with("MemAvailable:") {
            avail_kb = line.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        }
    }
    let used_kb = total_kb.saturating_sub(avail_kb);
    let used_pct = if total_kb > 0 { (used_kb as f64 / total_kb as f64) * 100.0 } else { 0.0 };
    let m: Vec<(String, String, bool)> = vec![
        ("total_kb".into(), total_kb.to_string(), true),
        ("available_kb".into(), avail_kb.to_string(), true),
        ("used_kb".into(), used_kb.to_string(), true),
        ("used_pct".into(), format!("{:.1}", used_pct), true),
    ];
    return_str(json_obj(&m))
}

// ── Motherboard / BIOS ────────────────────────────────────────────────────
// Inputs: the four DMI files + hwmon block (name\ntemp pairs).

#[no_mangle]
pub extern "C" fn sys_board(
    board_name: *const u8, bn_len: usize,
    board_vendor: *const u8, bv_len: usize,
    board_version: *const u8, bver_len: usize,
    bios_vendor: *const u8, bven_len: usize,
    bios_version: *const u8, bbver_len: usize,
    bios_date: *const u8, bd_len: usize,
    product_name: *const u8, pn_len: usize,
    hwmon: *const u8, hw_len: usize,
) -> *mut u8 {
    let s = |p: *const u8, l: usize| read_str(p, l).to_string();
    let hwmon = read_str(hwmon, hw_len);

    let mut temps: Vec<String> = Vec::new();
    let mut lines = hwmon.lines();
    while let Some(name) = lines.next() {
        if name.starts_with("nct") || name.contains("acpi") || name == "nvme" || name.contains("board") {
            while let Some(t) = lines.next() {
                if t.is_empty() { break; }
                if let Ok(v) = t.trim().parse::<f64>() {
                    temps.push(format!("{:.1}", v / 1000.0));
                }
            }
            break;
        }
    }

    let m: Vec<(String, String, bool)> = vec![
        ("board_name".into(), s(board_name, bn_len), false),
        ("board_vendor".into(), s(board_vendor, bv_len), false),
        ("board_version".into(), s(board_version, bver_len), false),
        ("bios_vendor".into(), s(bios_vendor, bven_len), false),
        ("bios_version".into(), s(bios_version, bbver_len), false),
        ("bios_date".into(), s(bios_date, bd_len), false),
        ("product_name".into(), s(product_name, pn_len), false),
        ("temps_c".into(), format!("[{}]", temps.join(",")), true),
    ];
    return_str(json_obj(&m))
}

// ── GPU ──────────────────────────────────────────────────────────────────
// Input: nvidia-smi csv output (or empty). The host already tried AMD/Intel
// hwmon and may pass a combined block; we parse nvidia-smi first.

#[no_mangle]
pub extern "C" fn sys_gpu(nvidia_smi: *const u8, len: usize, hwmon: *const u8, hw_len: usize) -> *mut u8 {
    let nvidia = read_str(nvidia_smi, len);
    let hwmon = read_str(hwmon, hw_len);
    let mut gpus: Vec<String> = Vec::new();
    for line in nvidia.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() >= 5 {
            gpus.push(format!(
                r#"{{"name":{},"temp_c":{},"util_pct":{},"mem_total_mb":{},"mem_used_mb":{}}}"#,
                esc(parts[0]), parts[1], parts[2], parts[3], parts[4]
            ));
        }
    }
    // hwmon block for AMD/Intel: "name\nfreq\nutil\ntemp\n" per device
    let mut lines = hwmon.lines();
    while let Some(name) = lines.next() {
        if name.is_empty() { continue; }
        let temp = lines.next().and_then(|t| t.trim().parse::<f64>().ok()).map(|v| v/1000.0).unwrap_or(0.0);
        let util = lines.next().and_then(|u| u.trim().parse::<i64>().ok()).unwrap_or(0);
        lines.next(); // skip freq placeholder
        if !name.is_empty() {
            gpus.push(format!(
                r#"{{"name":{},"temp_c":{:.1},"util_pct":{},"mem_total_mb":0,"mem_used_mb":0}}"#,
                esc(name), temp, util
            ));
        }
    }
    return_str(format!(r#"{{"gpus":[{}]}}"#, join(&gpus)))
}

// ── Disk ─────────────────────────────────────────────────────────────────
// Input: `df -P -B1` output. We filter to real filesystems and emit per-mount.

#[no_mangle]
pub extern "C" fn sys_disk(df: *const u8, len: usize) -> *mut u8 {
    let df = read_str(df, len);
    let mut mounts: Vec<String> = Vec::new();
    let mut root_total: u64 = 0;
    let mut root_used: u64 = 0;
    let mut root_pct: f64 = 0.0;
    for line in df.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 { continue; }
        // skip header
        if cols[0] == "Filesystem" { continue; }
        let mp = cols[5];
        let total: u64 = cols[1].parse().unwrap_or(0);
        let used: u64 = cols[2].parse().unwrap_or(0);
        let pct: f64 = cols[4].trim_end_matches('%').parse::<f64>().unwrap_or(0.0);
        mounts.push(format!(
            r#"{{"mount":{},"total_b":{},"used_b":{},"used_pct":{:.1}}}"#,
            esc(mp), total, used, pct
        ));
        if mp == "/" {
            root_total = total;
            root_used = used;
            root_pct = pct;
        }
    }
    return_str(format!(
        r#"{{"root_total_b":{},"root_used_b":{},"root_used_pct":{:.1},"mounts":[{}]}}"#,
        root_total, root_used, root_pct, join(&mounts)
    ))
}

// ── Memory DIMMs ──────────────────────────────────────────────────────────
// Input: `dmidecode -t memory` output. Parses Memory Device (type 17) entries
// into {locator, size, speed, type}. The host passes the raw text; if dmidecode
// isn't available or needs root, the host passes "" and we return an empty array.

#[no_mangle]
pub extern "C" fn sys_dimms(raw: *const u8, len: usize) -> *mut u8 {
    let out = read_str(raw, len);
    let mut dimms: Vec<String> = Vec::new();
    // dmidecode blocks are separated by blank lines; each "Memory Device" block
    // has fields like "Size: 32 GB", "Speed: 5600 MT/s", "Locator: DIMM 0", "Type: DDR5".
    let mut current: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            // end of block — if it had a Size, emit it
            if let Some(size) = current.get("Size") {
                if !size.contains("No Module") && !size.contains("Unknown") {
                    let locator = current.get("Locator").cloned().unwrap_or_default();
                    let speed = current.get("Speed").cloned().unwrap_or_default();
                    let dtype = current.get("Type").cloned().unwrap_or_default();
                    dimms.push(format!(
                        r#"{{"locator":{},"size":{},"speed":{},"type":{}}}"#,
                        esc(&locator), esc(size), esc(&speed), esc(&dtype)
                    ));
                }
            }
            current.clear();
            continue;
        }
        // "Memory Device" header line — start of a new block
        if line == "Memory Device" {
            current.clear();
            continue;
        }
        if let Some(idx) = line.find(':') {
            let key = line[..idx].trim();
            let val = line[idx + 1..].trim();
            current.insert(key, val.to_string());
        }
    }
    // flush last block
    if let Some(size) = current.get("Size") {
        if !size.contains("No Module") && !size.contains("Unknown") {
            let locator = current.get("Locator").cloned().unwrap_or_default();
            let speed = current.get("Speed").cloned().unwrap_or_default();
            let dtype = current.get("Type").cloned().unwrap_or_default();
            dimms.push(format!(
                r#"{{"locator":{},"size":{},"speed":{},"type":{}}}"#,
                esc(&locator), esc(size), esc(&speed), esc(&dtype)
            ));
        }
    }
    return_str(format!(r#"[{}]"#, join(&dimms)))
}

// ── lspci / lsusb ─────────────────────────────────────────────────────────
// Inputs: raw `lspci -nnmm` and `lsusb` output.

#[no_mangle]
pub extern "C" fn sys_lspci(raw: *const u8, len: usize) -> *mut u8 {
    let out = read_str(raw, len);
    // `lspci -nnmm` is quote-delimited, NOT space-delimited:
    //   00:00.0 "Host bridge [0600]" "Advanced Micro Devices [AMD] [1022]" "Device [14d8]" -p00 ...
    // Splitting on spaces mangles the fields, so pull the quoted segments in
    // order: [0]=class, [1]=vendor, [2]=device. Everything after (rev/progif/
    // subsystem) is ignored.
    let lines: Vec<String> = out
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut fields: Vec<String> = Vec::new();
            let mut in_q = false;
            let mut cur = String::new();
            for ch in l.chars() {
                if ch == '"' {
                    if in_q {
                        fields.push(cur.clone());
                        cur.clear();
                    }
                    in_q = !in_q;
                } else if in_q {
                    cur.push(ch);
                }
            }
            let class = fields.first().map(|s| s.as_str()).unwrap_or("");
            let vendor = fields.get(1).map(|s| s.as_str()).unwrap_or("");
            let name = fields.get(2).map(|s| s.as_str()).unwrap_or("");
            format!(
                r#"{{"class":{},"vendor":{},"name":{}}}"#,
                esc(class),
                esc(vendor),
                esc(name)
            )
        })
        .collect();
    return_str(format!(r#"[{}]"#, join(&lines)))
}

#[no_mangle]
pub extern "C" fn sys_lsusb(raw: *const u8, len: usize) -> *mut u8 {
    let out = read_str(raw, len);
    let lines: Vec<String> = out.lines().map(|l| {
        let l = l.trim();
        let parts: Vec<&str> = l.splitn(7, ' ').collect();
        let bus = parts.get(1).copied().unwrap_or("");
        let dev = parts.get(3).map(|s| s.trim_end_matches(':')).unwrap_or("");
        let id = parts.get(5).copied().unwrap_or("");
        let name = parts.get(6).copied().unwrap_or("");
        format!(r#"{{"bus":{},"dev":{},"id":{},"name":{}}}"#, esc(bus), esc(dev), esc(id), esc(name))
    }).collect();
    return_str(format!(r#"[{}]"#, join(&lines)))
}

// ── Network / VPN / Firewall ──────────────────────────────────────────────
// Inputs: `ip -j -br addr` (json), `ip -j -br link` (json), default route text,
// firewall state string ("nftables"|"ufw:active"|"ufw:inactive"|"firewalld"|"none").

#[no_mangle]
pub extern "C" fn sys_net(
    addr_json: *const u8, aj_len: usize,
    link_json: *const u8, lj_len: usize,
    route: *const u8, r_len: usize,
    fw_state: *const u8, fw_len: usize,
    speed_info: *const u8, si_len: usize,
) -> *mut u8 {
    let addrs = read_str(addr_json, aj_len);
    let links = read_str(link_json, lj_len);
    let route = read_str(route, r_len);
    let fw_state = read_str(fw_state, fw_len);
    let speed_info = read_str(speed_info, si_len);

    // VPN detection: tun/wg/ppp/tap/nordlynx/ipsec/openvpn interface names,
    // OR POINTOPOINT flag in the link json (NordVPN's nordlynx shows this).
    let vpn_patterns = ["\"tun", "\"wg", "\"ppp", "\"tap", "\"nordlynx", "\"ipsec", "\"openvpn"];
    let vpn = vpn_patterns.iter().any(|p| links.contains(p))
        || links.contains("\"POINTOPOINT\"");
    let (fw_backend, fw_active) = match fw_state {
        "nftables" => ("nftables", true),
        "firewalld" => ("firewalld", true),
        s if s.starts_with("ufw:active") => ("ufw", true),
        s if s.starts_with("ufw:inactive") => ("ufw", false),
        _ => ("none", false),
    };

    // speed_info is a JSON object the host builds: {"link_max_mbps":N,"rx_mbps":N,"tx_mbps":N}
    // If empty, emit zeros.
    let speed = if speed_info.is_empty() { r#"{"link_max_mbps":0,"rx_mbps":0,"tx_mbps":0}"#.to_string() } else { speed_info.to_string() };

    return_str(format!(
        r#"{{"addrs":{},"links":{},"vpn":{},"firewall":{{"backend":{},"active":{}}},"default_route":{},"speed":{}}}"#,
        if addrs.is_empty() { "[]".to_string() } else { addrs.to_string() },
        if links.is_empty() { "[]".to_string() } else { links.to_string() },
        vpn,
        esc(fw_backend), fw_active,
        esc(route),
        speed
    ))
}

// ── json obj builder ──────────────────────────────────────────────────────

fn json_obj(fields: &[(String, String, bool)]) -> String {
    let parts: Vec<String> = fields.iter().map(|(k, v, lit)| json_pair(k, v, *lit)).collect();
    format!("{{{}}}", join(&parts))
}

// ── memory management exports ─────────────────────────────────────────────

// Host calls alloc(len) to get a WASM-memory pointer, writes input bytes there
// (via the shared memory buffer), then passes that pointer to a sys_* fn.
// Outputs from sys_* are length-prefixed; host reads via str_len + the memory
// buffer, then frees with free_str.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    unsafe {
        let layout = std::alloc::Layout::from_size_align_unchecked(len, 4);
        let ptr = std::alloc::alloc(layout);
        if ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        ptr
    }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() { return; }
    unsafe {
        let layout = std::alloc::Layout::from_size_align_unchecked(len, 4);
        std::alloc::dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn str_len(ptr: *mut u8) -> usize {
    if ptr.is_null() { return 0; }
    unsafe { std::ptr::read_unaligned(ptr.sub(4) as *const u32) as usize }
}

#[no_mangle]
pub extern "C" fn free_str(ptr: *mut u8) {
    if ptr.is_null() { return; }
    unsafe {
        let len = std::ptr::read_unaligned(ptr.sub(4) as *const u32) as usize;
        let layout = std::alloc::Layout::from_size_align_unchecked(len + 4, 4);
        // ptr points at the data (base+4); dealloc needs the allocation base.
        std::alloc::dealloc(ptr.sub(4), layout);
    }
}

// ── unit tests (run with `cargo test` from rust/) ─────────────────────────
// Pure functions over string fixtures — prove the parsers work without any
// host or I/O. This is the "flawless future testability" the universal kata asks for.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo() {
        let mem = "MemTotal:       16384000 kB\nMemFree:          8000000 kB\nMemAvailable:    9000000 kB\n";
        let out_ptr = sys_mem(mem.as_ptr(), mem.len());
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""total_kb":16384000"#), "got: {s}");
        assert!(s.contains(r#""used_kb":7384000"#), "got: {s}");
        free_str(out_ptr);
    }

    #[test]
    fn parses_lsusb() {
        let raw = "Bus 001 Device 002: ID 1234:5678 USB Hub\nBus 002 Device 001: ID 0001:0002 Mouse\n";
        let out_ptr = sys_lsusb(raw.as_ptr(), raw.len());
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""bus":"001""#), "got: {s}");
        assert!(s.contains(r#""name":"USB Hub""#), "got: {s}");
        free_str(out_ptr);
    }

    #[test]
    fn detects_vpn() {
        // nordlynx interface (NordVPN) — must be detected
        let links = r#"[{"ifname":"nordlynx","flags":["POINTOPOINT","UP"]},{"ifname":"enp8s0"}]"#;
        let out_ptr = sys_net(
            std::ptr::null(), 0,           // addr_json
            links.as_ptr(), links.len(),   // link_json
            std::ptr::null(), 0,           // route
            "none".as_ptr(), 4,            // fw_state
            std::ptr::null(), 0,           // speed_info
        );
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""vpn":true"#), "nordlynx should be detected as VPN; got: {s}");
        free_str(out_ptr);
    }

    #[test]
    fn detects_pointtopoint_vpn() {
        // POINTOPOINT flag without a known VPN interface name
        let links = r#"[{"ifname":"wg0","flags":["POINTOPOINT","UP"]}]"#;
        let out_ptr = sys_net(
            std::ptr::null(), 0,
            links.as_ptr(), links.len(),
            std::ptr::null(), 0,
            "none".as_ptr(), 4,
            std::ptr::null(), 0,
        );
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""vpn":true"#), "POINTOPOINT should be detected as VPN; got: {s}");
        free_str(out_ptr);
    }

    #[test]
    fn parses_lspci_nnmm() {
        // quote-delimited -nnmm line with trailing rev/progif fields
        let raw = concat!(
            "00:00.0 \"Host bridge [0600]\" ",
            "\"Advanced Micro Devices, Inc. [AMD] [1022]\" \"Device [14d8]\" -p00\n",
            "03:00.0 \"VGA compatible controller [0300]\" \"NVIDIA Corporation [10de]\" \"AD104 [2704]\"\n",
        );
        let out_ptr = sys_lspci(raw.as_ptr(), raw.len());
        let len = str_len(out_ptr);
        let s =
            unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""class":"Host bridge [0600]""#), "got: {s}");
        assert!(
            s.contains(r#""vendor":"Advanced Micro Devices, Inc. [AMD] [1022]""#),
            "got: {s}"
        );
        assert!(s.contains(r#""name":"Device [14d8]""#), "got: {s}");
        assert!(s.contains(r#""class":"VGA compatible controller [0300]""#), "got: {s}");
        free_str(out_ptr);
    }

    #[test]
    fn parses_dimms() {
        let raw = "Memory Device\n\tSize: 32 GB\n\tSpeed: 5600 MT/s\n\tType: DDR5\n\tLocator: DIMM 0\n\nMemory Device\n\tSize: No Module Installed\n\tLocator: DIMM 1\n\n";
        let out_ptr = sys_dimms(raw.as_ptr(), raw.len());
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(s.contains(r#""size":"32 GB""#), "got: {s}");
        assert!(s.contains(r#""speed":"5600 MT/s""#), "got: {s}");
        assert!(!s.contains("No Module"), "empty slots should be excluded; got: {s}");
        free_str(out_ptr);
    }
}