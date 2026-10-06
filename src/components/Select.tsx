"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
type Option = { value: string; label: string; description?: string };
export default function Select({ value, onChange, options, label, disabled = false, name }: { value: string; onChange: (value: string) => void; options: Option[]; label: string; disabled?: boolean; name?: string }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (index: number) => { onChange(options[index].value); setOpen(false); trigger.current?.focus(); };
  return <div className={`custom-select ${open ? "is-open" : ""}`} ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    {name && <input type="hidden" name={name} value={value} />}
    <button ref={trigger} type="button" className="text-input select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled} onClick={() => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(!open); }} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setOpen(false); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); setOpen(true); setActive(current => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : !open ? Math.max(0, options.findIndex(option => option.value === value)) : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (open) choose(active); else { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true); } }
      else if (event.key.length === 1) { const index = options.findIndex(option => option.label.toLowerCase().startsWith(event.key.toLowerCase())); if (index >= 0) { setActive(index); setOpen(true); } }
    }}><span>{selected?.label ?? "Choose an option"}</span><ChevronDown size={16} /></button>
    {open && <div className="select-options" id={`${id}-list`} role="listbox" aria-label={label}>{options.map((option, index) => <div role="option" aria-selected={option.value === value} id={`${id}-${index}`} key={option.value} className={`select-option ${index === active ? "is-highlighted" : ""}`} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={16} />}</div>)}</div>}
  </div>;
}
