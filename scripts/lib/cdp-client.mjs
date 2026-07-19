import defaultWebSocket from "ws";

const CLOSED = 3;

export class CdpClient {
  constructor(
    url,
    {
      WebSocket = defaultWebSocket,
      timeoutMs = 8000,
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
    } = {}
  ) {
    this.url = url;
    this.WebSocket = WebSocket;
    this.timeoutMs = timeoutMs;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.state = "idle";
    this.bindings = [];
    this.connectPromise = null;
    this.closePromise = null;
  }

  _add(name, handler, { once = false } = {}) {
    const socket = this.socket;
    if (!socket) return null;
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener(name, handler, once ? { once: true } : undefined);
    } else if (once && typeof socket.once === "function") {
      socket.once(name, handler);
    } else if (typeof socket.on === "function") {
      socket.on(name, handler);
    } else {
      throw new Error("CDP WebSocket does not support event listeners");
    }
    const binding = { name, handler, once };
    this.bindings.push(binding);
    return binding;
  }

  _remove(binding) {
    if (!binding || !this.socket) return;
    const socket = this.socket;
    if (typeof socket.removeEventListener === "function") {
      socket.removeEventListener(binding.name, binding.handler);
    } else if (typeof socket.off === "function") {
      socket.off(binding.name, binding.handler);
    } else if (typeof socket.removeListener === "function") {
      socket.removeListener(binding.name, binding.handler);
    }
    this.bindings = this.bindings.filter((candidate) => candidate !== binding);
  }

  _removeAllListeners() {
    for (const binding of [...this.bindings]) this._remove(binding);
    this.bindings = [];
  }

  on(name, handler) {
    return this._add(name, handler);
  }

  once(name, handler) {
    return this._add(name, handler, { once: true });
  }

  _settlePending(id, error, value) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    this.clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
    return true;
  }

  rejectPending(error) {
    for (const id of [...this.pending.keys()]) this._settlePending(id, error);
  }

  _finishTerminal(error, { closePromise = false } = {}) {
    this.connected = false;
    this.closed = true;
    this.state = "closed";
    this._removeAllListeners();
    if (error) this.rejectPending(error);
    if (closePromise && this._resolveClose) {
      const resolveClose = this._resolveClose;
      const rejectClose = this._rejectClose;
      this._resolveClose = null;
      this._rejectClose = null;
      if (error) rejectClose(error);
      else resolveClose();
    }
  }

  _handleClose() {
    const error = new Error("CDP socket closed");
    if (this.state === "connecting" && this._rejectConnect) {
      const reject = this._rejectConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      reject(error);
    }
    if (this.state === "closing") {
      this._finishTerminal(null, { closePromise: true });
      this.rejectPending(error);
      return;
    }
    this._finishTerminal(error);
  }

  _handleError(error) {
    const normalized = error instanceof Error ? error : new Error("CDP socket error");
    if (this.state === "connecting" && this._rejectConnect) {
      const reject = this._rejectConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      reject(new Error(`Unable to connect to ${this.url}: ${normalized.message}`));
    }
    if (this.state === "closing") {
      this._finishTerminal(normalized, { closePromise: true });
      this.rejectPending(new Error("CDP client closed"));
      this._forceSocketTermination();
      return;
    }
    this._finishTerminal(normalized);
  }

  _forceSocketTermination() {
    const socket = this.socket;
    if (!socket) return;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else if (socket.readyState !== CLOSED && typeof socket.close === "function") socket.close();
    } catch {
      // The close/error result already carries the authoritative failure.
    }
  }

  handleMessage(rawEvent) {
    const raw = rawEvent?.data ?? rawEvent;
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch (error) {
      this.rejectPending(new Error(`Malformed CDP message: ${error.message}`));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.rejectPending(new Error("Malformed CDP message: expected an object"));
      return;
    }
    if (message.id === undefined || message.id === null) {
      this.events.push(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) {
      this._settlePending(message.id, new Error(message.error.message || "CDP error"));
    } else {
      this._settlePending(message.id, null, message.result);
    }
  }

  connect() {
    if (this.state !== "idle") return Promise.reject(new Error("CDP client is not idle"));
    this.state = "connecting";
    try {
      this.socket = new this.WebSocket(this.url);
      this._add("message", (event) => this.handleMessage(event));
      this._add("close", () => this._handleClose());
      this._add("error", (error) => this._handleError(error));
    } catch (error) {
      this._finishTerminal(error);
      return Promise.reject(error);
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this._resolveConnect = () => {
        if (this.state !== "connecting") return;
        this.connected = true;
        this.closed = false;
        this.state = "open";
        this._resolveConnect = null;
        this._rejectConnect = null;
        resolve();
      };
      this._rejectConnect = (error) => {
        this._resolveConnect = null;
        this._rejectConnect = null;
        reject(error);
      };
      this.once("open", this._resolveConnect);
    });
    return this.connectPromise;
  }

  send(method, params = {}) {
    if (!this.socket || !this.connected || this.closed || this.state !== "open") {
      return Promise.reject(
        new Error(this.state === "closed" || this.closed ? "CDP client is closed" : "CDP socket is not connected")
      );
    }
    const id = this.nextId;
    if (this.pending.has(id)) {
      this.nextId += 1;
      return Promise.reject(new Error(`Duplicate active CDP request id: ${id}`));
    }
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = this.setTimeout(() => {
        this._settlePending(id, new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this._settlePending(id, error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed"
      );
    }
    return result?.result?.value;
  }

  close(timeoutMs = 5000) {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed" || !this.socket) {
      this._finishTerminal(null);
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }

    if (this.state === "connecting" && this._rejectConnect) {
      const rejectConnect = this._rejectConnect;
      this._resolveConnect = null;
      this._rejectConnect = null;
      rejectConnect(new Error("CDP client closed before open"));
    }
    this.state = "closing";
    this.connected = false;
    this.closed = true;
    this.rejectPending(new Error("CDP client closed"));
    const socket = this.socket;
    this.closePromise = new Promise((resolve, reject) => {
      let timer;
      this._resolveClose = () => {
        this.clearTimeout(timer);
        this._resolveClose = null;
        this._rejectClose = null;
        resolve();
      };
      this._rejectClose = (error) => {
        this.clearTimeout(timer);
        this._resolveClose = null;
        this._rejectClose = null;
        reject(error);
      };
      timer = this.setTimeout(() => {
        const error = new Error("CDP close timed out");
        this._finishTerminal(error, { closePromise: true });
        this._forceSocketTermination();
      }, timeoutMs);
      try {
        if (socket.readyState !== CLOSED && typeof socket.close === "function") socket.close();
        else this._handleClose();
      } catch (error) {
        this._finishTerminal(error, { closePromise: true });
        this._forceSocketTermination();
      }
    });
    return this.closePromise;
  }
}

export { CdpClient as CDPClient };
