import { useId, useRef, type ReactNode } from "react";
import { ArrowUp, FileCode, Paperclip, Square, X } from "@phosphor-icons/react";

export type ChatAttachment = { id: string; name: string; text: string };
type ComposerProps = {
  value: string;
  disabled: boolean;
  sendDisabled?: boolean;
  sending: boolean;
  error: string | null;
  placeholder?: string;
  context?: ReactNode;
  attachments?: ChatAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export function Composer({
  value,
  disabled,
  sendDisabled = false,
  sending,
  error,
  placeholder = "Message your agent",
  context,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  onChange,
  onSend,
  onStop,
}: ComposerProps) {
  const inputId = useId();
  const shortcutId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend =
    !disabled &&
    !sendDisabled &&
    !sending &&
    (value.trim().length > 0 || attachments.length > 0);
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        Message
      </label>
      <span id={shortcutId} className="visually-hidden">
        Enter sends. Shift+Enter inserts a newline. Attached text files are sent
        as message context.
      </span>
      <div className="composer-row">
        {attachments.length > 0 && (
          <ul className="composer-attachments" aria-label="Attached context">
            {attachments.map((file) => (
              <li className="attachment-chip" key={file.id}>
                <FileCode aria-hidden="true" />
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemoveAttachment?.(file.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          id={inputId}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={shortcutId}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-toolbar">
          {onAttach && (
            <>
              <input
                ref={fileInput}
                type="file"
                className="visually-hidden"
                tabIndex={-1}
                aria-label="Choose text context files"
                multiple
                accept="text/*,.md,.json,.js,.jsx,.ts,.tsx,.py,.css,.html,.csv,.yaml,.yml,.toml,.sh,.sql,.log"
                onChange={(event) => {
                  onAttach(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="button ghost composer-attach"
                aria-label="Attach files or context"
                title="Attach text files as message context"
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" />
              </button>
            </>
          )}
          {context && (
            <>
              <span className="composer-divider" aria-hidden="true" />
              {context}
            </>
          )}
          <div className="composer-actions">
            {sending ? (
              <button
                type="button"
                className="button danger composer-submit"
                aria-label="Stop response"
                title="Stop response"
                disabled={disabled}
                onClick={(event) => {
                  event.preventDefault();
                  onStop();
                }}
              >
                <Square weight="fill" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="button primary composer-submit"
                aria-label="Send message"
                title="Send message"
                disabled={!canSend}
              >
                <ArrowUp weight="bold" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
