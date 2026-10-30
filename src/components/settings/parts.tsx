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
