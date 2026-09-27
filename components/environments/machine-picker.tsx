"use client";
import type { ReactNode } from "react";
import { Cpu, Cube, GraphicsCard, Laptop } from "@phosphor-icons/react";
import {
  MACHINE_QUOTED_AT,
  diskOptionsGib,
  estimateHourlyUsd,
  machines,
  minDiskGib,
  type Machine,
} from "@/lib/machine-catalog.mjs";
import { demoGpuDurations, localDockerSandboxProfile } from "@/lib/resource-profiles";
import { gpuText, usd, type ContainerTemplate } from "./machines";

export type PickerMode = "cpu" | "gpu" | "local";

export type PickerValue = {
  mode: PickerMode;
  /** Chosen catalog machine per kind, so switching CPU/GPU restores the last size. */
  sizes: { cpu: string; gpu: string };
  localProfileId: string;
  diskGib: number;
  durationHours: number;
};

export const initialPickerValue: PickerValue = {
  mode: "cpu",
  sizes: {
    cpu: machines.find((machine) => machine.kind === "cpu")!.id,
    gpu: machines.find((machine) => machine.kind === "gpu")!.id,
  },
  localProfileId: localDockerSandboxProfile.id,
  diskGib: diskOptionsGib[0],
  durationHours: demoGpuDurations[0],
};

/** Disk sizes allowed for a machine (the catalog minimum filters smaller volumes). */
export function diskChoices(machine: Machine) {
  return diskOptionsGib.filter((gib) => gib >= minDiskGib(machine));
}

/** The chosen disk if this machine allows it, otherwise the machine's minimum. */
export function effectiveDisk(machine: Machine, diskGib: number) {
  const choices = diskChoices(machine);
  return choices.includes(diskGib) ? diskGib : choices[0];
}

export function pickerMachine(value: PickerValue): Machine | null {
  const mode = value.mode;
  if (mode === "local") return null;
  return machines.find((machine) => machine.id === value.sizes[mode]) ?? null;
}

/** What POST /api/run-boxes receives for this selection. */
export function pickerRequest(value: PickerValue) {
  const machine = pickerMachine(value);
  if (!machine) return { profileId: value.localProfileId, durationHours: value.durationHours };
  return { profileId: machine.id, durationHours: value.durationHours, diskGb: effectiveDisk(machine, value.diskGib) };
}

const modes: { id: PickerMode; label: string; hint: string; icon: ReactNode }[] = [
  { id: "cpu", label: "CPU", hint: "AWS", icon: <Cpu aria-hidden="true" /> },
  { id: "gpu", label: "GPU", hint: "AWS", icon: <GraphicsCard aria-hidden="true" /> },
  { id: "local", label: "Local", hint: "free", icon: <Laptop aria-hidden="true" /> },
];

export function MachinePicker({
  value,
  onChange,
  templates,
}: {
  value: PickerValue;
  onChange: (value: PickerValue) => void;
  templates: ContainerTemplate[];
}) {
  const machine = pickerMachine(value);
  const disk = machine ? effectiveDisk(machine, value.diskGib) : null;
  const hourly = machine && disk !== null ? estimateHourlyUsd(machine, disk) : 0;
  const localOptions = [
    {
      id: localDockerSandboxProfile.id,
      label: "Local Docker sandbox",
      summary: "CPU-only Linux container on the machine running the alto worker. No GPU. No provider cost.",
    },
    ...templates.map((template) => ({
      id: `local-template:${template.id}`,
      label: template.label,
      summary: `Imported container template · image ${template.imageId.slice(0, 19)}… · CPU only · no provider cost`,
    })),
  ];
  const set = (patch: Partial<PickerValue>) => onChange({ ...value, ...patch });

  return (
    <>
      <fieldset className="environment-segment-field">
        <legend>Machine</legend>
        <div className="environment-segment">
          {modes.map((mode) => (
            <label key={mode.id} className={`environment-segment-option${value.mode === mode.id ? " chosen" : ""}`}>
              <input
                className="visually-hidden"
                type="radio"
                name="environment-mode"
                value={mode.id}
                checked={value.mode === mode.id}
                onChange={() => set({ mode: mode.id })}
              />
              {mode.icon}
              <span>{mode.label}</span>
              <small>{mode.hint}</small>
            </label>
          ))}
        </div>
      </fieldset>

      {machine ? (
        <>
          <fieldset>
            <legend>Size</legend>
            <div className="machine-grid">
              {machines
                .filter((item) => item.kind === machine.kind)
                .map((item) => {
                  const chosen = item.id === machine.id;
                  return (
                    <label key={item.id} className={`machine-card${chosen ? " chosen" : ""}`}>
                      <input
                        type="radio"
                        name="environment-machine"
                        value={item.id}
                        checked={chosen}
                        onChange={() => set({ sizes: { ...value.sizes, [item.kind]: item.id } })}
                      />
                      <span className="machine-card-body">
                        <span className="machine-card-head">
                          <strong>{item.size}</strong>
                          <span className="machine-card-price">
                            ~{usd(estimateHourlyUsd(item, effectiveDisk(item, value.diskGib)))}/h
                          </span>
                        </span>
                        <span>{item.vcpu} vCPU · {item.memoryGib} GiB RAM</span>
                        <span>{item.gpu ? gpuText(item.gpu) : "No GPU"}</span>
                        <code>{item.instanceType}</code>
                      </span>
                    </label>
                  );
                })}
            </div>
          </fieldset>

          <fieldset>
            <legend>Disk</legend>
            <div className="environment-duration-row">
              {diskChoices(machine).map((gib) => (
                <label key={gib} className={`compute-option environment-duration${disk === gib ? " chosen" : ""}`}>
                  <input
                    type="radio"
                    name="environment-disk"
                    value={gib}
                    checked={disk === gib}
                    onChange={() => set({ diskGib: gib })}
                  />
                  <strong>{gib} GiB</strong>
                </label>
              ))}
            </div>
            <small className="environment-hint">
              gp3 volume, deleted when the environment stops.
              {machine.kind === "gpu" ? ` GPU sizes need at least ${minDiskGib(machine)} GiB for the NVIDIA drivers.` : ""}
            </small>
          </fieldset>
        </>
      ) : (
        <fieldset className="environment-options">
          <legend>Container</legend>
          {localOptions.map((option) => (
            <label
              key={option.id}
              className={`compute-option environment-option${value.localProfileId === option.id ? " chosen" : ""}`}
            >
              <input
                type="radio"
                name="environment-local"
                value={option.id}
                checked={value.localProfileId === option.id}
                onChange={() => set({ localProfileId: option.id })}
              />
              <Cube aria-hidden="true" />
              <span>
                <strong>{option.label}</strong>
                <small>{option.summary}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="environment-durations">
        <legend>Duration</legend>
        <div className="environment-duration-row">
          {demoGpuDurations.map((hours) => (
            <label
              key={hours}
              className={`compute-option environment-duration${value.durationHours === hours ? " chosen" : ""}`}
            >
              <input
                type="radio"
                name="environment-duration"
                value={hours}
                checked={value.durationHours === hours}
                onChange={() => set({ durationHours: hours })}
              />
              <strong>
                {hours} {hours === 1 ? "hour" : "hours"}
              </strong>
            </label>
          ))}
        </div>
        <small className="environment-hint">
          The worker stops the environment at this limit, counted from the request.
        </small>
      </fieldset>

      <div className="environment-estimate" aria-live="polite">
        {machine && disk !== null ? (
          <>
            <p className="environment-estimate-total">
              <span>Estimated total</span>
              <strong>
                ~{usd(hourly * value.durationHours)} for {value.durationHours}{" "}
                {value.durationHours === 1 ? "hour" : "hours"}
              </strong>
            </p>
            <p className="resource-note">
              Estimate only: {usd(hourly)}/h for {machine.instanceType} compute, a public IPv4 address, and {disk} GiB of
              gp3 disk at AWS on-demand prices (us-east-1) quoted {MACHINE_QUOTED_AT}. The worker re-prices before
              launch and refuses a price above this size&apos;s ceiling. Only one AWS environment can be active at a
              time; stop the current one before starting another.
            </p>
          </>
        ) : (
          <>
            <p className="environment-estimate-total">
              <span>Estimated total</span>
              <strong>No provider cost</strong>
            </p>
            <p className="resource-note">
              Runs on the machine hosting the alto worker, for development and demos. SSH gives trusted shell
              access; it is not a filesystem or command sandbox.
            </p>
          </>
        )}
      </div>
    </>
  );
}
