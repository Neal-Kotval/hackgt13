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
      <label className="composer-hint" htmlFor="composer-input">
        Enter sends · Shift+Enter inserts a newline
      </label>
      <div className="composer-row">
        <textarea
          id="composer-input"
          value={value}
          disabled={disabled}
          placeholder={
            disabled
              ? "Select or create a chat to compose a message"
              : "Message the assistant"
          }
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-actions">
          {sending ? (
            <button type="button" className="button danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="button primary"
              disabled={!canSend}
            >
              Send
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
