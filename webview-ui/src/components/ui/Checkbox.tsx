interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  className = "",
}: CheckboxProps) {
  return (
    <button
      onClick={onChange}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-none cursor-pointer text-left hover:bg-btn-bg ${className}`}
    >
      <span>{label}</span>
      <span
        className={`w-14 h-14 border-2 border-white/50 rounded-none shrink-0 flex items-center justify-center text-2xs pl-1.5 pb-4 leading-none text-white ${checked ? "bg-accent" : "bg-transparent"}`}
      >
        {checked ? "x" : ""}
      </span>
    </button>
  );
}
