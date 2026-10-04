import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SettingsRow } from "../components/ui/settings-row";

type SettingsSelectProps<T extends string> = {
  label: string;
  value: T;
  /** Labels by value, listed in display order. */
  options: Record<T, string>;
  onChange: (value: T) => void;
  className?: string;
};

/**
 * Every Settings dropdown shares one trigger size and one popover contract:
 * `data-settings-control` is what gives the open list the Settings typography.
 */
export function SettingsSelect<T extends string>(props: SettingsSelectProps<T>) {
  return (
    <Select value={props.value} onValueChange={(value) => props.onChange(value as T)}>
      <SelectTrigger className={props.className} size="form" aria-label={props.label}><SelectValue /></SelectTrigger>
      <SelectContent data-settings-control="true" position="popper" align="end">
        {Object.entries<string>(props.options).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function SelectRow<T extends string>({ description, "data-setting": setting, ...select }: SettingsSelectProps<T> & {
  description?: string;
  /** What Settings search reveals this row by. */
  "data-setting"?: string;
}) {
  return (
    <SettingsRow label={select.label} description={description} data-setting={setting}>
      <SettingsSelect {...select} />
    </SettingsRow>
  );
}

export function SliderRow(props: {
  id: string;
  "data-setting"?: string;
  label: string;
  description: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <SettingsRow htmlFor={props.id} label={props.label} description={props.description} data-setting={props["data-setting"]}>
      <div className="settings-row-slider">
        <input
          id={props.id}
          type="range"
          min={props.min}
          max={props.max}
          step="1"
          value={props.value}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        <output htmlFor={props.id}>{props.value}{props.unit}</output>
      </div>
    </SettingsRow>
  );
}
