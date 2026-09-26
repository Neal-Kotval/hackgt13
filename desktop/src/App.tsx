import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ShellNav, type AppSection } from "./components/ShellNav";
import { SignInScreen } from "./components/SignInScreen";
import { ProjectPicker } from "./components/ProjectPicker";
import { ThreadList } from "./components/ThreadList";
import { desktopApi } from "./lib/desktop-api";
import type {
  AuthStatus,
  ChatThread,
  ChatThreadSummary,
  CredentialStatus,
} from "./lib/types";

/**
 * Draft behavior: each thread keeps its own unsent composer text in memory.
 * Switching threads or Tasks ↔ Local chat preserves drafts until send or
 * explicit clear. Drafts are not persisted across app relaunch.
 */
export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authBootError, setAuthBootError] = useState<string | null>(null);
  const [section, setSection] = useState<AppSection>("tasks");
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(
    null,
  );
  const selectedIdRef = useRef<string | null>(null);
  const sending =
    activeThread?.messages.some((message) => message.status === "streaming") ??
    false;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refreshThreads = useCallback(async () => {
    const api = desktopApi();
    const list = await api.listThreads();
    setThreads(list);
    return list;
  }, []);

  const loadThread = useCallback(async (threadId: string) => {
    const api = desktopApi();
    const thread = await api.getThread(threadId);
    setActiveThread(thread);
    return thread;
  }, []);

  const bootChat = useCallback(async () => {
    const api = desktopApi();
    const [list, status] = await Promise.all([
      api.listThreads(),
      api.credentialStatus(),
    ]);
    setThreads(list);
    setCredentials(status);
    if (list[0]) {
      setSelectedId(list[0].id);
      await loadThread(list[0].id);
    } else {
      setSelectedId(null);
      setActiveThread(null);
    }
  }, [loadThread]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const api = desktopApi();
        const status = await api.authStatus();
        if (cancelled) return;
        setAuth(status);
        if (status.signedIn) {
          try {
            await bootChat();
          } catch (err) {
            if (!cancelled) {
              setBootError(
                err instanceof Error
                  ? err.message
                  : "Failed to open chat storage",
              );
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setAuthBootError(
            err instanceof Error
              ? err.message
              : "Failed to read desktop auth status",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootChat]);

  useEffect(() => {
    if (!auth?.signedIn) return;
    try {
      const api = desktopApi();
      return api.onAssistantEvent((event) => {
        if (event.threadId !== selectedIdRef.current) {
          if (event.type === "done" || event.type === "status") {
            void refreshThreads();
          }
          return;
        }

        setActiveThread((current) => {
          if (!current || current.id !== event.threadId) return current;
          const messages = current.messages.map((message) => {
            if (message.id !== event.messageId) return message;
            if (event.type === "delta") {
              return {
                ...message,
                content: `${message.content}${event.text}`,
                status: "streaming" as const,
              };
            }
            if (event.type === "status") {
              return {
                ...message,
                status: event.status,
                error: event.error,
              };
            }
            return message;
          });
          return { ...current, messages };
        });

        if (event.type === "done" || event.type === "status") {
          void refreshThreads();
        }
      });
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : "Desktop bridge unavailable",
      );
      return undefined;
    }
  }, [auth?.signedIn, refreshThreads]);

  const draft =
    selectedId && Object.prototype.hasOwnProperty.call(drafts, selectedId)
      ? drafts[selectedId]
      : "";

  async function handleSignedIn(status: AuthStatus) {
    setAuth(status);
    setError(null);
    setBootError(null);
    try {
      await bootChat();
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : "Failed to open chat storage",
      );
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    setError(null);
    try {
      const status = await desktopApi().signOut();
      setAuth(status);
      setThreads([]);
      setSelectedId(null);
      setActiveThread(null);
      setDrafts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-out failed");
    } finally {
      setSigningOut(false);
    }
  }

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const api = desktopApi();
      const thread = await api.createThread();
      await refreshThreads();
      setSelectedId(thread.id);
      setActiveThread(thread);
      setDrafts((current) => ({ ...current, [thread.id]: "" }));
      queueMicrotask(() => {
        document.getElementById("composer-input")?.focus();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create chat");
    } finally {
      setBusy(false);
    }
  }

  async function handleSelect(threadId: string) {
    if (threadId === selectedId) return;
    setError(null);
    setSelectedId(threadId);
    try {
      await loadThread(threadId);
      queueMicrotask(() => {
        document.getElementById("composer-input")?.focus();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open chat");
    }
  }

  async function handleDelete(threadId: string) {
    setBusy(true);
    setError(null);
    try {
      const api = desktopApi();
      await api.deleteThread(threadId);
      setDrafts((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      const list = await refreshThreads();
      if (selectedId === threadId) {
        const next = list[0]?.id ?? null;
        setSelectedId(next);
        if (next) await loadThread(next);
        else setActiveThread(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete chat");
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!selectedId || !draft.trim() || sending) return;
    const api = desktopApi();
    const content = draft.trim();
    const threadId = selectedId;
    setError(null);
    setDrafts((current) => ({ ...current, [threadId]: "" }));

    try {
      const userMessage = await api.appendMessage(threadId, {
        role: "user",
        content,
        status: "complete",
      });
      setActiveThread((current) => {
        if (!current || current.id !== threadId) return current;
        return {
          ...current,
          title:
            current.title === "New chat"
              ? content.length > 48
                ? `${content.slice(0, 45)}…`
                : content
              : current.title,
          messages: [...current.messages, userMessage],
        };
      });
      await refreshThreads();
      await api.sendAssistant(threadId, userMessage.id);
      await loadThread(threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      setDrafts((current) => ({
        ...current,
        [threadId]: current[threadId] || content,
      }));
      try {
        await loadThread(threadId);
      } catch {
        // Keep the send error as the primary signal.
      }
    }
  }

  async function handleStop() {
    if (!selectedId) return;
    try {
      await desktopApi().cancelAssistant(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop generation");
    }
  }

  if (authBootError) {
    return (
      <div className="app-error" role="alert">
        <h1>Desktop auth unavailable</h1>
        <p>{authBootError}</p>
        <p>Restart with just desktop from the repository root.</p>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="auth-screen" role="status">
        <p className="auth-loading">Checking employee session…</p>
      </div>
    );
  }

  if (!auth.signedIn) {
    return (
      <SignInScreen
        baseUrl={auth.baseUrl}
        secureStorage={auth.secureStorage}
        initialMessage={auth.message}
        onSignedIn={(status) => {
          void handleSignedIn(status);
        }}
      />
    );
  }

  if (bootError) {
    return (
      <div className="app-error" role="alert">
        <h1>Chat storage error</h1>
        <p>{bootError}</p>
        <p>
          Local chats live under the app userData chat directory. Fix or remove
          the corrupt file, then relaunch.
        </p>
      </div>
    );
  }

  return (
    <ShellNav
      section={section}
      employeeLabel={
        auth.user
          ? `${auth.user.name} · ${auth.user.email}`
          : "Signed in"
      }
      busy={busy || sending || signingOut}
      onSectionChange={setSection}
      onSignOut={() => {
        void handleSignOut();
      }}
    >
      {section === "tasks" ? (
        <ProjectPicker webBaseUrl={auth.baseUrl} />
      ) : (
        <div className="app-shell">
          <ThreadList
            threads={threads}
            selectedId={selectedId}
            busy={busy || sending || signingOut}
            onSelect={(id) => {
              void handleSelect(id);
            }}
            onCreate={() => {
              void handleCreate();
            }}
            onDelete={(id) => {
              void handleDelete(id);
            }}
          />
          <main className="main">
            <header className="main-header">
              <div>
                <h1>{activeThread?.title ?? "No chat selected"}</h1>
                <p className="brand-meta">
                  Local chat only — does not create AgentCloud tasks or sync to
                  the web dashboard.
                </p>
              </div>
              {credentials && !credentials.configured ? (
                <p className="credential-banner" role="status">
                  {credentials.message}
                </p>
              ) : credentials ? (
                <p className="brand-meta">{credentials.message}</p>
              ) : null}
            </header>
            {activeThread ? (
              <>
                <Conversation
                  messages={activeThread.messages}
                  emptyLabel="This chat has no messages yet. Type below to send the first turn."
                />
                <Composer
                  value={draft}
                  disabled={false}
                  sending={sending}
                  error={error}
                  onChange={(value) => {
                    if (!selectedId) return;
                    setDrafts((current) => ({
                      ...current,
                      [selectedId]: value,
                    }));
                  }}
                  onSend={() => {
                    void handleSend();
                  }}
                  onStop={() => {
                    void handleStop();
                  }}
                />
              </>
            ) : (
              <>
                <div className="conversation">
                  <div className="main-empty" role="status">
                    Create a new local chat to start messaging. Threads stay on
                    this machine and are not AgentCloud tasks.
                  </div>
                </div>
                <Composer
                  value=""
                  disabled
                  sending={false}
                  error={error}
                  onChange={() => undefined}
                  onSend={() => undefined}
                  onStop={() => undefined}
                />
              </>
            )}
          </main>
        </div>
      )}
    </ShellNav>
  );
}
