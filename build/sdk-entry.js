// Re-exports the parts of the LiveAvatar SDK the Ask page uses.
// npm run build:sdk bundles this (with its dependencies) into website/js/vendor/liveavatar.esm.js.
export {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
  SessionState,
  SessionDisconnectReason,
} from "@heygen/liveavatar-web-sdk";
