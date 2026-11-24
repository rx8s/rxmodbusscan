# Modbus Web Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a localhost web app that scans Modbus TCP devices on the LAN or Modbus RTU devices on the browser user's USB/serial port, with separate snapshot and live views.

**Architecture:** A zero-dependency Node server binds to loopback, serves static files, and exposes one bounded TCP read endpoint. Browser ES modules implement RTU over Web Serial, the shared scan algorithm, live polling, storage, and UI. Both transports return the same read result shape.

**Tech Stack:** Node.js 22 built-in `net`, `http`, `node:test`; browser JavaScript ES modules and Web Serial; HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-11-24-modbus-web-scanner-design.md`

## Global Constraints

- The server binds to `127.0.0.1` by default; its TCP target can be on the LAN.
- Read-only function codes 01, 02, 03, 04; one outstanding request per connection.
- Full scan covers addresses 0–65535 in each selected area, with explicit start, progress, and stop.
- Snapshot and live views remain separate; live polls selected readable addresses at default 2 seconds.
- The first release displays raw register values and hex, without guessing units or scaling.

## Review Focus

- A short or mismatched TCP response fails cleanly rather than yielding incorrect values (Task 1).
- A truncated or CRC-invalid RTU response fails cleanly and releases the serial reader (Task 2).
- Illegal address in a grouped read is subdivided without hiding valid neighbors (Task 3).
- An unsupported area does not trigger 65536 individual requests (Task 3).
- Cancellation stops further requests and releases resources (Tasks 2 and 3).

---

### Task 1: Modbus Protocol and TCP API

**Files:** `package.json`, `src/protocol.js`, `src/tcp-client.js`, `src/server.js`, `test/protocol.test.js`, `test/tcp.test.js`

**Interfaces:** `readTcp({host,port,unitId,functionCode,address,count,timeoutMs}) -> Promise<number[]>`; `decodeValues(functionCode, data, count) -> number[]`; `ModbusError` with `kind` and optional `exceptionCode`.

- [ ] Write protocol and mock TCP server tests for register/bit decoding, MBAP transaction matching, short responses, exception replies, and input validation.
- [ ] Run `npm test`; verify tests fail for missing modules.
- [ ] Implement request/response validation and the localhost HTTP endpoint `POST /api/read`.
- [ ] Run `npm test`; verify protocol and TCP tests pass.

### Task 2: Browser RTU Transport

**Files:** `web/rtu.js`, `test/rtu.test.js`

**Interfaces:** `RtuClient.open(port, settings)`, `.read({unitId,functionCode,address,count,timeoutMs}) -> Promise<number[]>`, `.close()`; CRC and RTU frame helpers exported for tests.

- [ ] Write tests for CRC/frame construction, split response chunks, exception, bad CRC, timeout, and close.
- [ ] Run `npm test`; verify RTU tests fail.
- [ ] Implement Web Serial request serialization and bounded response framing.
- [ ] Run `npm test`; verify RTU tests pass.

### Task 3: Scan and Live Logic

**Files:** `web/scan.js`, `web/live.js`, `test/scan.test.js`, `test/live.test.js`

**Interfaces:** `scan({read,areas,start,end,signal,onProgress,onResult}) -> Promise<summary>`; `createLivePoller({read,onUpdate,onError})` with start/stop methods.

- [ ] Write tests for custom/full range scheduling, illegal-address splitting, unsupported function, transport failure, cancellation, and live selection/stop.
- [ ] Run `npm test`; verify missing behavior fails.
- [ ] Implement bounded sequential reads and live polling.
- [ ] Run `npm test`; verify logic tests pass.

### Task 4: Web UI and Local Run

**Files:** `web/index.html`, `web/style.css`, `web/app.js`, `README.md`, `test/server.test.js`

**Interfaces:** Browser UI calls the shared `scan` and `createLivePoller` APIs; TCP transport calls `POST /api/read`; RTU uses `RtuClient`.

- [ ] Write server smoke test for loopback/static serving and a browser-facing manual check list.
- [ ] Run `npm test`; verify server smoke test fails.
- [ ] Build connection, scan, snapshot, live, progress, stop, CSV, persistence, and error UI.
- [ ] Run `npm test` and a local HTTP smoke check; inspect browser behavior if a compatible browser surface is available.

### Task 5: Final Verification

**Files:** all above

- [ ] Check spec coverage against implemented UI and tests.
- [ ] Run full tests and inspect final file tree and HTTP response.
- [ ] Document hardware test limits and launch instructions.
