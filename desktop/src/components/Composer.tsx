import { ArrowUp, Square } from "@phosphor-icons/react";

type ComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export function Composer({
  value,
  disabled,
  sending,
  error,
  onChange,
  onSend,
  onStop,
}: ComposerProps) {
  const canSend = !disabled && !sending && value.trim().length > 0;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        Message
      </label>
      <span id="composer-shortcut" className="visually-hidden">
        Enter sends. Shift+Enter inserts a newline.
      </span>
      <div className="composer-row">
        <textarea
          id="composer-input"
          value={value}
          disabled={disabled}
          placeholder="Ask anything"
          aria-describedby="composer-shortcut"
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
        <div className="composer-actions">
          {sending ? (
            <button
              type="button"
              className="button danger composer-submit"
              aria-label="Stop response"
              title="Stop response"
              onClick={onStop}
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
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
