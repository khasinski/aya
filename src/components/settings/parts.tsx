import type { ReactNode } from "react";

export function SettingsIcon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`aya-settings-material ${className}`}
      style={{ fontFamily: "Material Symbols Outlined" }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

export function SettingsHeader({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="aya-settings-header">
      <div className="aya-settings-header-icon">
        <SettingsIcon name={icon} />
      </div>
      <div>
        <div className="aya-modal-title">{title}</div>
        {children && <div className="aya-modal-hint">{children}</div>}
      </div>
    </div>
  );
}

export function SettingsRow({
  icon,
  title,
  children,
  control,
  labelFor,
}: {
  icon: string;
  title: ReactNode;
  children?: ReactNode;
  control: ReactNode;
  labelFor?: string;
}) {
  return (
    <div className="aya-settings-general-row">
      <div className="aya-settings-general-copy">
        <div className="aya-settings-row-icon">
          <SettingsIcon name={icon} />
        </div>
        <div>
          {labelFor ? (
            <label className="aya-settings-general-title" htmlFor={labelFor}>
              {title}
            </label>
          ) : (
            <div className="aya-settings-general-title">{title}</div>
          )}
          {children && <div className="aya-modal-hint">{children}</div>}
        </div>
      </div>
      <div className="aya-settings-control">{control}</div>
    </div>
  );
}

/** A row of buttons, one per option, where the button of the current value is active. */
export function Segmented<T extends string | boolean>({
  label,
  options,
  value,
  onChange,
  disabled,
  buttonTestId,
}: {
  /** The group's aria-label. */
  label: string;
  /** Each option's value and button text, in display order. */
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  /** All buttons, or, as a function, the buttons of the options it returns true for. */
  disabled?: boolean | ((option: T) => boolean);
  buttonTestId?: string;
}) {
  return (
    <div className="aya-settings-segmented" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={String(option)}
          data-testid={buttonTestId}
          type="button"
          disabled={typeof disabled === "function" ? disabled(option) : disabled}
          className={`aya-settings-segment ${
            value === option ? "aya-settings-segment--active" : ""
          }`}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const ON_OFF_OPTIONS = [
  [true, "On"],
  [false, "Off"],
] as const;

/** The On/Off switch of a boolean setting. */
export function OnOffSwitch({
  label,
  value,
  onChange,
  disabled,
}: {
  /** The switch's aria-label. */
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  /** Both buttons, or, as a function, the button whose value it returns true for. */
  disabled?: boolean | ((value: boolean) => boolean);
}) {
  return (
    <Segmented<boolean>
      label={label}
      options={ON_OFF_OPTIONS}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
