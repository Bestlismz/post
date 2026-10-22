"use client";

import { ChevronDown } from "lucide-react";
import { forwardRef } from "react";

export const SelectControl = forwardRef(function SelectControl({ className = "", ...props }, ref) {
  return <span className={`rr-select-control${className ? ` ${className}` : ""}`}>
    <select ref={ref} {...props} />
    <ChevronDown aria-hidden="true" size={16} strokeWidth={2} />
  </span>;
});
