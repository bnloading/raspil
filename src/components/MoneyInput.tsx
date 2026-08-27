export function MoneyInput({
  valueTiyn,
  onChange,
  className = "form-input",
  placeholder,
}: {
  valueTiyn: number;
  onChange: (tiyn: number) => void;
  className?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className={className}
      placeholder={placeholder}
      value={valueTiyn === 0 ? "" : valueTiyn / 100}
      min={0}
      onChange={(e) => onChange(Math.round((parseFloat(e.target.value) || 0) * 100))}
    />
  );
}
