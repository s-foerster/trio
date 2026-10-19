/**
 * Mini serveur WebSocket (RFC 6455) sans dépendance, suffisant pour Trio :
 * messages texte, ping/pong, fermeture. API proche de la librairie `ws`.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPEN = 1;
const CLOSED = 3;

class Socket extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.OPEN = OPEN;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.readyState === OPEN) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); off = 10;
      }
      if (len > this.maxPayload || !masked) return this.terminate();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    if (op === 0x8) { // close
      this._write(0x8, payload.subarray(0, 2));
      this.socket.end();
      return this._closed();
    }
    if (op === 0x9) return this._write(0xA, payload); // ping -> pong
    if (op === 0xA) return this.emit('pong');
    if (op === 0x1 || op === 0x2) this.fragments = [payload];
    else if (op === 0x0 && this.fragments) this.fragments.push(payload);
    else return;
    if (this.fragments.reduce((s, f) => s + f.length, 0) > this.maxPayload) return this.terminate();
    if (fin) {
      const data = Buffer.concat(this.fragments);
      this.fragments = null;
      this.emit('message', data.toString('utf8'));
    }
  }

  _write(op, payload) {
    if (this.readyState !== OPEN) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) { this._write(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this._write(0x9, Buffer.alloc(0)); }
  close() {
    this._write(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    this._closed();
  }
  terminate() {
    this.socket.destroy();
    this._closed();
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ maxPayload = 64 * 1024 } = {}) {
    super();
    this.maxPayload = maxPayload;
    this.clients = new Set();
  }

  handleUpgrade(req, socket, head, cb) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new Socket(socket, this.maxPayload);
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    cb(ws);
    if (head && head.length) ws._onData(head);
  }
}

module.exports = { WebSocketServer };
