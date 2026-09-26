"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ReactNode,
} from "react";
import "./select.css";

type Option = { value: string; label: ReactNode; disabled: boolean };
type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };
type SelectChange = { target: { value: string }; currentTarget: { value: string } };

type SelectProps = AriaAttributes & {
  children: ReactNode;
  className?: string;
  id?: string;
  name?: string;
  value?: string | number;
  defaultValue?: string | number;
  required?: boolean;
  disabled?: boolean;
  onChange?: (event: SelectChange) => void;
};

function collectOptions(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === Fragment) return collectOptions(child.props.children);
    if (child.type !== "option") return [];
    return [{
      value: String(child.props.value ?? child.props.children ?? ""),
      label: child.props.children,
      disabled: Boolean(child.props.disabled),
    }];
  });
}

/** A themed single select with native form values and Radix keyboard behavior. */
export function Select({
  children,
  className = "",
  id,
  name,
  value,
  defaultValue,
  required,
  disabled,
  onChange,
  ...aria
}: SelectProps) {
  const options = collectOptions(children);
  const initialValue = String(defaultValue ?? options.find((option) => !option.disabled)?.value ?? "");
  const [internalValue, setInternalValue] = useState(initialValue);
  const selectedValue = String(value ?? internalValue);
  const selected = options.find((option) => option.value === selectedValue);
  const emptyOption = options.find((option) => option.value === "");
  const [invalid, setInvalid] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const fieldRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId();
  // Radix reserves an empty item value for clearing. Keep native form values empty
  // while providing a selectable "No dependency" / "Unassigned" menu item.
  const emptyItemValue = `__empty-${instanceId}`;
  const errorId = `${instanceId}-error`;

  useEffect(() => {
    // A body portal would sit behind a native modal dialog's top layer.
    setPortalContainer(fieldRef.current?.closest("dialog") ?? undefined);
  }, []);

  useEffect(() => {
    const form = fieldRef.current?.closest("form");
    const reset = () => {
      if (value === undefined) setInternalValue(initialValue);
      setInvalid(false);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [initialValue, value]);

  function update(next: string) {
    const nextValue = next === emptyItemValue ? "" : next;
    if (nextValue === selectedValue) return;
    if (value === undefined) setInternalValue(nextValue);
    setInvalid(false);
    onChange?.({ target: { value: nextValue }, currentTarget: { value: nextValue } });
  }

  return (
    <span
      className="select-field"
      ref={fieldRef}
      onInvalid={(event) => {
        event.preventDefault();
        setInvalid(true);
        triggerRef.current?.focus();
      }}
    >
      <SelectPrimitive.Root
        name={name}
        value={selectedValue}
        onValueChange={update}
        disabled={disabled}
        required={required}
      >
        <SelectPrimitive.Trigger
          {...aria}
          ref={triggerRef}
          id={id}
          className={`select-trigger ${className}`.trim()}
          aria-invalid={invalid || aria["aria-invalid"] || undefined}
          aria-describedby={[aria["aria-describedby"], invalid ? errorId : undefined].filter(Boolean).join(" ") || undefined}
        >
          <span className="select-value">
            <SelectPrimitive.Value placeholder={emptyOption?.label ?? "Choose an option"}>
              {selected?.label}
            </SelectPrimitive.Value>
          </span>
          <SelectPrimitive.Icon className="select-chevron"><CaretDown aria-hidden="true" /></SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={portalContainer}>
          <SelectPrimitive.Content className="select-menu" position="popper" align="start">
            <SelectPrimitive.ScrollUpButton className="select-scroll"><CaretUp aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="select-viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value || emptyItemValue}
                  disabled={option.disabled}
                  className="select-option"
                  data-selected={option.value === selectedValue ? "true" : undefined}
                  aria-selected={option.value === selectedValue}
                >
                  <span className="select-indicator" aria-hidden="true">
                    {option.value === selectedValue && <Check />}
                  </span>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="select-scroll"><CaretDown aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {invalid && <span id={errorId} className="select-error" role="alert">Choose an option.</span>}
    </span>
  );
}
