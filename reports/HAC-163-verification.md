# HAC-163: web onboarding and environment-scoped desktop chats

## Delivered flow

Web Environments owns environment creation, Codex setup and ChatGPT device sign-in.
An owner starts setup on the normal environment card, authorizes ChatGPT on the
linked page, and returns to an automatic desktop handoff with a manual fallback.
Already signed-in environments offer Open in desktop directly. Desktop selects
existing environments and creates/reopens their independent chats; it links back
to web for missing authentication and no longer exposes native Codex login.

Backend migration preserves existing remote sessions/history. New chat creation
uses a scoped idempotency key, separate session/thread IDs and saved first-message
titles. Members can create/reconnect independent chats in authenticated project
environments; setup/sign-in remains owner-controlled. All chats share the machine
filesystem and account. The existing server limit remains 16 active remote
sessions; stopping an environment still ends all its sessions.

## Verification

- Typecheck, token check and web/desktop production builds passed.
- Backend suite passed; dedicated tests cover migration, multiple chats,
  idempotency, authentication gating, permissions and stale environment state.
- Desktop agent reported 89 tests passed and one Docker test skipped. Headless
  browser checks passed at 375/768/1440: environment-scoped history, independent
  New chat payloads, persistence across reload, drafts, streaming/Stop, retry,
  origin guards, web setup links, no native login/setup POST, and centered layout.
- Real web page was exercised at 375/768/1440 with no horizontal overflow.
  Isolated browser response fixtures verified device sign-in, code display and
  copy, cancellation, sign-in completion, code removal and the desktop handoff.
  A clean browser session also stopped/reconnected the actual canonical session
  through the web card and reached Signed in. No new ChatGPT authorization was
  necessary: the environment retained the user's existing sign-in.
- Final local website: port 3001. Backend: port 3002. Updated desktop is running.
  The normal handoff targets project c34d4cf6-211b-44ad-ad7a-b3873250a90a and
  environment d0e41648-0251-45be-ad7b-282696fa065d; its expiry remains unchanged.
- Two real read-only chat checks returned successful replies in independent
  sessions 02294aa7-2043-465b-82b6-976f35d0b0fb and
  f10ed0de-7252-481f-a1de-6c083764f254. Their distinct model thread IDs were
  recorded by the backend. Both chats and the pre-existing `hi` chat were listed
  after desktop reload. The second-instance handoff opened the selected project
  environment via the existing authenticated deep-link path.

No AWS provisioning was performed. Browser device-sign-in completion was tested
with an isolated response fixture; actual model execution used the user's prior
successful sign-in in the real Docker environment.
