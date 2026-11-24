# Modbus web scanner design

Date: 2026-11-24

## Intent

Create a new web application that reads Modbus data from a device and displays the results. The web server and browser run on the same user's computer at `localhost`. A user can choose Modbus TCP to reach a device on the local network or Modbus RTU over a USB/serial adapter attached to that computer. The interface has two separate sections: a one-time scan and a live view that repeatedly reads discovered addresses.

## Goals

- Select TCP or USB/Serial and enter the corresponding connection settings.
- Scan a user-defined inclusive address range or the entire protocol address space, with progress, cancellation, and clear per-address outcomes.
- Cover the four read-only Modbus data areas: coils, discrete inputs, input registers, and holding registers. The user may select one or more areas per scan; all four are selected by default.
- Show each successfully read address with its area, zero-based protocol address, conventional reference notation, raw value, and last read time. Show failures separately and summarize them without treating an invalid address as a zero value.
- Keep scan results visible until the next scan. In the separate live section, let the user select discovered addresses and poll them at a configurable interval (default 2 seconds). Show value, freshness, and communication errors.
- Keep the UI responsive during long scans. Allow the user to stop scanning or live polling.

## Non-goals

- Writing coils or registers.
- Automatically identifying vendor-specific meaning, units, scaling, signedness, or 32-bit word order from raw register data.
- Discovering devices on a network or guessing serial settings and unit IDs.
- Historical storage, charting, alerts, or multi-user access in the first version.

## Constraints and technical behavior

- TCP reads run on the local web server, which connects from the user's computer to a target IP and port on the LAN. The user supplies host, port (default 502), and unit ID. Bind the server to loopback by default; do not expose its API on the LAN.
- USB/Serial reads run in the user's browser with Web Serial. The user chooses a port through a browser permission prompt, then supplies baud rate, data bits, parity, stop bits, and unit ID. The site requires a supporting desktop browser. `localhost` is a secure context for Web Serial, so local development does not need HTTPS.
- A full scan means addresses 0 through 65535 in each selected area. Its elapsed time can be substantial, especially over RTU. The UI shows an estimated request count before starting and does not run a full scan silently.
- Scan read-only functions 01, 02, 03, and 04. Group contiguous addresses into bounded requests for speed. If a grouped request fails with an illegal address exception, subdivide to find readable addresses; bound retries and timeouts. Do not retry every failing address indefinitely. Handle unsupported functions and transport errors distinctly.
- Respect Modbus request limits. Read requests use at most 125 registers or 2000 bits per request, and the scan algorithm can choose smaller chunks for compatibility.
- Use one outstanding request per device connection to avoid interleaved RTU responses and to be conservative with TCP gateways.
- Treat raw register data as unsigned 16-bit integers and also show hexadecimal. Treat coils and discrete inputs as booleans. Optional manual interpretation of selected adjacent register pairs can be added after the basic scanner works; there is no reliable universal auto-decoding.
- Persist connection settings and the latest snapshot in browser storage, omitting serial port permissions and credentials. Export results to CSV.

## Approach chosen

**Chosen: browser Web Serial for RTU plus server-side TCP.** This matches a USB adapter attached to the browser user's computer and avoids installing a local companion program. The server handles TCP because ordinary web pages cannot directly open arbitrary Modbus TCP sockets.

**Alternative considered: a local companion program for both transports.** It would let TCP connect from the user's local network and broaden browser support, but requires installation and lifecycle management on every user's computer. The user chose the browser approach.

## Components and flow

1. A responsive web UI offers a transport switch, connection settings, area selection, address range/full-scan mode, and a scan action.
2. A shared scan engine schedules bounded address chunks, sends reads through the selected transport, adapts around illegal addresses, and emits progress/result events.
3. The TCP transport calls a server API that opens a connection to the configured Modbus endpoint. The RTU transport builds/parses Modbus RTU frames in the browser and uses Web Serial streams.
4. Snapshot results are displayed in a searchable, filterable table, with a separate failure summary. The live section uses chosen readable addresses from the snapshot and periodically reads those addresses through the same transport. It stops on request or disconnection and marks stale values.
5. The UI includes connection status, informative errors, scan progress, stop controls, and CSV export.

## Remaining builder choices

- Choose a small maintainable frontend/backend stack and implement a local development command.
- Determine exact request chunk sizes, timeout/retry defaults, and table virtualization or pagination based on performance tests.
- Add automated tests using a simulated Modbus device for scan splitting, protocol parsing, cancellation, and live polling. Manual hardware testing requires an actual device and browser serial permission.

## Acceptance criteria

- A user can configure TCP or USB/Serial and read known values from a Modbus simulator or device.
- Both custom-range and full-range scans work for selected areas and distinguish readable, invalid, and failed addresses.
- Snapshot results remain until another scan; live view updates chosen values at the configured interval and handles a disconnected device visibly.
- Long scans show progress and can be stopped without leaving a locked port or busy task.
- The interface explains Web Serial support and HTTPS/localhost requirements when unavailable.
