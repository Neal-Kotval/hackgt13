import { FolderSimple, HardDrives, Robot } from "@phosphor-icons/react";
import { Select } from "./ui/Select";

export type ChatChoice = {
  value: string;
  label: string;
  status?: string;
  disabled?: boolean;
};
type Props = {
  projectId: string;
  sessionId: string;
  projects: ChatChoice[];
  agents: ChatChoice[];
  environments: ChatChoice[];
  environmentValue: string;
  environmentTone: "success" | "warning" | "danger" | "muted";
  disabled: boolean;
  variant: "empty" | "header" | "toolbar";
  onProject: (id: string) => void;
  onAgent: (id: string) => void;
  onEnvironment: (id: string) => void;
};

/** Context controls describe the selected session; run boxes open a separate SSH terminal. */
export function ChatProjectPicker(props: Props) {
  return (
    <div className={`chat-context chat-context-${props.variant}`}>
      <span className="context-chip context-project">
        <FolderSimple aria-hidden="true" />
        <Select
          aria-label="Project"
          value={props.projectId}
          disabled={props.disabled || !props.projects.length}
          onChange={(e) => props.onProject(e.target.value)}
        >
          <option value="">Choose project</option>
          {props.projects.map((item) => (
            <option value={item.value} key={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </span>
      <span className="context-chip context-agent">
        <Robot aria-hidden="true" />
        <Select
          aria-label="Agent"
          value={props.sessionId}
          disabled={props.disabled || !props.agents.length}
          onChange={(e) => props.onAgent(e.target.value)}
        >
          <option value="">Choose agent</option>
          {props.agents.map((item) => (
            <option value={item.value} key={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </span>
      <span
        className="context-chip context-environment"
        data-tone={props.environmentTone}
      >
        <HardDrives aria-hidden="true" />
        <Select
          aria-label="Environment"
          value={props.environmentValue}
          disabled={props.disabled || !props.environments.length}
          onChange={(e) => props.onEnvironment(e.target.value)}
        >
          <option value="">Choose environment</option>
          {props.environments.map((item) => (
            <option
              value={item.value}
              key={item.value}
              disabled={item.disabled}
            >
              <span className="context-environment-label">
                <span>{item.label}</span>
                {item.status && (
                  <span className="context-state">
                    <span className="context-status-dot" aria-hidden="true" />
                    {item.status}
                  </span>
                )}
              </span>
            </option>
          ))}
        </Select>
      </span>
    </div>
  );
}
