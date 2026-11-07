// packages/logger/src/ChildIO.js
//
// ══ A DEAD CHILD PROCESS CAN NEVER CRASH THE APP (round-e E17, Ed's ruling 2026-10-01) ═══════════════
//
// Ed's desk run, SeniorMinder-20261001_060121_908.log (mimma):
//
//   13:04:01.243  [main-thread] STALL 1406ms
//   13:04:01.249  [ear] no heartbeat for 3194ms — killing and restarting.     (the watchdog SIGKILLs the ear child)
//   13:04:01.460  [CrashCapture:uncaughtException] FATAL: Error: write EOF
//                   at WriteWrap.onWriteComplete (node:internal/stream_base_commons:87:19)
//   13:04:01.846  the log's last line — Electron exited
//
// EarProcess.js wrote the audio with `try { child.stdin.write(…) } catch {}`. A write to a pipe whose child is
// dying does not throw: it completes LATER as an 'error' event on `child.stdin`, and that stream had no
// 'error' listener — so Node raised it as an uncaught exception and the app died. A write issued a moment
// BEFORE the kill fails the same way after it, so no liveness check alone can stop it: the listener can.
//
// ── THE GUARD, ONE PLACE ──────────────────────────────────────────────────────────────────────────────
//   guardChild(child, name)   at spawn: an 'error' listener on the child and on each of its stdio streams,
//                             attached once. A stream or child error is said once (WARN) and never thrown.
//   writeToChild(child, data) every write to a child's stdin: checks the child and the stream are alive,
//                             makes sure the stream is guarded, writes inside a try. A write to a dead or
//                             closing child is DROPPED. Returns write()'s own value (false = full or dropped).
//   endChildStdin(child)      the same, for stdin.end().
//   sendToChild(child, msg)   the same, for IPC child.send(): dropped unless `connected`, errors to the callback.
//
// ONE WARN PER CHILD PER INCIDENT: a child dies once, so the first drop or stream error on it says what and
// why, naming the child; later drops on the same child are silent. A new child (a restart) is a new incident.
// NOTHING HERE THROWS.
//
// It lives in @seniorminder/logger because that is the one package every writer already imports (voice,
// platforms, conversation-provider declare it; orchestrator and the electron app use it), and it logs.

import { AppLogger } from './AppLogger.js';

const MODULE_NAME = 'ChildIO';
const GUARD = Symbol.for('seniorminder.childio.guard');
const STREAM_GUARDED = Symbol.for('seniorminder.childio.streamGuarded');

function _state(child, name) {
    if (!child || typeof child !== 'object') return null;
    if (!child[GUARD]) {
        try {
            Object.defineProperty(child, GUARD, { value: { name: name || 'child', warned: false }, enumerable: false });
        } catch { return null; }
    } else if (name && child[GUARD].name === 'child') {
        child[GUARD].name = name;
    }
    return child[GUARD];
}

function _warnOnce(child, why) {
    const st = _state(child);
    if (!st || st.warned) return;
    st.warned = true;
    try {
        AppLogger.warn(MODULE_NAME, 'guard',
            `[child-io] "${st.name}" (pid ${child?.pid ?? '?'}): ${why}. Dropped — never thrown, never uncaught (E17). `
            + 'Further writes to this child are dropped silently; a new child is a new incident.');
    } catch { /* a logger that throws must not become the crash this exists to prevent */ }
}

/** Is this child gone or going? (exited, signalled, or kill() already called) */
function _childDeadWhy(child) {
    if (!child) return 'there is no child';
    if (child.exitCode !== null && child.exitCode !== undefined) return `the child has exited (code ${child.exitCode})`;
    if (child.signalCode) return `the child was killed (${child.signalCode})`;
    if (child.killed === true) return 'the child is being killed';
    return null;
}

function _streamDeadWhy(stream, which) {
    if (!stream) return `the child has no ${which}`;
    if (stream.destroyed) return `its ${which} is destroyed`;
    if (stream.writableEnded || stream.writableFinished) return `its ${which} is ended`;
    if (stream.writable === false) return `its ${which} is not writable`;
    return null;
}

function _guardStream(child, stream, which) {
    if (!stream || typeof stream.on !== 'function' || stream[STREAM_GUARDED]) return;
    try {
        Object.defineProperty(stream, STREAM_GUARDED, { value: true, enumerable: false });
        stream.on('error', (e) => _warnOnce(child, `its ${which} raised ${e?.code || ''} ${e?.message ?? e}`.replace(/\s+/g, ' ').trim()));
    } catch { /* an unguardable stream is written through the checks only */ }
}

/**
 * At spawn: name the child and give it, and each of its stdio streams, an 'error' listener, once.
 * @template T
 * @param {T} child
 * @param {string} name - how the WARN names it ("ear child", "ffplay", …)
 * @returns {T} the same child
 */
export function guardChild(child, name = 'child') {
    if (!child || typeof child !== 'object') return child;
    const st = _state(child, name);
    if (st && !st.childGuarded && typeof child.on === 'function') {
        st.childGuarded = true;
        try { child.on('error', (e) => _warnOnce(child, `the child raised ${e?.code || ''} ${e?.message ?? e}`.replace(/\s+/g, ' ').trim())); }
        catch { /* */ }
    }
    _guardStream(child, child.stdin, 'stdin');
    _guardStream(child, child.stdout, 'stdout');
    _guardStream(child, child.stderr, 'stderr');
    return child;
}

/**
 * Write to a child's stdin, guarded. Never throws.
 * @param {object} child
 * @param {Buffer|string} data
 * @param {{name?: string}} [o]
 * @returns {boolean} write()'s own return (false when full — or when the write was dropped)
 */
export function writeToChild(child, data, { name } = {}) {
    try {
        if (child) guardChild(child, name || 'child');
        const dead = _childDeadWhy(child) || _streamDeadWhy(child?.stdin, 'stdin');
        if (dead) { if (child) _warnOnce(child, `a write while ${dead}`); return false; }
        return child.stdin.write(data);
    } catch (e) {
        if (child) _warnOnce(child, `a write threw ${e?.code || ''} ${e?.message ?? e}`.replace(/\s+/g, ' ').trim());
        return false;
    }
}

/**
 * End a child's stdin, guarded. Never throws.
 * @param {object} child
 * @param {Buffer|string} [data]
 * @param {{name?: string}} [o]
 * @returns {boolean} whether end() was called
 */
export function endChildStdin(child, data, { name } = {}) {
    try {
        if (child) guardChild(child, name || 'child');
        const dead = _childDeadWhy(child) || _streamDeadWhy(child?.stdin, 'stdin');
        if (dead) { if (child) _warnOnce(child, `an end() while ${dead}`); return false; }
        if (data === undefined) child.stdin.end(); else child.stdin.end(data);
        return true;
    } catch (e) {
        if (child) _warnOnce(child, `an end() threw ${e?.message ?? e}`);
        return false;
    }
}

/**
 * Send an IPC message to a forked child, guarded. Never throws; a failed send is said once.
 * @param {object} child
 * @param {*} msg
 * @param {{name?: string}} [o]
 * @returns {boolean} true when the message was handed to send() (sent or queued — send()'s own `false` means
 *   backpressure, not loss), false when it was DROPPED because the child or its channel is gone
 */
export function sendToChild(child, msg, { name } = {}) {
    try {
        if (child) guardChild(child, name || 'child');
        const dead = _childDeadWhy(child) || (child?.connected === true ? null : 'its IPC channel is closed');
        if (dead) { if (child) _warnOnce(child, `an IPC send while ${dead}`); return false; }
        child.send(msg, (err) => { if (err) _warnOnce(child, `an IPC send failed: ${err?.code || ''} ${err?.message ?? err}`.replace(/\s+/g, ' ').trim()); });
        return true;
    } catch (e) {
        if (child) _warnOnce(child, `an IPC send threw ${e?.message ?? e}`);
        return false;
    }
}
