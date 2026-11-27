# Modbus Scan

[![Tests](https://github.com/rx8s/rxmodbusscan/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/rx8s/rxmodbusscan/actions/workflows/test.yml)

ภาษาไทย · [English](#english)

เว็บแอปสำหรับสแกน Modbus แบบอ่านอย่างเดียว รันบนเครื่องผู้ใช้ผ่าน `localhost` และอ่านอุปกรณ์ได้สองแบบ:

- **Modbus TCP:** เซิร์ฟเวอร์ในเครื่องเชื่อมต่อไปยัง IP/port ของอุปกรณ์ใน LAN
- **Modbus RTU:** เบราว์เซอร์อ่าน USB/Serial ที่เสียบกับเครื่องผู้ใช้ผ่าน Web Serial

## เริ่มใช้งาน

ต้องมี Node.js 22.13 ขึ้นไป ไม่ต้องติดตั้งแพ็กเกจเพิ่ม

```bash
npm start
```

เปิด [http://localhost:8876](http://localhost:8876) ใน Chrome บนคอมพิวเตอร์ หากต้องการใช้พอร์ตอื่น ให้รัน `PORT=9000 npm start` แล้วเปิด `http://localhost:9000`

สำหรับ USB/Serial ให้เลือกชนิดการเชื่อมต่อ กำหนด Baud rate, Data bits, Stop bits, Parity, Unit ID แล้วกด **เลือกพอร์ต USB / Serial** เพื่ออนุญาตพอร์ตในเบราว์เซอร์ Web Serial ต้องใช้เบราว์เซอร์ที่รองรับและหน้าเว็บบน `localhost` หรือ HTTPS

## การสแกน

1. เลือก TCP หรือ USB/Serial และกรอกค่าการเชื่อมต่อ
2. เลือก **กำหนดช่วงเอง** หรือ **สแกนทั้งหมด** (address 0–65535)
3. เลือกพื้นที่ข้อมูล Coils, Discrete inputs, Holding registers, Input registers
4. กด **เริ่มสแกน** ดูความคืบหน้า แล้วหยุดได้ระหว่างทำงาน
5. ตาราง **ผลสแกนครั้งเดียว** แสดง address ที่อ่านได้ ค่าแบบดิบ และ hex; ส่งออก CSV ได้
6. เลือกช่อง LIVE ของ address ที่ต้องการ แล้วเปิดหมวด **ค่าสด** เพื่อกำหนดช่วงเวลาอ่านซ้ำและเริ่มติดตาม

แอปบันทึกทุกรอบสแกนและประวัติค่าสดลงไฟล์ SQLite ที่ `data/modbus-scan.db` โดยอัตโนมัติหลังสแกนจบหรือหยุด หน้าจอโหลดรอบสแกนล่าสุดจากไฟล์นี้เมื่อเปิดใหม่ และจะย้ายผลเก่าจาก IndexedDB ของเบราว์เซอร์เข้าฐานข้อมูลครั้งแรกหากยังไม่มีข้อมูล ส่วนค่าตั้งค่ายังเก็บในเบราว์เซอร์ การอ่าน Serial สดต้องเลือกพอร์ตและสแกนใหม่ การสแกนทั้งหมดโดยเฉพาะผ่าน Serial อาจใช้เวลานานมาก และการอ่านค่าสดรองรับสูงสุด 500 address ต่อครั้ง

การทำงานที่ช่วยลดภาระอุปกรณ์:

- **โหมดเร็ว** (ใต้ประเภทข้อมูล): ไม่แตกบล็อกที่อ่านไม่ได้ให้เล็กกว่า 8 address ทำให้สแกนอุปกรณ์ที่มี address น้อยได้เร็วขึ้นมาก แต่ address ที่อ่านได้ซึ่งอยู่ติดกับช่วงที่อ่านไม่ได้อาจถูกข้าม ตัวประมาณด้านซ้ายแสดงจำนวนคำขอต่ำสุด–สูงสุด
- การสแกนหยุดเองเมื่อสื่อสารกับอุปกรณ์ไม่สำเร็จติดกัน 5 ครั้ง (เช่น IP/Port ผิด หรือสายหลุด)
- Modbus TCP ใช้ connection เดียวต่อ host:port และส่งคำขอทีละรายการ connection ที่ว่างเกิน 5 วินาทีจะถูกปิด
- ค่าสดที่ address ติดกันและประเภทเดียวกันจะอ่านรวมในคำขอเดียว หากอุปกรณ์ปฏิเสธจะกลับไปอ่านทีละ address
- ประวัติค่าสดบันทึกเป็นชุด และลบข้อมูลที่เก่ากว่า 30 วันอัตโนมัติ เปลี่ยนได้ด้วย `LIVE_RETENTION_DAYS=90 npm start` (ใส่ `0` เพื่อเก็บทั้งหมด)

ไฟล์ `.db` อยู่ในเครื่องที่รันเว็บเซิร์ฟเวอร์และไม่ถูกใส่ใน Git สามารถเปิดด้วยโปรแกรม SQLite ทั่วไป หรือใช้ `sqlite3 data/modbus-scan.db` เพื่อดูตาราง `scans`, `scan_results` และ `live_samples` ได้ แอปใช้โมดูล SQLite ที่มากับ Node ซึ่ง Node 22 ยังติดป้าย experimental อยู่ แต่ใช้งานได้โดยไม่ต้องลงแพ็กเกจเพิ่ม `npm start` และ `npm test` ปิดคำเตือนนี้ไว้แล้ว

ค่า register เป็น unsigned 16-bit ดิบ อุปกรณ์บางรุ่นต้องรวมหลาย register หรือแปลงค่าด้วย scaling/word order ตามคู่มืออุปกรณ์ แอปไม่ได้เดาหน่วยหรือรูปแบบเหล่านั้น การแสดง reference 5 หลักเป็นเพียงตัวช่วย; address หลักที่ส่งจริงคือเลข 0–65535 ในตาราง

## ทดสอบ

```bash
npm test
```

ชุดทดสอบใช้ Modbus TCP จำลองบน loopback, RTU stream จำลอง และทดสอบกลไกสแกน/อ่านค่าสด การทดสอบกับ USB/Serial และอุปกรณ์จริงต้องมีฮาร์ดแวร์ที่ตั้งค่าตรงกัน ชุดทดสอบรันอัตโนมัติบน GitHub Actions ทุกครั้งที่ push หรือเปิด pull request

## English

A read-only Modbus scanner that runs on your own computer at `localhost`. It reads devices in two ways:

- **Modbus TCP:** the local Node server connects to a device's IP and port on your LAN.
- **Modbus RTU:** the browser talks to a USB/serial adapter plugged into your computer, using Web Serial.

The app never writes coils or registers. The interface is in Thai; the labels used below are given with their English meaning.

### Getting started

Requires Node.js 22.13 or later. There are no packages to install.

```bash
npm start
```

Open [http://localhost:8876](http://localhost:8876) in Chrome on a desktop computer. To use another port, run `PORT=9000 npm start` and open `http://localhost:9000`.

For USB/Serial, choose **USB / Serial**, set baud rate, data bits, stop bits, parity and unit ID, then press **เลือกพอร์ต USB / Serial** (choose port) to grant the browser access to the port. Web Serial needs a supporting browser (Chrome or Edge) and a page served from `localhost` or HTTPS.

### Scanning

1. Choose **TCP / LAN** or **USB / Serial** and fill in the connection settings.
2. Choose **กำหนดช่วงเอง** (custom range) or **สแกนทั้งหมด** (full scan, addresses 0–65535).
3. Pick the data areas: coils (FC01), discrete inputs (FC02), holding registers (FC03), input registers (FC04).
4. Press **เริ่มสแกน** (start scan). Progress is shown, and you can stop at any time.
5. The **ผลสแกนครั้งเดียว** (one-time scan) table lists every readable address with its raw value and hex. You can export it as CSV.
6. Tick the **LIVE** box of the addresses you want to watch, open the **ค่าสด** (live values) tab, set the interval and start polling.

Every scan and the live value history are saved automatically to a SQLite file at `data/modbus-scan.db`, and the last scan is loaded again when you reopen the page. Settings are kept in the browser. Live polling supports up to 500 addresses at a time. A full scan can take a long time, especially over serial.

Built-in safeguards to keep the load on your device low:

- **โหมดเร็ว** (fast mode): blocks that answer "illegal address" are not split below 8 addresses. Sparse devices scan much faster, but a readable address right next to an unreadable range may be missed. The sidebar shows the minimum and maximum request count before you start.
- A scan stops by itself after 5 communication failures in a row (for example a wrong IP or port, or an unplugged cable).
- Modbus TCP uses one connection per host and port and sends one request at a time. Idle connections close after 5 seconds.
- Live values with consecutive addresses of the same type are read in one request. If the device rejects that, they are read one by one.
- Live history is written in batches, and samples older than 30 days are deleted. Change this with `LIVE_RETENTION_DAYS=90 npm start` (`0` keeps everything).

The `.db` file stays on the computer that runs the server and is not committed to Git. Open it with any SQLite tool, for example `sqlite3 data/modbus-scan.db`, to see the `scans`, `scan_results` and `live_samples` tables. The app uses Node's built-in SQLite module, which Node 22 still marks as experimental; it works without extra packages, and `npm start` and `npm test` hide that warning.

Register values are shown as raw unsigned 16-bit numbers. Some devices combine several registers or need scaling or a particular word order; check your device manual, because the app does not guess units or formats. The 5-digit reference (such as `40001`) is only a convenience; the address actually sent is the 0–65535 number in the table.

### Tests

```bash
npm test
```

The tests use a simulated Modbus TCP device on loopback, a simulated RTU stream, and unit tests for scanning and live polling. Testing against real USB/serial hardware and devices requires matching equipment. Tests run automatically on GitHub Actions for every push and pull request.

## License

[MIT](LICENSE)
