/* Shared LiveAvatar session lifecycle for the Ask and Read pages. Spec v1.2 sections 7, 8, 9.

   This module owns the one-session-at-a-time rule and nothing a visitor reads beyond the generic
   connect and disconnect lines: the token call, the start/stop/restart queue, the in-flight start()
   promise, detaching media on stop, and the SDK event wiring. The page controller supplies the
   token request and receives callbacks; it decides what the page looks like and what it says. */

import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
  SessionState,
  SessionDisconnectReason,
} from "./vendor/liveavatar.esm.js";

export const TOKEN_URL = "https://bw7rxcyn7l47nrc2f3ors4bwzi0mqzhp.lambda-url.us-west-1.on.aws"; // Lambda function URL, see lambda/session-token/README.md

// POSTs the page's request body to the token Lambda. An error carrying a message the Lambda wrote
// is marked fromServer, so a controller can show that text to the visitor verbatim (the Read page
// does this for a refused script) rather than a generic line.
export async function fetchToken(request, tokenUrl = TOKEN_URL) {
  if (!tokenUrl) throw new Error("token endpoint not configured");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.session_token) {
    const err = new Error(data.error || `token request failed (${res.status})`);
    err.fromServer = Boolean(data.error);
    err.status = res.status;
    throw err;
  }
  return data.session_token;
}

/* Creates the session controller for one page.

   options:
     video            the <video> the stream attaches to
     request          () => the token request body for this start
     sessionConfig    second argument to new LiveAvatarSession (e.g. { voiceChat: true })
     tokenUrl         override for the Lambda URL

   callbacks (all optional):
     onState({ live, busy, speaking })   every time any of the three changes
     onStatus(text)                      generic lifecycle lines: connecting, ending, disconnected
     onStarting(request)                 after "Connecting", with the request being used
     onConnected()                       state reached CONNECTED. Not the same as ready to speak:
                                         the SDK sets it at the end of its start(), which can land
                                         before the avatar's tracks exist. Use onStreamReady for that.
     onStreamReady()                     both the audio and the video track have arrived
     onSessionState(state)               every SESSION_STATE_CHANGED, for logging
     onStartFailed(err)                  the start did not happen; the controller writes the status
     onDisconnected(reason, message)     the session dropped on its own
     onUserSpeakStarted() / onUserSpeakEnded()
     onSpeakStarted() / onSpeakEnded()   the avatar's speech, server-side timing
     onUserTurn(text) / onAvatarTurn(text)   transcription */
export function createAvatarSession(options) {
  const {
    video,
    request,
    sessionConfig = {},
    tokenUrl = TOKEN_URL,
    onState = () => {},
    onStatus = () => {},
    onStarting = () => {},
    onConnected = () => {},
    onStreamReady = () => {},
    onSessionState = () => {},
    onStartFailed = () => {},
    onDisconnected = () => {},
    onUserSpeakStarted = () => {},
    onUserSpeakEnded = () => {},
    onSpeakStarted = () => {},
    onSpeakEnded = () => {},
    onUserTurn = () => {},
    onAvatarTurn = () => {},
  } = options;

  let session = null;      // the live LiveAvatarSession, or null
  let startPromise = null; // the in-flight s.start(), so stop() can wait for it before stopping
  let busy = false;        // true while starting or stopping
  let speaking = false;    // true between avatar.speak_started and avatar.speak_ended

  // Every start, stop and restart runs through this queue, one at a time, so a selector change
  // during a connect can never leave two sessions alive.
  let queue = Promise.resolve();
  let restartQueued = false;

  function enqueue(fn) {
    queue = queue.then(fn, fn);
    return queue;
  }

  // live is passed rather than derived: stop() reports the live controls while it is tearing down,
  // after it has already released the session.
  function emit(live) {
    onState({ live, busy, speaking });
  }

  function detach() {
    video.srcObject = null;
    // The SDK attaches audio to media elements it creates; make sure none survive a stop.
    for (const m of document.querySelectorAll("audio, video")) {
      if (m !== video && m.srcObject) { m.srcObject = null; m.remove(); }
    }
  }

  function wire(s) {
    s.on(SessionEvent.SESSION_STREAM_READY, () => {
      s.attach(video);
      onStreamReady();
    });

    s.on(SessionEvent.SESSION_STATE_CHANGED, (state) => {
      onSessionState(state);
      if (state === SessionState.CONNECTED) {
        busy = false;
        emit(true);
        onConnected();
      }
    });

    s.on(SessionEvent.SESSION_DISCONNECTED, (why) => {
      if (session !== s) return; // we already stopped it
      session = null;
      startPromise = null;
      busy = false;
      speaking = false;
      detach();
      emit(false);
      const message =
        why === SessionDisconnectReason.SESSION_START_FAILED ? "The avatar could not start. Try again."
        : why === SessionDisconnectReason.SERVER_INITIATED ? "The session ended (three-minute limit)."
        : "Disconnected.";
      onStatus(message);
      onDisconnected(why, message);
    });

    s.on(AgentEventsEnum.USER_SPEAK_STARTED, () => onUserSpeakStarted());
    s.on(AgentEventsEnum.USER_SPEAK_ENDED, () => onUserSpeakEnded());
    s.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => { speaking = true; emit(true); onSpeakStarted(); });
    s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => { speaking = false; emit(true); onSpeakEnded(); });

    s.on(AgentEventsEnum.USER_TRANSCRIPTION, (e) => onUserTurn(e.text));
    s.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, (e) => onAvatarTurn(e.text));
  }

  async function start() {
    if (busy || session) return;
    busy = true;
    // Per-session state, cleared on the way in as well as on the way out: a start must never
    // inherit anything from the session before it, whatever path ended that one.
    speaking = false;
    startPromise = null;
    const req = request();
    emit(false);
    onStatus("Connecting");
    onStarting(req);

    try {
      const token = await fetchToken(req, tokenUrl);
      const s = new LiveAvatarSession(token, sessionConfig);
      wire(s);
      session = s;
      startPromise = s.start();
      await startPromise;
      startPromise = null;
      // stream_ready attaches the video; state CONNECTED flips the controls.
    } catch (err) {
      console.error("start failed", err);
      session = null;
      startPromise = null;
      busy = false;
      emit(false);
      onStartFailed(err);
    }
  }

  async function stop(reason) {
    if (!session) return;
    const s = session;
    session = null;
    busy = true;
    speaking = false;
    emit(true);
    onStatus(reason || "Ending");
    // The SDK ignores stop() while start() is still running; wait for it first.
    if (startPromise) { try { await startPromise; } catch { /* start already reported */ } startPromise = null; }
    try { await s.stop(); } catch (err) { console.warn("stop error", err); }
    detach();
    busy = false;
    emit(false);
    onStatus(reason || "Ended");
  }

  function send(method, text) {
    if (!session) return false;
    try { session[method](text); return true; }
    catch (err) { console.warn(method + " failed", err); return false; }
  }

  window.addEventListener("pagehide", () => { if (session) session.stop().catch(() => {}); });

  return {
    queueStart: () => enqueue(start),
    queueStop: (reason) => enqueue(() => stop(reason)),

    // A settings change while live: stop, then start again with whatever the selectors now say.
    // A second change while the restart is still queued does not queue another; the queued restart
    // reads the selectors when it runs.
    queueRestart(reason) {
      if (restartQueued) return queue;
      restartQueued = true;
      return enqueue(async () => {
        restartQueued = false;
        await stop(reason);
        await start();
      });
    },

    // Send to the agent, which answers. The Ask page's composer.
    message: (text) => send("message", text),
    // Speak this text verbatim, no LLM in the path. The Read page.
    repeat: (text) => send("repeat", text),

    // Cut off whatever the avatar is saying now. The SDK throws if the session is not connected,
    // so this is a no-op unless there is something to interrupt.
    interrupt() {
      if (!session) return false;
      try { session.interrupt(); return true; }
      catch (err) { console.warn("interrupt failed", err); return false; }
    },

    isLive: () => session !== null,
    isBusy: () => busy,
    isSpeaking: () => speaking,
  };
}
