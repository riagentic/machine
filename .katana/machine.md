# Machine md kata

## General

- machine electron app built in aio framework showing machine (PC) with hardware
  details
- system calls are writtein in Rust and used in the app as WASM
- app is compact, small windows, small font, very compacted designed, as many
  information on small areas as possible
- ergonomic, visually aesthetic, cool, animated, interactive and reactive
- all that can be in interactive graphical or animated way is done like that
- every metric panel has at least one graphical/animated element (bar,
  sparkline, or transition)
- themed in solana colors, cool and appealing
- app is responding
- app is not freezing or blocking underlying PC/OS
- app is primarily working in Linux (but Windows and OSX is suppported too)

## Hw Details app shows

- CPU and curent temperatures utilization
- Memory and current tempeatures (if possible) and utilization
- DIMM listing degrades to an empty list (never an error) when unavailable
  (non-Linux, no dmidecode, no root)
- Motherboard and current temperatures if possible (also bios data)
- GPU and utilization (utilization and temperature)
- Disk space free/total
- HW List integrated (lspci, etc.)
- Hw List plugged (lsusb, etc.)
- Network information (ip addresses, vpn info, firewal info)
- Security posture (listening ports, suspicious processes, hardening settings)

## CPU

- Total cpu is shown as line chart (100px height) showing current value and
  history per second
- Each core is represented by small box in color according to it's utilization
  (cyan = low to 25% utilization, lime = 25-50%, yellow=50-75%, and red 75%-100%

## Motherboard

- Motherboard shows: board, version, product, bios, bios date, number of USB
  ports, number of occupied memory slots vs available

## Disk

- Shows total vs used (pie chart)
- Shows all partitions (as progress bar, cyan under 50% space utilization, green
  under 75% space utilization, yellow under 90% and red under 100%

## Gpu

- show model
- shows utilization
- shows memory utilization

## Security

- security card shows a 0-100 posture score (ring gauge): hardening checks 50 ·
  open-port exposure 20 · clean process list 15 · firewall 10 · vpn 5
- hardening checks: ASLR, ptrace scope, kptr/dmesg restrict, IP forwarding,
  unprivileged BPF, SSH root login, SSH password auth, Secure Boot, disk
  encryption, pending updates
- a check whose input is unreadable is OMITTED, never shown as failing (no false
  alarms on locked-down boxes)
- listening ports shown as pills: 🌐 exposed (bound beyond loopback) vs 🔒
  loopback-only
- suspicious processes (world-writable exec dirs, cryptominers, netcat
  listeners, reverse-shell patterns) are CRIT issues in the TODO card
- all judgment lives in the Rust parser (pure, fixture-tested); the host only
  gathers text (ss/ps//proc/sys/sshd_config/mokutil/lsblk)

## Temperature

- temperature is shown as number, cyan for cold (less than 50% of maximum
  temperature, yellow for 50-90%, and red beyond that

## UI

- every section has cool svg image representing its area (CPU, GPU, etc.)
